import type { DatabaseOptions } from "@oikonomos/db";

import {
  createDatabaseStore,
  type ApprovalStore,
  type ExpirePendingScope,
} from "./store.js";

export type { ExpirePendingScope };

export type SweepDependencies =
  | { readonly store: ApprovalStore }
  | { readonly database: DatabaseOptions };

export interface SweepExpiredResult {
  readonly expired: number;
}

function resolveStore(deps: SweepDependencies): ApprovalStore {
  if ("store" in deps) {
    return deps.store;
  }
  return createDatabaseStore(deps.database);
}

/**
 * Move expired `pending` approvals to `expired` (WBS OIK-024).
 * Idempotent: a second run transitions nothing already expired.
 * Concurrent runs do not double-transition — the UPDATE predicate
 * requires `status='pending'`.
 */
export async function sweepExpiredApprovals(
  deps: SweepDependencies,
  scope?: ExpirePendingScope,
): Promise<SweepExpiredResult> {
  const expired = await resolveStore(deps).expirePending(scope);
  if (!Number.isInteger(expired) || expired < 0) {
    throw new Error(`expirePending returned invalid count ${String(expired)}.`);
  }
  return { expired };
}
