import type { Approval, DatabaseOptions } from "@oikonomos/db";

import { createDatabaseStore, type ApprovalStore, type ConsumeApprovalResult } from "./store.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ConsumeDependencies =
  | { readonly store: ApprovalStore }
  | { readonly database: DatabaseOptions };

/**
 * The action may run only on `consumed: true` (row count 1). Every other
 * outcome — replay, expiry, pending, unknown nonce — is `consumed: false`.
 */
export type VerifyAndConsumeResult =
  | { readonly consumed: true; readonly rowCount: 1; readonly approval: Approval }
  | { readonly consumed: false; readonly rowCount: 0 };

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

function resolveStore(deps: ConsumeDependencies): ApprovalStore {
  if ("store" in deps) {
    return deps.store;
  }
  return createDatabaseStore(deps.database);
}

/**
 * Verify a nonce by consuming it in one atomic statement (N8).
 * `consumed: true` is the only signal that the action may run.
 */
export async function verifyAndConsume(
  nonce: string,
  deps: ConsumeDependencies,
): Promise<VerifyAndConsumeResult> {
  const normalizedNonce = requireUuid(nonce, "nonce");
  const result: ConsumeApprovalResult = await resolveStore(deps).consume(normalizedNonce);

  if (result.rowCount === 1 && result.approval !== null) {
    if (result.approval.status !== "consumed") {
      throw new Error(
        `consume returned rowCount 1 but status is '${result.approval.status}'.`,
      );
    }
    return { consumed: true, rowCount: 1, approval: result.approval };
  }

  if (result.rowCount !== 0) {
    throw new Error(
      `consume returned unexpected rowCount ${String(result.rowCount)}; action must not run.`,
    );
  }

  return { consumed: false, rowCount: 0 };
}