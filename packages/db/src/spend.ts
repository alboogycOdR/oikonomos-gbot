import type { QueryResultRow } from "pg";

import { withPool, type DatabaseOptions } from "./database.js";

/**
 * TASK-143 / OIK-110/111 (narrowed scope: Codex/Grok subprocess path only —
 * see PLAN.md TASK-143's scope-narrowing decision). Records the real
 * per-turn spend `withBudgetSink` (packages/agent-providers) already
 * observes, so a routine's accumulated cost and the platform-wide monthly
 * ceiling can be read live at decision time (never cached/derived).
 *
 * The Claude-SDK chat path (`chatRunDriver.ts`) does not write here today —
 * that gap is real and tracked separately (TASK-163). Every row this module
 * writes comes from the Codex/Grok subprocess path only.
 */

export interface NewSpendRecord {
  tenantId?: string;
  /** Caller-supplied run identity (L1RunIdentity.runId); not a `runs` FK. */
  runId: string;
  /** Owning routine, when the run was fired from one. */
  routineId?: string | null;
  provider: string;
  model: string;
  costUsd: number;
  /** Token count for the turn, when the provider surfaces one (see BudgetReport.tokens). */
  tokens?: number | null;
  occurredAt?: Date;
}

export interface SpendRecord {
  spendId: string;
  tenantId: string;
  runId: string;
  routineId: string | null;
  provider: string;
  model: string;
  costUsd: number;
  tokens: number | null;
  occurredAt: Date;
}

interface SpendRecordRow extends QueryResultRow {
  spend_id: string;
  tenant_id: string;
  run_id: string;
  routine_id: string | null;
  provider: string;
  model: string;
  cost_usd: string | number;
  tokens: number | null;
  occurred_at: Date;
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${field} must not be empty.`);
  }
  return trimmed;
}

function requireFiniteNonNegative(value: number, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite number >= 0.`);
  }
  return value;
}

function requireNonNegativeIntegerOrNull(value: number | null | undefined, field: string): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer when provided.`);
  }
  return value;
}

function toSpendRecord(row: SpendRecordRow): SpendRecord {
  return {
    spendId: row.spend_id,
    tenantId: row.tenant_id,
    runId: row.run_id,
    routineId: row.routine_id,
    provider: row.provider,
    model: row.model,
    costUsd: typeof row.cost_usd === "string" ? Number.parseFloat(row.cost_usd) : row.cost_usd,
    tokens: row.tokens,
    occurredAt: row.occurred_at,
  };
}

/** UTC calendar-month boundary, used as the default platform-spend window. */
export function startOfCurrentMonthUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

/**
 * Append-only insert into spend_records. Write errors propagate to the
 * caller so `withBudgetSink`'s fail-closed contract (a throwing sink fails
 * the turn) is preserved end to end.
 */
export async function recordSpend(
  options: DatabaseOptions,
  entry: NewSpendRecord,
): Promise<SpendRecord> {
  const runId = requireNonEmpty(entry.runId, "runId");
  const provider = requireNonEmpty(entry.provider, "provider");
  const model = requireNonEmpty(entry.model, "model");
  const costUsd = requireFiniteNonNegative(entry.costUsd, "costUsd");
  const tokens = requireNonNegativeIntegerOrNull(entry.tokens, "tokens");
  const routineId =
    entry.routineId === undefined || entry.routineId === null || entry.routineId.trim().length === 0
      ? null
      : entry.routineId.trim();

  return withPool(options, async (pool) => {
    const result = await pool.query<SpendRecordRow>(
      `INSERT INTO spend_records (
         tenant_id, run_id, routine_id, provider, model, cost_usd, tokens, occurred_at
       )
       VALUES (
         COALESCE($1, 'basileia'),
         $2, $3, $4, $5, $6, $7,
         COALESCE($8, now())
       )
       RETURNING spend_id, tenant_id, run_id, routine_id, provider, model, cost_usd, tokens, occurred_at`,
      [
        entry.tenantId ?? null,
        runId,
        routineId,
        provider,
        model,
        costUsd,
        tokens,
        entry.occurredAt ?? null,
      ],
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("recordSpend did not return a persisted row.");
    }
    return toSpendRecord(row);
  });
}

/**
 * Live sum of a routine's accumulated spend, in USD, since `since`
 * (default: unbounded — the routine's whole lifetime). Fail-closed callers
 * (packages/broker) must treat a rejected promise as deny, never as zero.
 */
export async function getRoutineSpendUsd(
  options: DatabaseOptions,
  routineId: string,
  since?: Date,
): Promise<number> {
  const normalizedRoutineId = requireNonEmpty(routineId, "routineId");

  return withPool(options, async (pool) => {
    const result = await pool.query<{ total: string | null }>(
      since === undefined
        ? `SELECT COALESCE(SUM(cost_usd), 0)::text AS total FROM spend_records WHERE routine_id = $1`
        : `SELECT COALESCE(SUM(cost_usd), 0)::text AS total FROM spend_records WHERE routine_id = $1 AND occurred_at >= $2`,
      since === undefined ? [normalizedRoutineId] : [normalizedRoutineId, since],
    );
    return Number.parseFloat(result.rows[0]?.total ?? "0");
  });
}

/**
 * Live platform-wide spend, in USD, since `since` (default: start of the
 * current UTC calendar month — CLAUDE.md's ceiling is monthly). This is the
 * Codex/Grok inference-cost portion only (this task's documented narrowing);
 * hosting costs are out of scope and there is no telemetry for them yet.
 */
export async function getPlatformSpendUsd(
  options: DatabaseOptions,
  since: Date = startOfCurrentMonthUtc(),
): Promise<number> {
  return withPool(options, async (pool) => {
    const result = await pool.query<{ total: string | null }>(
      `SELECT COALESCE(SUM(cost_usd), 0)::text AS total FROM spend_records WHERE occurred_at >= $1`,
      [since],
    );
    return Number.parseFloat(result.rows[0]?.total ?? "0");
  });
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  // Validation-only: no live-DB assertions here, for the same reason
  // auditEvents.ts's inline block is validation-only — this module is
  // imported transitively via index.js by every other test file in the
  // package, so a live-DB test here would run once per importing file.
  // Live-DB coverage lives in spend.test.ts (a dedicated file).
  describe("@oikonomos/db spend — input validation (no DB required)", () => {
    const options: DatabaseOptions = { connectionString: "   " };

    it("rejects an empty connection string before opening a pool", async () => {
      await expect(
        recordSpend(options, { runId: "run-1", provider: "codex", model: "gpt-5.4", costUsd: 0.01 }),
      ).rejects.toThrow(/connectionString/);
    });

    it("rejects a negative costUsd", async () => {
      await expect(
        recordSpend(
          { connectionString: "postgres://x" },
          { runId: "run-1", provider: "codex", model: "gpt-5.4", costUsd: -1 },
        ),
      ).rejects.toThrow(/costUsd/);
    });

    it("rejects a non-integer tokens value", async () => {
      await expect(
        recordSpend(
          { connectionString: "postgres://x" },
          { runId: "run-1", provider: "codex", model: "gpt-5.4", costUsd: 1, tokens: 1.5 },
        ),
      ).rejects.toThrow(/tokens/);
    });

    it("rejects an empty runId", async () => {
      await expect(
        recordSpend(
          { connectionString: "postgres://x" },
          { runId: "   ", provider: "codex", model: "gpt-5.4", costUsd: 1 },
        ),
      ).rejects.toThrow(/runId/);
    });
  });

  describe("@oikonomos/db spend — startOfCurrentMonthUtc", () => {
    it("truncates to the first instant of the UTC calendar month", () => {
      const start = startOfCurrentMonthUtc(new Date("2026-09-05T18:12:36.500Z"));
      expect(start.toISOString()).toBe("2026-09-01T00:00:00.000Z");
    });
  });
}
