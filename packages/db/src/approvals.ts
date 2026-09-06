import type { QueryResultRow } from "pg";

import { withPool, type DatabaseOptions } from "./database.js";

export const approvalStatuses = [
  "pending",
  "granted",
  "rejected",
  "expired",
  "invalidated",
  "consumed",
] as const;

export type ApprovalStatus = (typeof approvalStatuses)[number];

export interface NewApproval {
  tenantId?: string;
  runId: string;
  capabilityId: string;
  actionDigest: Uint8Array;
  actionRender: string;
  destination: string;
  nonce?: string;
  expiresAt: Date;
  controlPlaneGeneration?: string;
  userContextEpoch?: bigint;
}

export interface Approval {
  approvalId: string;
  tenantId: string;
  runId: string;
  capabilityId: string;
  actionDigest: Buffer;
  actionRender: string;
  destination: string;
  nonce: string;
  status: ApprovalStatus;
  requestedAt: Date;
  expiresAt: Date;
  decidedBy: string | null;
  decidedAt: Date | null;
  consumedAt: Date | null;
  /** Undefined is tolerated by legacy in-memory stores; database rows return null or a value. */
  controlPlaneGeneration?: string | null;
  userContextEpoch?: bigint | null;
}

interface ApprovalRow extends QueryResultRow {
  approval_id: string;
  tenant_id: string;
  run_id: string;
  capability_id: string;
  action_digest: Buffer;
  action_render: string;
  destination: string;
  nonce: string;
  status: ApprovalStatus;
  requested_at: Date;
  expires_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  consumed_at: Date | null;
  control_plane_generation: string | null;
  user_context_epoch: bigint | string | null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const approvalColumns = `approval_id, tenant_id, run_id, capability_id, action_digest,
       action_render, destination, nonce, status, requested_at, expires_at,
       decided_by, decided_at, consumed_at, control_plane_generation,
       user_context_epoch`;

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

function requireExpiresAt(value: Date): Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error("expiresAt must be a valid Date.");
  }
  return value;
}

/** Optional context values required to redeem a bound approval. */
export interface ApprovalConsumeBinding {
  controlPlaneGeneration?: string;
  userContextEpoch?: bigint;
}

function requireOptionalUuid(value: string | undefined, field: string): string | null {
  return value === undefined ? null : requireUuid(value, field);
}

function requireOptionalEpoch(value: bigint | undefined): bigint | null {
  if (value !== undefined && value < 0n) {
    throw new Error("userContextEpoch must not be negative.");
  }
  return value ?? null;
}

function toDigestBuffer(digest: Uint8Array): Buffer {
  if (digest.byteLength === 0) {
    throw new Error("actionDigest must not be empty.");
  }
  return Buffer.isBuffer(digest) ? digest : Buffer.from(digest);
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
    controlPlaneGeneration: row.control_plane_generation,
    userContextEpoch:
      row.user_context_epoch === null ? null : BigInt(row.user_context_epoch),
  };
}

/**
 * Persist a pending approval. Status is always the table default (`pending`).
 */
export async function insertApproval(
  options: DatabaseOptions,
  approval: NewApproval,
): Promise<Approval> {
  const runId = requireUuid(approval.runId, "runId");
  const capabilityId = requireNonEmpty(approval.capabilityId, "capabilityId");
  const actionRender = requireNonEmpty(approval.actionRender, "actionRender");
  const destination = requireNonEmpty(approval.destination, "destination");
  const expiresAt = requireExpiresAt(approval.expiresAt);
  const actionDigest = toDigestBuffer(approval.actionDigest);
  const nonce =
    approval.nonce === undefined ? null : requireUuid(approval.nonce, "nonce");
  const controlPlaneGeneration = requireOptionalUuid(
    approval.controlPlaneGeneration,
    "controlPlaneGeneration",
  );
  const userContextEpoch = requireOptionalEpoch(approval.userContextEpoch);

  return withPool(options, async (pool) => {
    const result = await pool.query<ApprovalRow>(
      `INSERT INTO approvals (
         tenant_id, run_id, capability_id, action_digest, action_render,
         destination, nonce, expires_at, control_plane_generation, user_context_epoch
       )
       VALUES (
         COALESCE($1, 'basileia'),
         $2,
         $3,
         $4,
         $5,
         $6,
         COALESCE($7::uuid, gen_random_uuid()),
         $8,
         $9,
         $10
       )
       RETURNING ${approvalColumns}`,
      [
        approval.tenantId ?? null,
        runId,
        capabilityId,
        actionDigest,
        actionRender,
        destination,
        nonce,
        expiresAt,
        controlPlaneGeneration,
        userContextEpoch,
      ],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("insertApproval did not return a persisted row.");
    }
    return toApproval(row);
  });
}

export async function getApprovalByNonce(
  options: DatabaseOptions,
  nonce: string,
): Promise<Approval | null> {
  const normalizedNonce = requireUuid(nonce, "nonce");

  return withPool(options, async (pool) => {
    const result = await pool.query<ApprovalRow>(
      `SELECT ${approvalColumns}
       FROM approvals
       WHERE nonce = $1`,
      [normalizedNonce],
    );
    return result.rows[0] === undefined ? null : toApproval(result.rows[0]);
  });
}

/**
 * Handover §4.3 / Synthesis §5.2 / N8 — consumption is this statement.
 * RETURNING is appended at the call site so the row can be handed back;
 * it does not change which rows match or that the write is one statement.
 */
export const CONSUME_APPROVAL_SQL = `UPDATE approvals SET status='consumed', consumed_at=now()
WHERE nonce=$1 AND status='granted' AND expires_at>now() AND consumed_at IS NULL
  AND (control_plane_generation IS NULL OR control_plane_generation=$2::uuid)
  AND (user_context_epoch IS NULL OR user_context_epoch=$3::bigint)`;

export interface ConsumeApprovalResult {
  readonly rowCount: 0 | 1;
  readonly approval: Approval | null;
}

/**
 * Atomically consume a granted, unexpired, unused approval.
 * The action may run only when `rowCount === 1`. Replay, expiry, a
 * non-granted status, or an unknown nonce all yield `rowCount === 0`.
 */
export async function consumeApproval(
  options: DatabaseOptions,
  nonce: string,
  binding: ApprovalConsumeBinding = {},
): Promise<ConsumeApprovalResult> {
  const normalizedNonce = requireUuid(nonce, "nonce");
  const controlPlaneGeneration = requireOptionalUuid(
    binding.controlPlaneGeneration,
    "controlPlaneGeneration",
  );
  const userContextEpoch = requireOptionalEpoch(binding.userContextEpoch);

  return withPool(options, async (pool) => {
    const result = await pool.query<ApprovalRow>(
      `${CONSUME_APPROVAL_SQL} RETURNING ${approvalColumns}`,
      [normalizedNonce, controlPlaneGeneration, userContextEpoch],
    );
    const rowCount = result.rowCount ?? 0;
    if (rowCount === 1 && result.rows[0] !== undefined) {
      return { rowCount: 1, approval: toApproval(result.rows[0]) };
    }
    if (rowCount > 1) {
      throw new Error(
        `consumeApproval matched ${rowCount} rows for one nonce; expected 0 or 1.`,
      );
    }
    return { rowCount: 0, approval: null };
  });
}

export interface PendingApprovalFilter {
  tenantId?: string;
}

/**
 * List every approval still awaiting a human decision: status `pending`
 * and not yet expired. Oldest-requested first, so the longest-waiting
 * approval surfaces at the top of an operator's queue. This is a read
 * path only — it never touches `packages/approvals`' decide/consume SQL
 * (TASK-062's territory).
 */
export async function listPendingApprovals(
  options: DatabaseOptions,
  filter: PendingApprovalFilter = {},
): Promise<Approval[]> {
  const conditions = [`status = 'pending'`, `expires_at > now()`];
  const params: unknown[] = [];

  if (filter.tenantId !== undefined) {
    params.push(requireNonEmpty(filter.tenantId, "tenantId"));
    conditions.push(`tenant_id = $${params.length}`);
  }

  return withPool(options, async (pool) => {
    const result = await pool.query<ApprovalRow>(
      `SELECT ${approvalColumns}
       FROM approvals
       WHERE ${conditions.join(" AND ")}
       ORDER BY requested_at ASC, approval_id ASC`,
      params,
    );
    return result.rows.map(toApproval);
  });
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  // Validation-only: no live-DB assertions here. This module is imported
  // (transitively, via index.js) by every other test file in the package,
  // and `import.meta.vitest` blocks re-register whenever the module loads
  // — a live-DB test here would run once per importing file, concurrently,
  // against the same rows. The live-DB coverage for `listPendingApprovals`
  // lives in `runs.test.ts` (a dedicated, not-otherwise-imported file)
  // instead.
  describe("@oikonomos/db approvals — input validation (no DB required)", () => {
    const options: DatabaseOptions = { connectionString: "   " };

    it("rejects an empty connection string before opening a pool", async () => {
      await expect(listPendingApprovals(options)).rejects.toThrow(/connectionString/);
    });

    it("rejects an empty tenantId filter", async () => {
      await expect(
        listPendingApprovals({ connectionString: "postgres://x" }, { tenantId: "   " }),
      ).rejects.toThrow(/tenantId/);
    });
  });
}
