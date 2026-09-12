import type { QueryResultRow } from "pg";

import type { ApprovalStatus } from "./approvals.js";
import { withPool, type DatabaseOptions } from "./database.js";
import type { MessageRole } from "./messages.js";
import type { RiskTier } from "./types.js";
import type { RunStatus } from "./runs.js";

export interface RunReceiptAction {
  capability: string | null;
  tier: RiskTier | null;
  verdict: string | null;
  reason: string | null;
}

export interface RunReceiptApproval {
  approvalId: string;
  capabilityId: string;
  actionRender: string;
  destination: string;
  status: ApprovalStatus;
  requestedAt: Date;
  decidedAt: Date | null;
  consumedAt: Date | null;
}

export type RunReceiptSpend =
  | { kind: "actual"; costUsd: number; tokens: number | null }
  | { kind: "unavailable" };

export interface RunReceipt {
  run: {
    runId: string;
    status: RunStatus;
    startedAt: Date;
    endedAt: Date | null;
    failureNote: string | null;
  };
  finalMessage: { id: string; body: string; createdAt: Date } | null;
  actions: RunReceiptAction[];
  approvals: RunReceiptApproval[];
  unresolvedApprovals: RunReceiptApproval[];
  spend: RunReceiptSpend;
}

interface RunRow extends QueryResultRow {
  run_id: string;
  status: RunStatus;
  started_at: Date;
  ended_at: Date | null;
  failure_note: string | null;
}

interface MessageRow extends QueryResultRow {
  id: string;
  body: string;
  created_at: Date;
  role: MessageRole;
}

interface AuditRow extends QueryResultRow {
  capability: string | null;
  tier: RiskTier | null;
  payload: Record<string, unknown>;
}

interface ApprovalRow extends QueryResultRow {
  approval_id: string;
  capability_id: string;
  action_render: string;
  destination: string;
  status: ApprovalStatus;
  requested_at: Date;
  decided_at: Date | null;
  consumed_at: Date | null;
}

interface SpendRow extends QueryResultRow {
  row_count: string | number;
  cost_usd: string | number | null;
  tokens: string | number | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(value: string, field: string): string {
  const normalized = value.trim();
  if (!UUID_RE.test(normalized)) throw new Error(`${field} must be a UUID.`);
  return normalized;
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${field} must not be empty.`);
  return normalized;
}

function optionalPayloadString(payload: Record<string, unknown>, field: "verdict" | "reason"): string | null {
  const value = payload[field];
  return typeof value === "string" ? value : null;
}

function toApproval(row: ApprovalRow): RunReceiptApproval {
  return {
    approvalId: row.approval_id,
    capabilityId: row.capability_id,
    actionRender: row.action_render,
    destination: row.destination,
    status: row.status,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at,
    consumedAt: row.consumed_at,
  };
}

/**
 * Read-only completion projection. Ownership is resolved through the run's
 * task, so a missing run and a foreign run are deliberately indistinguishable
 * to callers. Spend is unavailable when no ledger rows exist; it is never
 * estimated or represented as a fabricated zero.
 */
export async function getRunReceipt(
  options: DatabaseOptions,
  input: { runId: string; tenantId: string },
): Promise<RunReceipt | null> {
  const runId = requireUuid(input.runId, "runId");
  const tenantId = requireNonEmpty(input.tenantId, "tenantId");

  return withPool(options, async (pool) => {
    const runResult = await pool.query<RunRow>(
      `SELECT runs.run_id, runs.status, runs.started_at, runs.ended_at, runs.failure_note
       FROM runs
       INNER JOIN tasks ON tasks.task_id = runs.task_id
       WHERE runs.run_id = $1 AND tasks.tenant_id = $2`,
      [runId, tenantId],
    );
    const run = runResult.rows[0];
    if (run === undefined) return null;

    const [messageResult, auditResult, approvalResult, spendResult] = await Promise.all([
      pool.query<MessageRow>(
        `SELECT id, body, created_at, role
         FROM messages
         WHERE run_id = $1 AND role = 'bot'
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [runId],
      ),
      pool.query<AuditRow>(
        `SELECT capability, tier, payload
         FROM audit_events
         WHERE run_id = $1 AND tenant_id = $2
         ORDER BY at ASC, event_id ASC`,
        [runId, tenantId],
      ),
      pool.query<ApprovalRow>(
        `SELECT approval_id, capability_id, action_render, destination, status,
                requested_at, decided_at, consumed_at
         FROM approvals
         WHERE run_id = $1 AND tenant_id = $2
         ORDER BY requested_at ASC, approval_id ASC`,
        [runId, tenantId],
      ),
      pool.query<SpendRow>(
        `SELECT COUNT(*) AS row_count, SUM(cost_usd)::text AS cost_usd, SUM(tokens)::text AS tokens
         FROM spend_records
         WHERE run_id = $1 AND tenant_id = $2`,
        [runId, tenantId],
      ),
    ]);

    const finalMessageRow = messageResult.rows[0];
    const approvals = approvalResult.rows.map(toApproval);
    const spendRow = spendResult.rows[0];
    const spend: RunReceiptSpend = Number(spendRow?.row_count ?? 0) === 0
      ? { kind: "unavailable" }
      : {
          kind: "actual",
          costUsd: Number(spendRow?.cost_usd ?? 0),
          tokens: spendRow?.tokens === null || spendRow?.tokens === undefined ? null : Number(spendRow.tokens),
        };

    return {
      run: {
        runId: run.run_id,
        status: run.status,
        startedAt: run.started_at,
        endedAt: run.ended_at,
        failureNote: run.failure_note,
      },
      finalMessage: finalMessageRow === undefined
        ? null
        : { id: finalMessageRow.id, body: finalMessageRow.body, createdAt: finalMessageRow.created_at },
      actions: auditResult.rows.map((action) => ({
        capability: action.capability,
        tier: action.tier,
        verdict: optionalPayloadString(action.payload, "verdict"),
        reason: optionalPayloadString(action.payload, "reason"),
      })),
      approvals,
      unresolvedApprovals: approvals.filter((approval) => approval.status === "pending"),
      spend,
    };
  });
}
