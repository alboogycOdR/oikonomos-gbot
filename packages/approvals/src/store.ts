import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  consumeApproval,
  defaultPoolConfig,
  getApprovalByNonce,
  insertApproval,
  type Approval,
  type ConsumeApprovalResult,
  type DatabaseOptions,
  type NewApproval,
} from "@oikonomos/db";

import type { ApprovalBinding } from "./binding.js";

export type { ConsumeApprovalResult };

/** Optional isolation for expirePending — production sweeper stays unscoped. */
export type ExpirePendingScope = { readonly runId: string };

/**
 * Persistence port for issuance, consume, invalidation, and expiry.
 * Production uses {@link createDatabaseStore}; tests inject a fake.
 */
export interface ApprovalStore {
  insert(approval: NewApproval): Promise<Approval>;
  getByNonce(nonce: string): Promise<Approval | null>;
  consume(nonce: string, binding?: ApprovalBinding): Promise<ConsumeApprovalResult>;
  invalidate(nonce: string): Promise<ConsumeApprovalResult>;
  /** Optional: TASK-064 pending→invalidated transition for approval edits. */
  invalidatePending?(nonce: string): Promise<ConsumeApprovalResult>;
  expirePending(scope?: ExpirePendingScope): Promise<number>;
  /**
   * Optional: TASK-062 decision transitions. Existing fakes stay valid;
   * production {@link createDatabaseStore} always implements both.
   */
  grant?(nonce: string, decidedBy: string): Promise<ConsumeApprovalResult>;
  reject?(nonce: string, decidedBy: string): Promise<ConsumeApprovalResult>;
}

/** Pinned OIK-023 statement — granted + unused + digest already compared in-process. */
export const INVALIDATE_APPROVAL_SQL = `UPDATE approvals SET status='invalidated'
WHERE nonce=$1 AND status='granted' AND consumed_at IS NULL`;

/**
 * Pinned TASK-064 edit statement. This is deliberately separate from the
 * OIK-023 granted-path invalidation above: editing voids an un-decided
 * approval, while a digest mismatch voids an already-granted approval.
 */
export const INVALIDATE_PENDING_APPROVAL_SQL = `UPDATE approvals SET status='invalidated'
WHERE nonce=$1 AND status='pending' AND expires_at>now() AND consumed_at IS NULL`;

/** Pinned OIK-024 statement — only pending rows whose expiry has elapsed. */
export const EXPIRE_PENDING_SQL = `UPDATE approvals SET status='expired'
WHERE status='pending' AND expires_at<=now()`;

/**
 * Pinned pending→granted (OIK-086 / N8). Does not set consumed_at —
 * approve and use are separate steps (OIK-022).
 */
export const GRANT_APPROVAL_SQL = `UPDATE approvals SET status='granted', decided_by=$2, decided_at=now()
WHERE nonce=$1 AND status='pending' AND expires_at>now() AND consumed_at IS NULL`;

/**
 * Pinned pending→rejected (OIK-086 / N8). Same status/expiry/unused
 * guards as grant; never consumes.
 */
export const REJECT_APPROVAL_SQL = `UPDATE approvals SET status='rejected', decided_by=$2, decided_at=now()
WHERE nonce=$1 AND status='pending' AND expires_at>now() AND consumed_at IS NULL`;

export const APPROVAL_COLUMNS = `approval_id, tenant_id, run_id, capability_id, action_digest,
       action_render, destination, nonce, status, requested_at, expires_at,
       decided_by, decided_at, consumed_at`;

/**
 * Replacement-row insert for editApproval. Mirrors packages/db insertApproval
 * so invalidate + insert can share one client; do not add a WHERE clause here.
 */
export const INSERT_APPROVAL_SQL = `INSERT INTO approvals (
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
       )`;

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

interface PgResult<T extends object> {
  rows: T[];
  rowCount: number | null;
}

interface PgClient {
  query<T extends object = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PgResult<T>>;
  release(): void;
}

interface PgPool {
  query<T extends object = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PgResult<T>>;
  connect(): Promise<PgClient>;
  end(): Promise<void>;
}

/** One borrowed client. Callers own any transaction; this type only queries. */
export interface ApprovalClient {
  query<T extends object = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

interface PgModule {
  Pool: new (config: Record<string, unknown>) => PgPool;
}

/**
 * `pg` is a dependency of `@oikonomos/db`, not of this package (TASK-009).
 * `packages/db/src/approvals.ts` is outside this task's Owned_Paths, and
 * the barrel grant is consume-only, so invalidate/expire SQL live here
 * and resolve the driver from the sibling package.
 */
function loadPg(): PgModule {
  const requireFromDb = createRequire(
    fileURLToPath(new URL("../../db/package.json", import.meta.url)),
  );
  return requireFromDb("pg") as PgModule;
}

function requireConnectionString(options: DatabaseOptions): string {
  if (options.connectionString.trim().length === 0) {
    throw new Error("Database connectionString must not be empty.");
  }
  return options.connectionString;
}

async function withPool<T>(
  options: DatabaseOptions,
  fn: (pool: PgPool) => Promise<T>,
): Promise<T> {
  const connectionString = requireConnectionString(options);
  const { Pool } = loadPg();
  const pool = new Pool({
    connectionString,
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
 * Borrow one client from a short-lived pool. Caller owns any transaction;
 * this helper only guarantees `release()` and `pool.end()` on every path.
 */
export async function withApprovalClient<T>(
  options: DatabaseOptions,
  fn: (client: ApprovalClient) => Promise<T>,
): Promise<T> {
  return withPool(options, async (pool) => {
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  });
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

async function invalidateApproval(
  options: DatabaseOptions,
  nonce: string,
): Promise<ConsumeApprovalResult> {
  return withPool(options, async (pool) => {
    const result = await pool.query<ApprovalRow>(
      `${INVALIDATE_APPROVAL_SQL} RETURNING ${APPROVAL_COLUMNS}`,
      [nonce],
    );
    const rowCount = result.rowCount ?? 0;
    if (rowCount === 1 && result.rows[0] !== undefined) {
      return { rowCount: 1, approval: toApproval(result.rows[0]) };
    }
    if (rowCount > 1) {
      throw new Error(
        `invalidateApproval matched ${String(rowCount)} rows for one nonce; expected 0 or 1.`,
      );
    }
    return { rowCount: 0, approval: null };
  });
}

async function invalidatePendingApproval(
  options: DatabaseOptions,
  nonce: string,
): Promise<ConsumeApprovalResult> {
  return withPool(options, async (pool) => {
    const result = await pool.query<ApprovalRow>(
      `${INVALIDATE_PENDING_APPROVAL_SQL} RETURNING ${APPROVAL_COLUMNS}`,
      [nonce],
    );
    const rowCount = result.rowCount ?? 0;
    if (rowCount === 1 && result.rows[0] !== undefined) {
      return { rowCount: 1, approval: toApproval(result.rows[0]) };
    }
    if (rowCount > 1) {
      throw new Error(
        `invalidatePendingApproval matched ${String(rowCount)} rows for one nonce; expected 0 or 1.`,
      );
    }
    return { rowCount: 0, approval: null };
  });
}

async function runGuardedDecision(
  options: DatabaseOptions,
  sql: string,
  nonce: string,
  decidedBy: string,
): Promise<ConsumeApprovalResult> {
  return withPool(options, async (pool) => {
    const result = await pool.query<ApprovalRow>(
      `${sql} RETURNING ${APPROVAL_COLUMNS}`,
      [nonce, decidedBy],
    );
    const rowCount = result.rowCount ?? 0;
    if (rowCount === 1 && result.rows[0] !== undefined) {
      return { rowCount: 1, approval: toApproval(result.rows[0]) };
    }
    if (rowCount > 1) {
      throw new Error(
        `approval decision matched ${String(rowCount)} rows for one nonce; expected 0 or 1.`,
      );
    }
    return { rowCount: 0, approval: null };
  });
}

async function grantPendingApproval(
  options: DatabaseOptions,
  nonce: string,
  decidedBy: string,
): Promise<ConsumeApprovalResult> {
  return runGuardedDecision(options, GRANT_APPROVAL_SQL, nonce, decidedBy);
}

async function rejectPendingApproval(
  options: DatabaseOptions,
  nonce: string,
  decidedBy: string,
): Promise<ConsumeApprovalResult> {
  return runGuardedDecision(options, REJECT_APPROVAL_SQL, nonce, decidedBy);
}

async function expirePendingApprovals(
  options: DatabaseOptions,
  scope?: ExpirePendingScope,
): Promise<number> {
  return withPool(options, async (pool) => {
    if (scope !== undefined) {
      const result = await pool.query(`${EXPIRE_PENDING_SQL} AND run_id=$1`, [scope.runId]);
      return result.rowCount ?? 0;
    }
    const result = await pool.query(EXPIRE_PENDING_SQL);
    return result.rowCount ?? 0;
  });
}

/** Adapt db persistence to {@link ApprovalStore}. */
export function createDatabaseStore(options: DatabaseOptions): ApprovalStore {
  return {
    insert: (approval) => insertApproval(options, approval),
    getByNonce: (nonce) => getApprovalByNonce(options, nonce),
    consume: (nonce, binding) => consumeApproval(options, nonce, binding),
    invalidate: (nonce) => invalidateApproval(options, nonce),
    invalidatePending: (nonce) => invalidatePendingApproval(options, nonce),
    expirePending: (scope) => expirePendingApprovals(options, scope),
    grant: (nonce, decidedBy) => grantPendingApproval(options, nonce, decidedBy),
    reject: (nonce, decidedBy) => rejectPendingApproval(options, nonce, decidedBy),
  };
}
