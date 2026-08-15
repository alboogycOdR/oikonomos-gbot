/**
 * Redaction middleware — strips secret-shaped values out of audit payloads
 * before they reach `insertAuditEvent` (WBS OIK-026: "Secret patterns
 * stripped pre-write").
 *
 * Pattern families intentionally mirror `hooks/lib.js`'s `SECRET_PATTERNS`
 * (the DEVDEPARTMENT PreToolUse hook) and `infra/ci/secret-scan.mjs`'s
 * `secretPatterns()` (the CI/pre-commit scanner), so all three layers agree
 * on what a secret looks like. Like `infra/ci/secret-scan.mjs`, every
 * pattern fragment below is assembled from string pieces rather than
 * written as one contiguous credential-shaped literal, so this source file
 * itself never contains anything that looks like a real secret (N4).
 */

interface SecretPattern {
  readonly name: string;
  readonly re: RegExp;
}

function buildSecretPatterns(): SecretPattern[] {
  const openAi = ["sk", "-[A-Za-z0-9_-]{16,}"].join("");
  const github = ["gh", "[pousr]_[A-Za-z0-9]{20,}"].join("");
  const aws = ["AKIA", "[0-9A-Z]{16}"].join("");
  const google = ["AIza", "[0-9A-Za-z_-]{30,}"].join("");
  const slack = ["xox", "[baprs]-[A-Za-z0-9-]{10,}"].join("");
  const pem = ["-----BEGIN ", "(?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----"].join("");
  const telegram = ["\\d{8,10}:", "AA[A-Za-z0-9_-]{30,}"].join("");
  const genericAssigned = [
    "(?:password|passwd|secret|api[_-]?key|auth[_-]?token)",
    "\\s*[:=]\\s*['\"][^'\"\\s]{12,}['\"]",
  ].join("");

  return [
    { name: "openai-anthropic-style-api-key", re: new RegExp(String.raw`\b${openAi}\b`) },
    { name: "github-token", re: new RegExp(String.raw`\b${github}\b`) },
    { name: "aws-access-key-id", re: new RegExp(String.raw`\b${aws}\b`) },
    { name: "google-api-key", re: new RegExp(String.raw`\b${google}\b`) },
    { name: "slack-token", re: new RegExp(String.raw`\b${slack}\b`) },
    { name: "private-key-block", re: new RegExp(pem) },
    { name: "telegram-bot-token", re: new RegExp(String.raw`\b${telegram}\b`) },
    { name: "generic-assigned-secret", re: new RegExp(genericAssigned, "i") },
  ];
}

const SECRET_PATTERNS = buildSecretPatterns();

/** Value written in place of a string that matched any secret pattern. */
export const REDACTED_MARKER = "[REDACTED]";

/** True if `text` matches at least one known secret pattern family. */
export function matchesSecretPattern(text: string): boolean {
  return SECRET_PATTERNS.some(({ re }) => re.test(text));
}

/**
 * Recursively walks a value, replacing any string that matches a known
 * secret pattern with {@link REDACTED_MARKER}. Objects and arrays are
 * walked at every depth — a secret nested inside a nested object or array
 * is stripped exactly like a top-level one (WBS OIK-026: not bypassable by
 * nesting). `Date` instances are passed through unchanged rather than
 * decomposed into their (empty) own-enumerable-property object shape.
 */
function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return matchesSecretPattern(value) ? REDACTED_MARKER : value;
  }
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (value instanceof Date) {
    return value;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = redactValue(nested);
    }
    return out;
  }
  return value;
}

/**
 * Redacts an audit event payload in place of writing it. Returns a new
 * object — the input is never mutated, so a caller holding a reference to
 * the original payload does not see it silently change out from under it.
 */
export function redactPayload(
  payload: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (payload === undefined) {
    return undefined;
  }
  return redactValue(payload) as Record<string, unknown>;
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  // Fixture corpus. Every value is fragment-assembled the same way as the
  // patterns above and carries an obvious PLACEHOLDER/EXAMPLE/FAKE marker —
  // never a copy of hooks/secret-scan.js's realistic-looking exempt corpus
  // (that file is scanner-exempt precisely because its fixtures look real;
  // these must not).
  const fakeApiKey = ["sk", "PLACEHOLDER_FAKE_NOT_A_REAL_SECRET_KEY"].join("-");
  const fakeAwsAccessKeyId = ["AKIA", "EXAMPLEFAKEKEY01"].join("");
  const fakePrivateKeyBlock = [
    ["-----BEGIN ", "RSA PRIVATE KEY-----"].join(""),
    "PLACEHOLDER-FAKE-KEY-MATERIAL-NOT-REAL-BASE64==",
    ["-----END ", "RSA PRIVATE KEY-----"].join(""),
  ].join("\n");
  const fakeGithubToken = ["gh", "p_PLACEHOLDEREXAMPLEFAKETOKEN0000"].join("");
  const fakeGenericSecret = ["api", "_key"].join("") + ": \"PLACEHOLDER_FAKE_VALUE_1234\"";

  describe("matchesSecretPattern — fixture corpus", () => {
    it("matches an API-key-shaped placeholder", () => {
      expect(matchesSecretPattern(fakeApiKey)).toBe(true);
    });

    it("matches an AWS-access-key-ID-shaped placeholder", () => {
      expect(matchesSecretPattern(fakeAwsAccessKeyId)).toBe(true);
    });

    it("matches a private-key-block-shaped placeholder", () => {
      expect(matchesSecretPattern(fakePrivateKeyBlock)).toBe(true);
    });

    it("matches a GitHub-token-shaped placeholder", () => {
      expect(matchesSecretPattern(fakeGithubToken)).toBe(true);
    });

    it("matches a generic key=value-shaped placeholder", () => {
      expect(matchesSecretPattern(fakeGenericSecret)).toBe(true);
    });

    it("does not match ordinary, non-secret-shaped text", () => {
      expect(matchesSecretPattern("hello world")).toBe(false);
      expect(matchesSecretPattern("finance@basileia.example")).toBe(false);
      expect(matchesSecretPattern("11111111-1111-1111-1111-111111111111")).toBe(false);
    });
  });

  describe("redactPayload", () => {
    it("replaces a top-level secret-shaped field with the redaction marker", () => {
      const redacted = redactPayload({ apiKey: fakeApiKey, note: "fine" });
      expect(redacted).toEqual({ apiKey: REDACTED_MARKER, note: "fine" });
    });

    it("strips a secret nested inside an object several levels deep", () => {
      const redacted = redactPayload({
        request: {
          headers: {
            authorization: fakeApiKey,
          },
        },
      });
      expect(redacted).toEqual({
        request: { headers: { authorization: REDACTED_MARKER } },
      });
    });

    it("strips a secret nested inside an array, including an array of objects", () => {
      const redacted = redactPayload({
        events: [
          { message: "ok" },
          { message: fakeAwsAccessKeyId },
          [fakePrivateKeyBlock, "ok"],
        ],
      });
      expect(redacted).toEqual({
        events: [{ message: "ok" }, { message: REDACTED_MARKER }, [REDACTED_MARKER, "ok"]],
      });
    });

    it("strips every family in the fixture corpus when present together", () => {
      const redacted = redactPayload({
        a: fakeApiKey,
        b: fakeAwsAccessKeyId,
        c: fakePrivateKeyBlock,
        d: fakeGithubToken,
        e: fakeGenericSecret,
      });
      expect(redacted).toEqual({
        a: REDACTED_MARKER,
        b: REDACTED_MARKER,
        c: REDACTED_MARKER,
        d: REDACTED_MARKER,
        e: REDACTED_MARKER,
      });
    });

    it("leaves non-secret-shaped values — including numbers, booleans, null, and Date — unchanged", () => {
      const at = new Date("2026-01-01T00:00:00.000Z");
      const redacted = redactPayload({
        count: 3,
        enabled: true,
        missing: null,
        at,
        note: "nothing sensitive here",
      });
      expect(redacted).toEqual({
        count: 3,
        enabled: true,
        missing: null,
        at,
        note: "nothing sensitive here",
      });
      expect((redacted as { at: Date }).at).toBeInstanceOf(Date);
    });

    it("returns undefined unchanged rather than manufacturing an empty object", () => {
      expect(redactPayload(undefined)).toBeUndefined();
    });

    it("does not mutate the input payload", () => {
      const original = { apiKey: fakeApiKey };
      const redacted = redactPayload(original);
      expect(original.apiKey).toBe(fakeApiKey);
      expect(redacted).not.toBe(original);
    });
  });
}
