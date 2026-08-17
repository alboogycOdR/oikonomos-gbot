/**
 * L2 outer-shell shape (ADR-001 L2).
 *
 * Typed data only — OIK-036 owns validation (bare-name rejection, R1).
 * `permissionMode` is fixed to `dontAsk` so unlisted tools are hard-denied
 * rather than falling through to a callback.
 */

export const L2_PERMISSION_MODE = "dontAsk" as const;

export type L2PermissionMode = typeof L2_PERMISSION_MODE;

/** One allowlist entry. Scoped form (`Bash(ls *)`) is the expected shape; validation is OIK-036. */
export type AllowedTool = string;

export interface L2Policy {
  readonly permissionMode: L2PermissionMode;
  readonly allowedTools: readonly AllowedTool[];
}

export function isL2Policy(value: unknown): value is L2Policy {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as { permissionMode?: unknown; allowedTools?: unknown };
  return (
    record.permissionMode === L2_PERMISSION_MODE &&
    Array.isArray(record.allowedTools) &&
    record.allowedTools.every((entry) => typeof entry === "string")
  );
}
