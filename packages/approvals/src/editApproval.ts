import type { Approval, DatabaseOptions } from "@oikonomos/db";

import { actionDigestToBytes, bindActionDigest } from "./bind.js";
import {
  DEFAULT_APPROVAL_TTL_MS,
  type ApprovalWaitSignal,
  type IssueApprovalRequest,
} from "./issue.js";
import { generateNonce } from "./nonce.js";
import { actionRender } from "./render.js";
import {
  APPROVAL_COLUMNS,
  INSERT_APPROVAL_SQL,
  INVALIDATE_PENDING_APPROVAL_SQL,
  withApprovalClient,
  type ApprovalClient,
} from "./store.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EditApprovalDependencies = {
  readonly database: DatabaseOptions;
};

/**
 * @internal Test-only key for injected mid-transaction faults.
 * Not re-exported from the package barrel; a structurally-typed
 * `{ afterInvalidate }` argument is ignored.
 */
export const EDIT_APPROVAL_TEST_HOOKS: unique symbol = Symbol(
  "oikonomos.approvals.editApproval.testHooks",
);

/** @internal */
type EditApprovalTestHooks = {
  readonly afterInvalidate?: () => Promise<void>;
};

const DEFAULT_TENANT_ID = "basileia";

export type EditApprovalResult =
  | {
      readonly edited: true;
      readonly rowCount: 1;
      readonly invalidated: Approval;
      readonly replacement: ApprovalWaitSignal;
    }
  | { readonly edited: false; readonly rowCount: 0 };

interface ApprovalRow {
  approval_id: string;
  tenant_id: string;
  run_id: string;
  capability_id: string;
  action_digest: Buffer;
  action_render: string;
  destination: string;
  nonce: string;
  status: Approval["status"];
  requested_at: Date;
  expires_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  consumed_at: Date | null;
}

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

function toApproval(row: ApprovalRow): Approval {
  return {
    approvalId: row.approval_id,
    tenantId: row.tenant_id,
    runId: row.run_id,
    capabilityId: row.capability_id,
    actionDigest: row.action_digest,
    actionRender: row.action_render,
    destination: row.destination,
    nonce: row.nonce,
    status: row.status,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    consumedAt: row.consumed_at,
  };
}

function assertIdentityBound(
  invalidated: Approval,
  requested: { runId: string; capabilityId: string; tenantId: string },
): void {
  if (invalidated.runId !== requested.runId) {
    throw new Error("editApproval cannot rebind run_id.");
  }
  if (invalidated.capabilityId !== requested.capabilityId) {
    throw new Error("editApproval cannot rebind capability_id.");
  }
  if (invalidated.tenantId !== requested.tenantId) {
    throw new Error("editApproval cannot rebind tenant_id.");
  }
}

function toWaitSignal(persisted: Approval, actionDigestHex: string): ApprovalWaitSignal {
  if (persisted.status !== "pending") {
    throw new Error(
      `replacement approval ${persisted.approvalId} has status '${persisted.status}', expected 'pending'.`,
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

async function rollback(client: ApprovalClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The original database error is the actionable one (capabilities.ts precedent).
  }
}

/**
 * Atomically void a still-pending approval and issue a replacement bound
 * to the edited payload. Both writes share one client inside BEGIN/COMMIT
 * (N8 / OIK-086). A mid-flight failure leaves the original pending and
 * inserts nothing. The replacement is bound to the voided row's run_id,
 * capability_id, and tenant_id — a divergent request rolls back.
 */
export async function editApproval(
  nonce: string,
  editedRequest: IssueApprovalRequest,
  deps: EditApprovalDependencies,
  testHooks?: { readonly [EDIT_APPROVAL_TEST_HOOKS]?: EditApprovalTestHooks },
): Promise<EditApprovalResult> {
  const normalizedNonce = requireUuid(nonce, "nonce");
  const runId = requireUuid(editedRequest.runId, "runId");
  const capabilityId = requireNonEmpty(editedRequest.capabilityId, "capabilityId");
  const toolName = requireNonEmpty(editedRequest.toolName, "toolName");
  const destination = requireNonEmpty(editedRequest.destination, "destination");
  const expiresAt = resolveExpiresAt(editedRequest.expiresAt);
  const requestedTenantId =
    editedRequest.tenantId === undefined
      ? DEFAULT_TENANT_ID
      : requireNonEmpty(editedRequest.tenantId, "tenantId");

  const action = {
    toolName,
    input: editedRequest.input,
    destination,
  };
  const actionDigestHex = bindActionDigest(action);
  const derivedRender = actionRender(action);
  const replacementNonce = generateNonce();

  return withApprovalClient(deps.database, async (client) => {
    try {
      await client.query("BEGIN");
      const invalidatedResult = await client.query<ApprovalRow>(
        `${INVALIDATE_PENDING_APPROVAL_SQL} RETURNING ${APPROVAL_COLUMNS}`,
        [normalizedNonce],
      );
      const invalidatedCount = invalidatedResult.rowCount ?? 0;
      if (invalidatedCount === 0) {
        await rollback(client);
        return { edited: false, rowCount: 0 };
      }
      if (invalidatedCount !== 1 || invalidatedResult.rows[0] === undefined) {
        throw new Error(
          `editApproval invalidate matched ${String(invalidatedCount)} rows for one nonce; expected 0 or 1.`,
        );
      }
      const invalidated = toApproval(invalidatedResult.rows[0]);
      if (invalidated.status !== "invalidated") {
        throw new Error(
          `editApproval invalidate returned status '${invalidated.status}', expected 'invalidated'.`,
        );
      }
      if (invalidated.consumedAt !== null) {
        throw new Error("editing a pending approval must not consume it.");
      }
      assertIdentityBound(invalidated, {
        runId,
        capabilityId,
        tenantId: requestedTenantId,
      });
      const hooks = testHooks?.[EDIT_APPROVAL_TEST_HOOKS];
      if (hooks?.afterInvalidate !== undefined) {
        await hooks.afterInvalidate();
      }

      const inserted = await client.query<ApprovalRow>(
        `${INSERT_APPROVAL_SQL} RETURNING ${APPROVAL_COLUMNS}`,
        [
          invalidated.tenantId,
          invalidated.runId,
          invalidated.capabilityId,
          actionDigestToBytes(actionDigestHex),
          derivedRender,
          destination,
          replacementNonce,
          expiresAt,
        ],
      );
      const insertedRow = inserted.rows[0];
      if ((inserted.rowCount ?? 0) !== 1 || insertedRow === undefined) {
        throw new Error("editApproval insert did not return a persisted replacement row.");
      }
      const replacement = toWaitSignal(toApproval(insertedRow), actionDigestHex);
      await client.query("COMMIT");
      return {
        edited: true,
        rowCount: 1,
        invalidated,
        replacement,
      };
    } catch (error) {
      await rollback(client);
      throw error;
    }
  });
}
