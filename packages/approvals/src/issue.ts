import type { Approval, DatabaseOptions } from "@oikonomos/db";
import type { JsonValue } from "@oikonomos/shared";

import { actionDigestToBytes, bindActionDigest } from "./bind.js";
import { generateNonce } from "./nonce.js";
import { createDatabaseStore, type ApprovalStore } from "./store.js";

/** Synthesis §5.1: `expires_at` defaults to now + 4 hours. */
export const DEFAULT_APPROVAL_TTL_MS = 4 * 60 * 60 * 1000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface IssueApprovalRequest {
  readonly runId: string;
  readonly capabilityId: string;
  readonly toolName: string;
  readonly input: JsonValue;
  readonly destination: string;
  readonly actionRender: string;
  readonly tenantId?: string;
  readonly expiresAt?: Date;
}

/**
 * The wait signal returned to the caller *after* the approval row is
 * persisted. Receiving this object is what "telling the agent to wait"
 * means at this layer (WBS OIK-021; Synthesis §5.2 invariant 3).
 */
export interface ApprovalWaitSignal {
  readonly reason: "approval_pending";
  readonly approvalId: string;
  readonly nonce: string;
  readonly expiresAt: Date;
  readonly actionDigest: string;
  readonly actionRender: string;
  readonly destination: string;
  readonly status: "pending";
}

export type IssueApprovalDependencies =
  | { readonly store: ApprovalStore }
  | { readonly database: DatabaseOptions };

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

function resolveExpiresAt(value: Date | undefined): Date {
  if (value === undefined) {
    return new Date(Date.now() + DEFAULT_APPROVAL_TTL_MS);
  }
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("expiresAt must be a valid Date.");
  }
  return value;
}

function resolveStore(deps: IssueApprovalDependencies): ApprovalStore {
  if ("store" in deps) {
    return deps.store;
  }
  return createDatabaseStore(deps.database);
}

function toWaitSignal(persisted: Approval, actionDigestHex: string): ApprovalWaitSignal {
  if (persisted.status !== "pending") {
    throw new Error(
      `issued approval ${persisted.approvalId} has status '${persisted.status}', expected 'pending'.`,
    );
  }
  return {
    reason: "approval_pending",
    approvalId: persisted.approvalId,
    nonce: persisted.nonce,
    expiresAt: persisted.expiresAt,
    actionDigest: actionDigestHex,
    actionRender: persisted.actionRender,
    destination: persisted.destination,
    status: persisted.status,
  };
}

/**
 * Bind the action (Handover §4.3 digest), persist the approval row, then
 * return the wait signal. Persist is awaited before the signal is built —
 * a crash between those two steps can only lose the signal, never strand
 * a run against a missing row (WBS OIK-021).
 */
export async function issueApproval(
  request: IssueApprovalRequest,
  deps: IssueApprovalDependencies,
): Promise<ApprovalWaitSignal> {
  const runId = requireUuid(request.runId, "runId");
  const capabilityId = requireNonEmpty(request.capabilityId, "capabilityId");
  const toolName = requireNonEmpty(request.toolName, "toolName");
  const destination = requireNonEmpty(request.destination, "destination");
  const actionRender = requireNonEmpty(request.actionRender, "actionRender");
  const expiresAt = resolveExpiresAt(request.expiresAt);
  const tenantId =
    request.tenantId === undefined ? undefined : requireNonEmpty(request.tenantId, "tenantId");

  const actionDigestHex = bindActionDigest({
    toolName,
    input: request.input,
    destination,
  });
  const nonce = generateNonce();
  const store = resolveStore(deps);

  const persisted = await store.insert({
    tenantId,
    runId,
    capabilityId,
    actionDigest: actionDigestToBytes(actionDigestHex),
    actionRender,
    destination,
    nonce,
    expiresAt,
  });

  return toWaitSignal(persisted, actionDigestHex);
}
