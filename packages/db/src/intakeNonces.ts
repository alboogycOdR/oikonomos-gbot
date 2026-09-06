import type { QueryResultRow } from "pg";

import { withPool, type DatabaseOptions } from "./database.js";

/**
 * TASK-075 — intake idempotency ledger (nonce + input-digest binding).
 * Reference: docs/STUDY-grok-bot-018.md §Tier 2 (prompt-acceptance ledger),
 * Directive §4 N8 spirit. `db primitive only` — control-api/gateway wiring
 * (setting `task_id`, transitioning `status` on rejection) is a follow-up
 * task; this module deliberately does not attempt it.
 *
 * Digest discipline (N10): `inputDigest` is always computed by the CALLER
 * via `@oikonomos/shared`'s `actionDigest`/`canonicalJson` — never inside
 * this module. This module only stores and compares the resulting hex
 * string; it has no reason to import a hashing module and must not.
 *
 * v1 has no eviction policy — rows are kept indefinitely, so the study's
 * `unknown-durability` lookup outcome does not apply here; `lookupIntake`
 * is a plain `found | not-found` tri-state is therefore just a nullable
 * return, not a three-branch union.
 */

export type IntakeAdmitStatus = "dispatch" | "duplicate";

export interface IntakeNonceRecord {
  readonly intakeId: string;
  readonly tenantId: string;
  readonly clientNonce: string;
  readonly inputDigest: string;
  readonly status: string;
  readonly taskId: string | null;
  readonly createdAt: Date;
}

export interface AdmitIntakeParams {
  tenantId?: string;
  clientNonce: string;
  inputDigest: string;
}

export interface AdmitIntakeResult {
  readonly status: IntakeAdmitStatus;
  readonly record: IntakeNonceRecord;
}

export interface LookupIntakeParams {
  tenantId?: string;
  clientNonce: string;
}

interface IntakeNonceRow extends QueryResultRow {
  intake_id: string;
  tenant_id: string;
  client_nonce: string;
  input_digest: string;
  status: string;
  task_id: string | null;
  created_at: Date;
}

const intakeNonceColumns = `intake_id, tenant_id, client_nonce, input_digest,
       status, task_id, created_at`;

/**
 * Thrown when a `client_nonce` that was already admitted is replayed with a
 * DIFFERENT `input_digest`. This is never silently deduped: an
 * identical-looking retry (same digest) is safe and returns `duplicate`;
 * a content-swapped retry (different digest) is an attack or a bug and
 * must surface as an error instead.
 */
export class IntakeDigestMismatchError extends Error {
  readonly code = "INTAKE_DIGEST_MISMATCH";
  readonly clientNonce: string;
  readonly expectedDigest: string;
  readonly actualDigest: string;

  constructor(clientNonce: string, expectedDigest: string, actualDigest: string) {
    super(
      `Intake nonce "${clientNonce}" was already admitted with a different ` +
        `input_digest (expected ${expectedDigest}, got ${actualDigest}). ` +
        `Identical retries are safe; content-swapped retries are not.`,
    );
    this.name = "IntakeDigestMismatchError";
    this.clientNonce = clientNonce;
    this.expectedDigest = expectedDigest;
    this.actualDigest = actualDigest;
  }
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${field} must not be empty.`);
  }
  return trimmed;
}

function toIntakeNonceRecord(row: IntakeNonceRow): IntakeNonceRecord {
  return {
    intakeId: row.intake_id,
    tenantId: row.tenant_id,
    clientNonce: row.client_nonce,
    inputDigest: row.input_digest,
    status: row.status,
    taskId: row.task_id,
    createdAt: row.created_at,
  };
}

/**
 * Admit a task-intake attempt, keyed on `(tenantId, clientNonce)`.
 *
 * The write is one atomic statement — `INSERT ... ON CONFLICT (tenant_id,
 * client_nonce) DO NOTHING RETURNING ...` — so under concurrent calls with
 * the same nonce, Postgres's unique index guarantees exactly one call wins
 * the insert (`dispatch`); every other concurrent or later call observes
 * the conflict and falls through to the read path (`duplicate`).
 *
 * On conflict, the existing row's `input_digest` is compared against the
 * caller's: a match returns `duplicate` (safe replay, including the
 * original `taskId`/`status` so the caller can replay whatever outcome —
 * including a rejection — the original attempt had); a mismatch throws
 * {@link IntakeDigestMismatchError} instead of ever returning a result.
 */
export async function admitIntake(
  options: DatabaseOptions,
  params: AdmitIntakeParams,
): Promise<AdmitIntakeResult> {
  const clientNonce = requireNonEmpty(params.clientNonce, "clientNonce");
  const inputDigest = requireNonEmpty(params.inputDigest, "inputDigest");
  const tenantId =
    params.tenantId === undefined ? null : requireNonEmpty(params.tenantId, "tenantId");

  return withPool(options, async (pool) => {
    const inserted = await pool.query<IntakeNonceRow>(
      `INSERT INTO intake_nonces (tenant_id, client_nonce, input_digest)
       VALUES (COALESCE($1, 'basileia'), $2, $3)
       ON CONFLICT (tenant_id, client_nonce) DO NOTHING
       RETURNING ${intakeNonceColumns}`,
      [tenantId, clientNonce, inputDigest],
    );

    const insertedRow = inserted.rows[0];
    if (insertedRow !== undefined) {
      return { status: "dispatch" as const, record: toIntakeNonceRecord(insertedRow) };
    }

    const existing = await pool.query<IntakeNonceRow>(
      `SELECT ${intakeNonceColumns}
       FROM intake_nonces
       WHERE tenant_id = COALESCE($1, 'basileia') AND client_nonce = $2`,
      [tenantId, clientNonce],
    );
    const existingRow = existing.rows[0];
    if (existingRow === undefined) {
      // The conflicting row vanished between the INSERT and this SELECT —
      // only possible via an out-of-band DELETE, which no code path in
      // this platform performs (intake_nonces is append-only in v1).
      throw new Error(
        `admitIntake observed a conflict for nonce "${clientNonce}" but the row is gone.`,
      );
    }
    if (existingRow.input_digest !== inputDigest) {
      throw new IntakeDigestMismatchError(clientNonce, existingRow.input_digest, inputDigest);
    }
    return { status: "duplicate" as const, record: toIntakeNonceRecord(existingRow) };
  });
}

/**
 * Look up an intake attempt by `(tenantId, clientNonce)`. Returns `null`
 * when not found — v1 keeps every row (no eviction policy), so there is no
 * separate "evicted/unknown-durability" outcome to model.
 */
export async function lookupIntake(
  options: DatabaseOptions,
  params: LookupIntakeParams,
): Promise<IntakeNonceRecord | null> {
  const clientNonce = requireNonEmpty(params.clientNonce, "clientNonce");
  const tenantId =
    params.tenantId === undefined ? null : requireNonEmpty(params.tenantId, "tenantId");

  return withPool(options, async (pool) => {
    const result = await pool.query<IntakeNonceRow>(
      `SELECT ${intakeNonceColumns}
       FROM intake_nonces
       WHERE tenant_id = COALESCE($1, 'basileia') AND client_nonce = $2`,
      [tenantId, clientNonce],
    );
    const row = result.rows[0];
    return row === undefined ? null : toIntakeNonceRecord(row);
  });
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  // Validation-only: no live-DB assertions here, same rationale as
  // approvals.ts's sibling block (this module is transitively imported by
  // every other package/db test file once wired into index.ts; kept
  // isolated here to avoid concurrent live-DB churn on shared rows).
  describe("@oikonomos/db intakeNonces — input validation (no DB required)", () => {
    const options: DatabaseOptions = { connectionString: "   " };

    it("rejects an empty connection string before opening a pool", async () => {
      await expect(
        admitIntake(options, { clientNonce: "n1", inputDigest: "d1" }),
      ).rejects.toThrow(/connectionString/);
    });

    it("rejects an empty clientNonce", async () => {
      await expect(
        admitIntake(
          { connectionString: "postgres://x" },
          { clientNonce: "   ", inputDigest: "d1" },
        ),
      ).rejects.toThrow(/clientNonce/);
    });

    it("rejects an empty inputDigest", async () => {
      await expect(
        admitIntake(
          { connectionString: "postgres://x" },
          { clientNonce: "n1", inputDigest: "   " },
        ),
      ).rejects.toThrow(/inputDigest/);
    });

    it("rejects an empty tenantId override", async () => {
      await expect(
        admitIntake(
          { connectionString: "postgres://x" },
          { clientNonce: "n1", inputDigest: "d1", tenantId: "  " },
        ),
      ).rejects.toThrow(/tenantId/);
    });
  });
}
