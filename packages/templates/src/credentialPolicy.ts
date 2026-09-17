import { redactPayload } from "@oikonomos/audit";

import type { TemplateManifest } from "./manifest.js";

/**
 * The template credential policy — ADR-018 §2 (as amended by the CX9
 * adversarial review), specs/OIKONOMOS_TEMPLATES_v1.0.md §3.2. Five
 * detector classes, strictly wider than the plain audit matcher (change 1
 * of the review). A match REFUSES export/install; this module never
 * redacts (spec §3.2: "Any match refuses the export").
 */
export type CredentialPolicyClass =
  | "audit_pattern_family"
  | "jwt_shape"
  | "credential_url"
  | "high_entropy_blob"
  | "secret_ref";

/** Result of scanning a manifest: never redacts, only reports. */
export interface CredentialScanResult {
  readonly refused: boolean;
  /** JSON-pointer paths of every field implicated in a match, sorted, deduped. */
  readonly fieldPaths: readonly string[];
  /** Every policy class that matched anywhere in the manifest, sorted, deduped. */
  readonly classes: readonly CredentialPolicyClass[];
}

const CREDENTIAL_QUERY_KEY_RE =
  /^(token|access_token|id_token|key|api[_-]?key|secret|password|pwd|sig|signature|auth|authorization|credential|session)$/i;

/** Runs of characters drawn from the base64 / base64url / hex alphabets, len >= 32. */
const OPAQUE_TOKEN_RE = /[A-Za-z0-9+/=_-]{32,}/g;

const HIGH_ENTROPY_BITS_PER_CHAR = 4.0;

/**
 * Class 1: the eight audit pattern families, reused rather than copied.
 * `matchesSecretPattern` itself is not part of `@oikonomos/audit`'s public
 * surface (only `redactPayload` is re-exported from its `index.ts`), and
 * `packages/audit` is outside this task's `Owned_Paths` — adding an export
 * there is not this task's edit to make. `redactPayload`'s documented
 * contract ("replace a string in place with the redaction marker if it
 * matches any known secret pattern family") already gives the same
 * true/false signal `matchesSecretPattern` would when probed with a
 * single-field payload, so this reuses the real matcher through its one
 * public entry point instead of re-declaring any of its eight regexes here.
 */
function matchesAuditPatternFamily(text: string): boolean {
  const probe = redactPayload({ value: text }) as { value: unknown };
  return probe.value !== text;
}

/**
 * A candidate JWT embedded anywhere in free-flowing prose: three
 * dot-separated base64url segments. `text` is a whole manifest field (e.g.
 * "the token is eyJ...XXX.YYY.ZZZ, keep it safe"), not just the token
 * itself, so this looks for the shape as a SUBSTRING rather than requiring
 * the entire field to be nothing but the token.
 */
const JWT_CANDIDATE_RE = /[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;

/** Class 2: JWT shape — three base64url segments, first decodes to a JSON object with `alg`/`typ`. */
function isJwtShape(text: string): boolean {
  const candidates = text.match(JWT_CANDIDATE_RE);
  if (candidates === null) {
    return false;
  }
  return candidates.some((candidate) => {
    const header = candidate.split(".")[0]!;
    try {
      const headerJson = Buffer.from(header, "base64url").toString("utf8");
      const parsed: unknown = JSON.parse(headerJson);
      return (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed) &&
        ("alg" in (parsed as Record<string, unknown>) || "typ" in (parsed as Record<string, unknown>))
      );
    } catch {
      return false;
    }
  });
}

/**
 * A candidate URL embedded anywhere in free-flowing prose. `text` is a
 * whole manifest field ("See https://user:pass@host/path for details"),
 * not just the URL itself, so this extracts URL-shaped substrings before
 * handing each to the `URL` constructor rather than parsing the whole
 * field (which would fail on the surrounding prose and silently report no
 * match at all).
 */
const URL_CANDIDATE_RE = /\bhttps?:\/\/\S+/gi;

/** Class 3: a URL with userinfo, or a credential-bearing query/fragment key. */
function isCredentialUrl(text: string): boolean {
  const candidates = text.match(URL_CANDIDATE_RE);
  if (candidates === null) {
    return false;
  }
  return candidates.some((candidate) => {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      return false;
    }
    if (url.username !== "" || url.password !== "") {
      return true;
    }
    for (const key of url.searchParams.keys()) {
      if (CREDENTIAL_QUERY_KEY_RE.test(key)) {
        return true;
      }
    }
    if (url.hash.length > 1) {
      const fragmentParams = new URLSearchParams(url.hash.slice(1));
      for (const key of fragmentParams.keys()) {
        if (CREDENTIAL_QUERY_KEY_RE.test(key)) {
          return true;
        }
      }
    }
    return false;
  });
}

function shannonEntropyBitsPerChar(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** Class 4: an opaque, high-entropy blob of >=32 base64/base64url/hex characters. */
function hasHighEntropyBlob(text: string, allowlist: ReadonlySet<string>): boolean {
  const candidates = text.match(OPAQUE_TOKEN_RE);
  if (candidates === null) {
    return false;
  }
  return candidates.some(
    (candidate) =>
      !allowlist.has(candidate) && shannonEntropyBitsPerChar(candidate) > HIGH_ENTROPY_BITS_PER_CHAR,
  );
}

/** Class 5: any `secret://` reference. */
function hasSecretRef(text: string): boolean {
  return text.includes("secret://");
}

/** Runs every detector class against one string; returns the classes that matched. */
function classesMatching(text: string, allowlist: ReadonlySet<string>): CredentialPolicyClass[] {
  const classes: CredentialPolicyClass[] = [];
  if (matchesAuditPatternFamily(text)) classes.push("audit_pattern_family");
  if (isJwtShape(text)) classes.push("jwt_shape");
  if (isCredentialUrl(text)) classes.push("credential_url");
  if (hasHighEntropyBlob(text, allowlist)) classes.push("high_entropy_blob");
  if (hasSecretRef(text)) classes.push("secret_ref");
  return classes;
}

interface PathValue {
  readonly path: string;
  readonly value: string;
}

/** Recursively walks every string in a JSON-safe value, yielding its JSON-pointer path. */
function walkStrings(value: unknown, path: string, out: PathValue[]): void {
  if (typeof value === "string") {
    out.push({ path, value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((element, index) => walkStrings(element, `${path}/${index}`, out));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      walkStrings(nested, `${path}/${key}`, out);
    }
  }
}

/**
 * The manifest's own structural identifiers (spec §3.2: "skill names,
 * capability ids, cron strings"), which are exempt from the high-entropy
 * blob class only — they are short or low-entropy by construction, and a
 * template cannot avoid restating them verbatim.
 */
function structuralIdentifierAllowlist(manifest: TemplateManifest): ReadonlySet<string> {
  const allowlist = new Set<string>();
  for (const skill of manifest.skills) allowlist.add(skill.name);
  for (const integration of manifest.integrations) allowlist.add(integration.capability_id);
  for (const routine of manifest.routines) {
    if (routine.schedule !== null) allowlist.add(routine.schedule);
  }
  return allowlist;
}

/**
 * The bounded, enumerated free-prose surface (spec §3.2): exactly
 * `identity.description`, `identity.instructions`, skill
 * `body`/`description`/`when_to_use`, routine `definition`, memory
 * `value`. Returned in canonical field order so the adjacent-field join
 * below is deterministic and matches the spec's own ordering.
 */
function freeProseFields(manifest: TemplateManifest): PathValue[] {
  const fields: PathValue[] = [
    { path: "/identity/description", value: manifest.identity.description },
  ];
  if (manifest.identity.instructions !== null) {
    fields.push({ path: "/identity/instructions", value: manifest.identity.instructions });
  }
  manifest.skills.forEach((skill, index) => {
    fields.push({ path: `/skills/${index}/body`, value: skill.body });
    fields.push({ path: `/skills/${index}/description`, value: skill.description });
    if (skill.when_to_use !== null) {
      fields.push({ path: `/skills/${index}/when_to_use`, value: skill.when_to_use });
    }
  });
  manifest.routines.forEach((routine, index) => {
    fields.push({
      path: `/routines/${index}/definition`,
      value: JSON.stringify(routine.definition),
    });
  });
  manifest.memories.forEach((memory, index) => {
    fields.push({ path: `/memories/${index}/value`, value: memory.value });
  });
  return fields;
}

/**
 * The join uses direct concatenation (the empty string) rather than a
 * printable separator such as "\n". A printable separator character is not
 * itself part of any of the five detector alphabets (base64/base64url/hex,
 * a JWT's `[A-Za-z0-9_-]`, an unbroken pattern-family regex run), so
 * inserting one between two fields would break exactly the contiguous
 * character run this scan exists to catch -- the credential-split case the
 * ADR names ("a creator pasted a key across two adjacent prose fields")
 * only reads as one contiguous token when the two halves are concatenated
 * with nothing between them. Genuine prose in an intervening field (see the
 * non-adjacent test below) already breaks contiguity on its own, without
 * needing a synthetic separator to do it.
 */
const ADJACENT_FIELD_SEPARATOR = "";

/**
 * Scans a manifest for anything credential-shaped. Every string is checked
 * individually (recursively, arrays and nested objects); additionally the
 * bounded free-prose surface is joined, in canonical field order, and
 * scanned again, so a credential split across two ADJACENT prose fields is
 * still caught (spec §3.2's stated threat model — a split across
 * non-adjacent fields, with real content in between, is explicitly out of
 * scope: "a creator exfiltrating their own key through their own template
 * ... no scanner can distinguish from prose").
 */
export function scanManifestForCredentials(manifest: TemplateManifest): CredentialScanResult {
  const allowlist = structuralIdentifierAllowlist(manifest);
  const fieldPaths = new Set<string>();
  const classes = new Set<CredentialPolicyClass>();

  const allStrings: PathValue[] = [];
  walkStrings(manifest, "", allStrings);
  for (const { path, value } of allStrings) {
    for (const cls of classesMatching(value, allowlist)) {
      fieldPaths.add(path);
      classes.add(cls);
    }
  }

  const proseFields = freeProseFields(manifest);
  const joined = proseFields.map((field) => field.value).join(ADJACENT_FIELD_SEPARATOR);
  const joinedClasses = classesMatching(joined, allowlist);
  if (joinedClasses.length > 0) {
    for (const field of proseFields) fieldPaths.add(field.path);
    for (const cls of joinedClasses) classes.add(cls);
  }

  return {
    refused: fieldPaths.size > 0,
    fieldPaths: Array.from(fieldPaths).sort(),
    classes: Array.from(classes).sort(),
  };
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  function baseManifest(overrides: Partial<TemplateManifest> = {}): TemplateManifest {
    return {
      template_version: 1,
      identity: {
        name: "support-bot",
        title: "Support Bot",
        description: "Handles support tickets.",
        instructions: "Be courteous.",
        provider: null,
        model: null,
      },
      skills: [],
      routines: [],
      integrations: [],
      memories: [],
      provenance: {
        exported_at: "2026-09-17T00:00:00.000Z",
        exported_from_tenant_digest: "digest-abc",
        oikonomos_version: "0.0.0",
      },
      ...overrides,
    };
  }

  // Fragment-assembled fixtures throughout — no test-file literal is
  // key-shaped end to end (matches packages/audit/src/redact.ts's own
  // fixture technique).
  const fakeOpenAiKey = ["sk", "PLACEHOLDER_FAKE_NOT_A_REAL_SECRET_KEY_0000"].join("-");

  describe("scanManifestForCredentials", () => {
    it("passes a manifest with no credential-shaped content", () => {
      const result = scanManifestForCredentials(baseManifest());
      expect(result.refused).toBe(false);
      expect(result.fieldPaths).toEqual([]);
      expect(result.classes).toEqual([]);
    });

    it("class 1 -- refuses on an audit pattern family match (reused matcher, not copied)", () => {
      const manifest = baseManifest({
        identity: {
          name: "support-bot",
          title: "Support Bot",
          description: `Uses key ${fakeOpenAiKey} for lookups.`,
          instructions: null,
          provider: null,
          model: null,
        },
      });
      const result = scanManifestForCredentials(manifest);
      expect(result.refused).toBe(true);
      expect(result.classes).toContain("audit_pattern_family");
      expect(result.fieldPaths).toContain("/identity/description");
    });

    it("class 2 -- refuses on a JWT-shaped string", () => {
      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({ sub: "1234567890" })).toString("base64url");
      const fakeJwt = [header, payload, "PLACEHOLDER_FAKE_SIGNATURE_NOT_REAL"].join(".");
      const manifest = baseManifest({
        skills: [
          {
            name: "auth-helper",
            version: 1,
            description: "d",
            when_to_use: null,
            body: `token: ${fakeJwt}`,
            inputs: [],
            access: [],
            approvals: [],
            failure_policy: {},
          },
        ],
      });
      const result = scanManifestForCredentials(manifest);
      expect(result.refused).toBe(true);
      expect(result.classes).toContain("jwt_shape");
      expect(result.fieldPaths).toContain("/skills/0/body");
    });

    it("class 3 -- refuses on a URL with userinfo", () => {
      const manifest = baseManifest({
        identity: {
          name: "support-bot",
          title: "Support Bot",
          description: "See https://user:PLACEHOLDER_FAKE_PASSWORD@example.com/api",
          instructions: null,
          provider: null,
          model: null,
        },
      });
      const result = scanManifestForCredentials(manifest);
      expect(result.refused).toBe(true);
      expect(result.classes).toContain("credential_url");
    });

    it("class 3 -- refuses on a URL with a credential-bearing query key", () => {
      const manifest = baseManifest({
        identity: {
          name: "support-bot",
          title: "Support Bot",
          description: "See https://example.com/api?api_key=PLACEHOLDER_FAKE_VALUE_0000",
          instructions: null,
          provider: null,
          model: null,
        },
      });
      const result = scanManifestForCredentials(manifest);
      expect(result.refused).toBe(true);
      expect(result.classes).toContain("credential_url");
    });

    it("class 4 -- refuses on a high-entropy opaque blob, but not on a low-entropy long run", () => {
      const highEntropy = "aZ3kQ9mN2xP7vR4tW8yU1bC6dF0gH5jL9nQ2sV7wX4z";
      const manifestHigh = baseManifest({
        identity: {
          name: "support-bot",
          title: "Support Bot",
          description: `Blob: ${highEntropy}`,
          instructions: null,
          provider: null,
          model: null,
        },
      });
      expect(scanManifestForCredentials(manifestHigh).classes).toContain("high_entropy_blob");

      const lowEntropy = "a".repeat(40);
      const manifestLow = baseManifest({
        identity: {
          name: "support-bot",
          title: "Support Bot",
          description: `Blob: ${lowEntropy}`,
          instructions: null,
          provider: null,
          model: null,
        },
      });
      expect(scanManifestForCredentials(manifestLow).refused).toBe(false);
    });

    it("class 4 -- does not refuse when the high-entropy-shaped token is itself a structural identifier", () => {
      const capabilityId = "aZ3kQ9mN2xP7vR4tW8yU1bC6dF0gH5jL9nQ2sV7wX4z";
      const manifest = baseManifest({
        integrations: [{ capability_id: capabilityId, requested_max_tier: "T1_draft" }],
      });
      const result = scanManifestForCredentials(manifest);
      expect(result.classes).not.toContain("high_entropy_blob");
    });

    it("class 5 -- refuses on any secret:// reference", () => {
      const manifest = baseManifest({
        identity: {
          name: "support-bot",
          title: "Support Bot",
          description: "Reads secret://vault/api-key at runtime.",
          instructions: null,
          provider: null,
          model: null,
        },
      });
      const result = scanManifestForCredentials(manifest);
      expect(result.refused).toBe(true);
      expect(result.classes).toContain("secret_ref");
    });

    it("catches a credential split across two adjacent prose fields", () => {
      // The split lands exactly on the field boundary -- description ends
      // with the first half, instructions begins with the second, with no
      // other characters in either field -- so the adjacent join
      // reconstructs the original key exactly (see ADJACENT_FIELD_SEPARATOR
      // above for why the join uses no separator character).
      const half1 = fakeOpenAiKey.slice(0, 10);
      const half2 = fakeOpenAiKey.slice(10);
      const manifest = baseManifest({
        identity: {
          name: "support-bot",
          title: "Support Bot",
          description: half1,
          instructions: half2,
          provider: null,
          model: null,
        },
      });
      // Neither field alone is a match...
      expect(matchesFieldAlone(manifest.identity.description)).toBe(false);
      expect(matchesFieldAlone(manifest.identity.instructions!)).toBe(false);
      // ...but the adjacent join is.
      const result = scanManifestForCredentials(manifest);
      expect(result.refused).toBe(true);
      expect(result.fieldPaths).toContain("/identity/description");
      expect(result.fieldPaths).toContain("/identity/instructions");
    });

    function matchesFieldAlone(text: string): boolean {
      return classesMatching(text, new Set()).length > 0;
    }

    it("does not treat a credential split across NON-adjacent fields as a match (stated threat model)", () => {
      const half1 = fakeOpenAiKey.slice(0, 10);
      const half2 = fakeOpenAiKey.slice(10);
      const manifest = baseManifest({
        identity: {
          name: "support-bot",
          title: "Support Bot",
          description: `Key part one: ${half1}`,
          // A genuinely intervening free-prose field sits between the two
          // halves in canonical join order, so they are never adjacent in
          // the joined blob -- unlike the adjacent-pair test above, where
          // nothing sits between description and instructions. Leading and
          // trailing spaces are deliberate: they break token contiguity at
          // both boundaries the same way ordinary prose punctuation would
          // in a real bot's instructions, so this test isolates "is a
          // real, unrelated field in between" from the unrelated
          // characteristic of exactly which characters happen to sit at a
          // field boundary.
          instructions: " Unrelated filler text about tone and style ",
          provider: null,
          model: null,
        },
        memories: [{ key: "note", value: `Key part two: ${half2}`, scope: "agent", tier: "profile" }],
      });
      const result = scanManifestForCredentials(manifest);
      expect(result.refused).toBe(false);
    });
  });
}
