import type { Approval, DatabaseOptions } from "@oikonomos/db";
import type { ActionDigestInput } from "@oikonomos/shared";

import { bindActionDigest } from "./bind.js";
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
 * When `action` is supplied, the digest is recomputed first (OIK-023 /
 * ADR-001 CAN-07); a mismatch invalidates a granted row and the action
 * must not run. `consumed: true` is the only signal that the action may run.
 *
 * `action` is optional so TASK-014 call sites keep working; the execute
 * path must pass the payload being run.
 */
export async function verifyAndConsume(
  nonce: string,
  deps: ConsumeDependencies,
  action?: ActionDigestInput,
): Promise<VerifyAndConsumeResult> {
  const normalizedNonce = requireUuid(nonce, "nonce");
  const store = resolveStore(deps);

  if (action !== undefined) {
    const expectedHex = bindActionDigest(action);
    const existing = await store.getByNonce(normalizedNonce);
    if (existing !== null && existing.actionDigest.toString("hex") !== expectedHex) {
      if (existing.status === "granted") {
        await store.invalidate(normalizedNonce);
      }
      return { consumed: false, rowCount: 0 };
    }
  }

  const result: ConsumeApprovalResult = await store.consume(normalizedNonce);

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