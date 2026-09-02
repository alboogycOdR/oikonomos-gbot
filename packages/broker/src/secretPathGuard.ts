import { resolve as resolvePosixPath, sep } from "node:path/posix";
import { SEALED_SECRET_ROOT } from "@oikonomos/shared";

/**
 * D3 is deliberately outside the model namespace. This guard is the broker
 * backstop: it prevents an attempted tool target from reaching an executor
 * should a D3 path nevertheless be presented to it.
 */
export const SECRET_PATH_AUDIT_EVENT_TYPE = "secret_path_attempt";
export const SECRET_PATH_DENIAL_REASON = "secret_path.sealed";

export interface SecretPathAuditEvent {
  readonly type: typeof SECRET_PATH_AUDIT_EVENT_TYPE;
  readonly verdict: "deny";
  readonly reason: typeof SECRET_PATH_DENIAL_REASON;
}

export type SecretPathGuardDecision =
  | { readonly decision: "allow" }
  | {
    readonly decision: "deny";
    readonly reason: typeof SECRET_PATH_DENIAL_REASON;
    readonly auditEvent: SecretPathAuditEvent;
  };

export interface SecretPathGuardOptions {
  /**
   * Resolves filesystem links before the D3 comparison. The broker supplies
   * its target resolver in production; injection keeps this pure guard usable
   * for targets whose parent does not exist in the model namespace.
   */
  readonly resolveSymlinks?: (normalisedPath: string) => string;
}

function decodeSeparators(path: string): string {
  let decoded = path;
  // Decode repeatedly so a doubly-encoded slash cannot bypass normalisation.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      // Invalid URI sequences are not a filesystem path we can safely match.
      return decoded;
    }
  }
  return decoded;
}

function normalise(path: string): string {
  return resolvePosixPath(decodeSeparators(path).replaceAll("\\", "/"));
}

function isWithinSealedRoot(path: string): boolean {
  return path === SEALED_SECRET_ROOT || path.startsWith(`${SEALED_SECRET_ROOT}${sep}`);
}

/**
 * Denies D3 targets independently of any risk tier, grant, or allow rule.
 * The returned audit data is deliberately target-free: D3 path material must
 * not be copied into a transcript, log, audit payload, or test fixture.
 */
export function guardSecretPath(
  target: string,
  options: SecretPathGuardOptions = {},
): SecretPathGuardDecision {
  const normalisedTarget = normalise(target);
  const resolvedTarget = normalise(options.resolveSymlinks?.(normalisedTarget) ?? normalisedTarget);

  if (!isWithinSealedRoot(resolvedTarget)) return { decision: "allow" };

  return {
    decision: "deny",
    reason: SECRET_PATH_DENIAL_REASON,
    auditEvent: {
      type: SECRET_PATH_AUDIT_EVENT_TYPE,
      verdict: "deny",
      reason: SECRET_PATH_DENIAL_REASON,
    },
  };
}
