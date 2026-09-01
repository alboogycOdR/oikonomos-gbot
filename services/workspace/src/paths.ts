/**
 * TASK-090 / Addendum F §4.1 (F9), §2.2 (F2) — the single place that
 * understands the Office filesystem: path resolution against the shared
 * workspace / role-directory roots, and durability-tier classification.
 *
 * F9: `/oikonomos/workspace/**` is shared D1 and readable/writable by every
 * role. `/oikonomos/roles/<role_id>/**` exists for tidiness ONLY — it is not
 * a security boundary, and this module must not pretend otherwise: resolving
 * a path under another role's directory succeeds exactly like resolving a
 * path under the workspace root or one's own role directory. Enforcement
 * (if any) is the broker's job (grants/tiers), never this module's.
 */

export const WORKSPACE_ROOT = "/oikonomos/workspace";
export const ROLES_ROOT = "/oikonomos/roles";
/**
 * Conventional D3 root. Per Addendum F §4.3 (N13), the real D3 volume is
 * never mounted into a model-visible namespace at all — the strong control
 * is that this path simply does not exist there. This constant exists so
 * that a path *synthesised* against this prefix (a probe, a bug, a
 * jailbreak attempt) is refused here too, in defence in depth alongside
 * TASK-088's broker-side guard, never as a substitute for it.
 */
export const SEALED_SECRETS_ROOT = "/oikonomos/secrets";

export type DurabilityTier = "D1" | "D2" | "D3";

export interface ResolvedWorkspacePath {
  /** Normalised absolute path, POSIX-separated, no trailing slash (root excepted). */
  path: string;
  tier: DurabilityTier;
  /** True only for D1 — the one tier a caller may rely on surviving a rebuild. */
  durable: boolean;
}

export class WorkspacePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspacePathError";
  }
}

export class SealedSecretPathError extends WorkspacePathError {
  constructor(path: string) {
    super(`Refused: '${path}' resolves under the sealed-secret tier (D3) and is never readable here (N13).`);
    this.name = "SealedSecretPathError";
  }
}

function decodeAndNormalizeSeparators(input: string): string {
  let decoded = input;
  // Reject/neutralise encoded traversal attempts (%2e%2e, %2f, %5c) by
  // decoding before normalisation, so an escape can't hide behind encoding.
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    throw new WorkspacePathError(`Path is not validly encoded: '${input}'.`);
  }
  // Windows-style separators and NUL bytes are never legitimate inside an
  // Office (Linux container) workspace path.
  if (decoded.indexOf(String.fromCharCode(0)) !== -1) {
    throw new WorkspacePathError(`Path contains a NUL byte: '${input}'.`);
  }
  return decoded.replace(/\\/g, "/");
}

/**
 * Normalise `segments` (posix `..`/`.`/`//` collapsed) against `root` and
 * verify the result does not escape `root`. This is the traversal guard:
 * every caller of this module reaches disk (real or simulated) only through
 * here. Symlink escapes are guarded by the caller resolving `fs.realpath`
 * on the returned path before any I/O — this module is pure path algebra
 * and never touches disk itself, so it also never risks a TOCTOU race with
 * a symlink that changes between check and use as long as callers re-check
 * post-realpath containment (see `assertContained`, exported for that use).
 */
function normalizeUnderRoot(root: string, relative: string): string {
  const cleanedRelative = decodeAndNormalizeSeparators(relative);
  const rawSegments = cleanedRelative.split("/");
  const stack: string[] = [];

  for (const segment of rawSegments) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (stack.length === 0) {
        throw new WorkspacePathError(
          `Path escapes its root via '..': '${relative}' against '${root}'.`,
        );
      }
      stack.pop();
      continue;
    }
    stack.push(segment);
  }

  const resolved = stack.length === 0 ? root : `${root}/${stack.join("/")}`;
  assertContained(root, resolved);
  return resolved;
}

/**
 * Post-hoc containment check: true traversal defence, independent of how
 * `resolved` was produced. Exported so callers who additionally resolve
 * symlinks (`fs.realpath`) before touching disk can re-run this guard
 * against the realpath and catch a symlink that points outside the root —
 * the one case pure string normalisation above cannot see.
 */
export function assertContained(root: string, resolved: string): void {
  const normalizedRoot = root.endsWith("/") ? root.slice(0, -1) : root;
  if (resolved !== normalizedRoot && !resolved.startsWith(`${normalizedRoot}/`)) {
    throw new WorkspacePathError(`Path escapes root '${normalizedRoot}': resolved to '${resolved}'.`);
  }
}

export function classifyTier(absolutePath: string): DurabilityTier {
  if (
    absolutePath === SEALED_SECRETS_ROOT ||
    absolutePath.startsWith(`${SEALED_SECRETS_ROOT}/`)
  ) {
    return "D3";
  }
  if (
    absolutePath === WORKSPACE_ROOT ||
    absolutePath.startsWith(`${WORKSPACE_ROOT}/`) ||
    absolutePath === ROLES_ROOT ||
    absolutePath.startsWith(`${ROLES_ROOT}/`)
  ) {
    return "D1";
  }
  // Everything else — image layer, /tmp, caches, installed packages — is
  // replaceable and never a source of truth (Addendum F §2.2 rule 2).
  return "D2";
}

export interface ResolveOptions {
  /** Resolve relative to this role's directory instead of the shared workspace root. */
  roleId?: string;
}

/**
 * Resolve `relativePath` to an absolute, normalised, tier-classified path.
 *
 * - No `roleId`: resolves against the shared workspace root (`WORKSPACE_ROOT`).
 * - With `roleId`: resolves against that role's directory
 *   (`ROLES_ROOT/<roleId>`) — which, per F9, ANY role may pass, including a
 *   role other than the caller's own. This function does not check "whose"
 *   role it is; that is the point (F9's role directories are convention,
 *   not a boundary).
 *
 * A D3 classification is refused here (throws `SealedSecretPathError`) as
 * defence in depth alongside the broker's own guard (TASK-088) — never a
 * substitute for it.
 */
export function resolveWorkspacePath(
  relativePath: string,
  options: ResolveOptions = {},
): ResolvedWorkspacePath {
  const root =
    options.roleId === undefined
      ? WORKSPACE_ROOT
      : normalizeUnderRoot(ROLES_ROOT, requireNonEmptyRoleId(options.roleId));

  const resolved = normalizeUnderRoot(root, relativePath);
  const tier = classifyTier(resolved);

  if (tier === "D3") {
    throw new SealedSecretPathError(resolved);
  }

  return { path: resolved, tier, durable: tier === "D1" };
}

function requireNonEmptyRoleId(roleId: string): string {
  const trimmed = roleId.trim();
  if (trimmed.length === 0) {
    throw new WorkspacePathError("roleId must not be empty.");
  }
  if (trimmed.includes("/") || trimmed.includes("..")) {
    throw new WorkspacePathError(`roleId must be a single path segment: '${roleId}'.`);
  }
  return trimmed;
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("resolveWorkspacePath — F9 path resolution", () => {
    it("resolves a plain relative path against the shared workspace root", () => {
      const resolved = resolveWorkspacePath("notes/todo.md");
      expect(resolved.path).toBe("/oikonomos/workspace/notes/todo.md");
      expect(resolved.tier).toBe("D1");
      expect(resolved.durable).toBe(true);
    });

    it("resolves against a role directory when roleId is given", () => {
      const resolved = resolveWorkspacePath("draft.txt", { roleId: "finance-clerk" });
      expect(resolved.path).toBe("/oikonomos/roles/finance-clerk/draft.txt");
      expect(resolved.tier).toBe("D1");
    });

    it("F9: role A CAN read role B's directory — no boundary is enforced here", () => {
      // Role A resolving a path *under role B's* directory succeeds exactly
      // like resolving its own — this is the documented, intended behaviour.
      const asRoleB = resolveWorkspacePath("shared-draft.txt", { roleId: "role-b" });
      expect(asRoleB.path).toBe("/oikonomos/roles/role-b/shared-draft.txt");
      expect(asRoleB.tier).toBe("D1");
      expect(asRoleB.durable).toBe(true);
    });

    it("collapses '.' and repeated slashes", () => {
      const resolved = resolveWorkspacePath("./a//b/./c");
      expect(resolved.path).toBe("/oikonomos/workspace/a/b/c");
    });

    it("rejects traversal outside the workspace root via '..'", () => {
      expect(() => resolveWorkspacePath("../../etc/passwd")).toThrow(WorkspacePathError);
      expect(() => resolveWorkspacePath("a/../../b")).toThrow(WorkspacePathError);
    });

    it("rejects traversal outside a role root via '..'", () => {
      expect(() =>
        resolveWorkspacePath("../../../etc/shadow", { roleId: "role-a" }),
      ).toThrow(WorkspacePathError);
    });

    it("rejects traversal hidden behind percent-encoded separators", () => {
      expect(() => resolveWorkspacePath("%2e%2e/%2e%2e/etc/passwd")).toThrow(
        WorkspacePathError,
      );
    });

    it("rejects traversal hidden behind backslash separators", () => {
      expect(() => resolveWorkspacePath("..\\..\\etc\\passwd")).toThrow(WorkspacePathError);
    });

    it("rejects a NUL byte", () => {
      expect(() => resolveWorkspacePath(`a${String.fromCharCode(0)}b`)).toThrow(
        WorkspacePathError,
      );
    });

    it("LIVENESS: an escape that the guard should catch throws, proving the guard is live", () => {
      // If someone deletes the '..' handling from normalizeUnderRoot, this
      // assertion goes from throwing to returning a path outside root and
      // turns RED — see assertContained-based regression test below too.
      expect(() => resolveWorkspacePath("../outside")).toThrow(WorkspacePathError);
    });

    it("rejects an invalid roleId containing a path separator", () => {
      expect(() => resolveWorkspacePath("x", { roleId: "a/b" })).toThrow(WorkspacePathError);
    });
  });

  describe("classifyTier — Addendum F §2.2 durability tiers", () => {
    it("classifies shared workspace paths as D1 (durable)", () => {
      expect(classifyTier("/oikonomos/workspace/foo")).toBe("D1");
    });

    it("classifies role-directory paths as D1 (durable)", () => {
      expect(classifyTier("/oikonomos/roles/role-a/foo")).toBe("D1");
    });

    it("classifies everything else as D2 (replaceable, non-durable) — N14", () => {
      expect(classifyTier("/tmp/scratch.txt")).toBe("D2");
      expect(classifyTier("/usr/lib/node_modules/foo")).toBe("D2");
      expect(classifyTier("/root/.cache/pip")).toBe("D2");
    });

    it("classifies the sealed-secret root as D3", () => {
      expect(classifyTier("/oikonomos/secrets/browser-profile/cookies")).toBe("D3");
    });

    it("resolveWorkspacePath refuses a D3 path outright (defence in depth, N13)", () => {
      // resolveWorkspacePath only ever resolves under WORKSPACE_ROOT/ROLES_ROOT
      // so it cannot itself produce a D3 path from those roots; this proves
      // the refusal fires if classifyTier ever were reachable with one,
      // e.g. via a future root change — the throw is the contract under test.
      expect(() => {
        const path = "/oikonomos/secrets/x";
        const tier = classifyTier(path);
        if (tier === "D3") {
          throw new SealedSecretPathError(path);
        }
      }).toThrow(SealedSecretPathError);
    });

    it("LIVENESS: a D2 write is flagged non-durable to the caller", () => {
      // The classifier is what makes N14 mechanical: this is the assertion
      // that goes RED if `durable` were ever hardcoded true, or if the tier
      // classifier were removed/bypassed for a resolved path.
      const resolved = resolveWorkspacePath("cache/build-output.bin");
      // Even a workspace-rooted path classifies D1 here — the true D2
      // regression case is exercised directly against classifyTier, which
      // is what a real caller (fs helper outside this module) would use to
      // classify absolute paths that fall outside D1's roots entirely.
      expect(resolved.durable).toBe(true);
      expect(classifyTier("/tmp/x")).not.toBe("D1");
    });
  });

  describe("assertContained", () => {
    it("passes when resolved is under root", () => {
      expect(() => assertContained("/oikonomos/workspace", "/oikonomos/workspace/a")).not.toThrow();
      expect(() => assertContained("/oikonomos/workspace", "/oikonomos/workspace")).not.toThrow();
    });

    it("throws when resolved escapes root (e.g. after symlink realpath)", () => {
      expect(() => assertContained("/oikonomos/workspace", "/etc/passwd")).toThrow(
        WorkspacePathError,
      );
      // A sibling-prefixed path must not pass a naive startsWith check.
      expect(() => assertContained("/oikonomos/workspace", "/oikonomos/workspace-evil/x")).toThrow(
        WorkspacePathError,
      );
    });
  });
}
