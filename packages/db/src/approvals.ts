import { Pool, type QueryResultRow } from "pg";

import { defaultPoolConfig, type DatabaseOptions } from "./database.js";

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
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const approvalColumns = `approval_id, tenant_id, run_id, capability_id, action_digest,
       action_render, destination, nonce, status, requested_at, expires_at,
       decided_by, decided_at, consumed_at`;

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
  };
}

async function withPool<T>(
  options: DatabaseOptions,
  fn: (pool: Pool) => Promise<T>,
): Promise<T> {
  if (options.connectionString.trim().length === 0) {
    throw new Error("Database connectionString must not be empty.");
  }

  const pool = new Pool({
    connectionString: options.connectionString,
    ...defaultPoolConfig,
    ...options.poolConfig,
  });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

/**
 * Persist a pending approval. Status is always the table default (`pending`);
 * mutation (including consume) is owned by TASK-014.
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

  return withPool(options, async (pool) => {
    const result = await pool.query<ApprovalRow>(
      `INSERT INTO approvals (
         tenant_id, run_id, capability_id, action_digest, action_render,
         destination, nonce, expires_at
       )
       VALUES (
         COALESCE($1, 'basileia'),
         $2,
         $3,
         $4,
         $5,
         $6,
         COALESCE($7::uuid, gen_random_uuid()),
         $8
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
