import type { Approval, DatabaseOptions } from "@oikonomos/db";

import { createDatabaseStore, type ApprovalStore, type ConsumeApprovalResult } from "./store.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ApprovalDecision = "granted" | "rejected";

export type DecideDependencies =
  | { readonly store: ApprovalStore }
  | { readonly database: DatabaseOptions };

/**
 * The decision stuck only on `decided: true` (row count 1). Replay,
 * expiry, a non-pending status, or an unknown nonce is `decided: false`.
 */
export type DecideApprovalResult =
  | { readonly decided: true; readonly rowCount: 1; readonly approval: Approval }
  | { readonly decided: false; readonly rowCount: 0 };

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${field} must not be empty.`);
  }
  return trimmed;
}

function requireUuid(value: string, field: string): string {
  const trimmed = requireNonEmpty(value, field);
  if (!UUID_RE.test(trimmed)) {
    throw new Error(`${field} must be a UUID.`);
  }
  return trimmed;
}

function resolveStore(deps: DecideDependencies): ApprovalStore {
  if ("store" in deps) {
    return deps.store;
  }
  return createDatabaseStore(deps.database);
}

function requireDecisionMethod(
  store: ApprovalStore,
  decision: ApprovalDecision,
): (nonce: string, decidedBy: string) => Promise<ConsumeApprovalResult> {
  const apply = decision === "granted" ? store.grant : store.reject;
  if (apply === undefined) {
    throw new Error(
      `ApprovalStore.${decision === "granted" ? "grant" : "reject"} is required to decide an approval.`,
    );
  }
  return apply;
}

function toDecideResult(
  decision: ApprovalDecision,
  result: ConsumeApprovalResult,
): DecideApprovalResult {
  if (result.rowCount === 1 && result.approval !== null) {
    if (result.approval.status !== decision) {
      throw new Error(
        `decision returned rowCount 1 but status is '${result.approval.status}', expected '${decision}'.`,
      );
    }
    if (result.approval.consumedAt !== null) {
      throw new Error("approval decision must not consume; consumed_at must stay null.");
    }
    return { decided: true, rowCount: 1, approval: result.approval };
  }
  if (result.rowCount !== 0) {
    throw new Error(
      `decision returned unexpected rowCount ${String(result.rowCount)}; transition must not apply.`,
    );
  }
  return { decided: false, rowCount: 0 };
}

/**
 * Move a pending approval to granted or rejected in one status-guarded
 * statement (N8 / OIK-086). Granting does not consume — use
 * {@link verifyAndConsume} to spend a grant.
 */
export async function decideApproval(
  nonce: string,
  decision: ApprovalDecision,
  decidedBy: string,
  deps: DecideDependencies,
): Promise<DecideApprovalResult> {
  if (decision !== "granted" && decision !== "rejected") {
    throw new Error("decision must be granted or rejected.");
  }
  const normalizedNonce = requireUuid(nonce, "nonce");
  const actor = requireNonEmpty(decidedBy, "decidedBy");
  const store = resolveStore(deps);
  const apply = requireDecisionMethod(store, decision);
  const result = await apply(normalizedNonce, actor);
  return toDecideResult(decision, result);
}

export async function grantApproval(
  nonce: string,
  decidedBy: string,
  deps: DecideDependencies,
): Promise<DecideApprovalResult> {
  return decideApproval(nonce, "granted", decidedBy, deps);
}

export async function rejectApproval(
  nonce: string,
  decidedBy: string,
  deps: DecideDependencies,
): Promise<DecideApprovalResult> {
  return decideApproval(nonce, "rejected", decidedBy, deps);
}
