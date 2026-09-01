/**
 * Process and user-context values that bind an approval to the context in
 * which it was requested.  Omitting both values deliberately preserves the
 * legacy, unbound approval behaviour.
 */
export interface ApprovalBinding {
  readonly controlPlaneGeneration?: string;
  readonly userContextEpoch?: bigint;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(value: string, field: string): string {
  const trimmed = value.trim();
  if (!UUID_RE.test(trimmed)) {
    throw new Error(`${field} must be a UUID.`);
  }
  return trimmed;
}

/** Validate and normalize optional binding values before they reach storage. */
export function normalizeApprovalBinding(
  binding: ApprovalBinding | undefined,
): ApprovalBinding | undefined {
  if (binding === undefined) {
    return undefined;
  }

  const controlPlaneGeneration =
    binding.controlPlaneGeneration === undefined
      ? undefined
      : requireUuid(binding.controlPlaneGeneration, "controlPlaneGeneration");
  const userContextEpoch = binding.userContextEpoch;
  if (userContextEpoch !== undefined && userContextEpoch < 0n) {
    throw new Error("userContextEpoch must not be negative.");
  }

  return { controlPlaneGeneration, userContextEpoch };
}
