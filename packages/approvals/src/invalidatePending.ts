import type { Approval, DatabaseOptions } from "@oikonomos/db";

import { createDatabaseStore, type ApprovalStore, type ConsumeApprovalResult } from "./store.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type InvalidatePendingDependencies =
  | { readonly store: ApprovalStore }
  | { readonly database: DatabaseOptions };

export type InvalidatePendingApprovalResult =
  | { readonly invalidated: true; readonly rowCount: 1; readonly approval: Approval }
  | { readonly invalidated: false; readonly rowCount: 0 };

function requireUuid(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || !UUID_RE.test(trimmed)) {
    throw new Error("nonce must be a UUID.");
  }
  return trimmed;
}

function resolveStore(deps: InvalidatePendingDependencies): ApprovalStore {
  if ("store" in deps) {
    return deps.store;
  }
  return createDatabaseStore(deps.database);
}

function toInvalidateResult(
  result: ConsumeApprovalResult,
): InvalidatePendingApprovalResult {
  if (result.rowCount === 1 && result.approval !== null) {
    if (result.approval.status !== "invalidated") {
      throw new Error(
        `invalidatePendingApproval returned rowCount 1 but status is '${result.approval.status}', expected 'invalidated'.`,
      );
    }
    if (result.approval.consumedAt !== null) {
      throw new Error("invalidating a pending approval must not consume it.");
    }
    return { invalidated: true, rowCount: 1, approval: result.approval };
  }
  if (result.rowCount !== 0) {
    throw new Error(
      `invalidatePendingApproval returned unexpected rowCount ${String(result.rowCount)}; transition must not apply.`,
    );
  }
  return { invalidated: false, rowCount: 0 };
}

/**
 * Void one still-live pending approval in one status-guarded statement.
 * This is the edit lifecycle transition, intentionally distinct from the
 * OIK-023 granted-path invalidation used after a digest mismatch.
 */
export async function invalidatePendingApproval(
  nonce: string,
  deps: InvalidatePendingDependencies,
): Promise<InvalidatePendingApprovalResult> {
  const normalizedNonce = requireUuid(nonce);
  const store = resolveStore(deps);
  if (store.invalidatePending === undefined) {
    throw new Error("ApprovalStore.invalidatePending is required to edit an approval.");
  }
  return toInvalidateResult(await store.invalidatePending(normalizedNonce));
}
