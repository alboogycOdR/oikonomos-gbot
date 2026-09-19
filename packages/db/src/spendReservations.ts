import type { PoolClient, QueryResultRow } from "pg";

import { withPool, type DatabaseOptions } from "./database.js";

/**
 * TASK-300 / ADR-019 §5 / Project Workspace spec §6.2. Atomic admission for
 * the project and role budget axes. Amounts are USD exactly as ADR-019
 * specifies; no currency conversion happens in this layer.
 *
 * Role-axis recorded spend is derived run -> task -> role (TASK-315);
 * spend_records has no role column and routine_id stays the routine's own id.
 */
export type BudgetAxis = "project" | "role";
export type BudgetDenialReason = "budget.project_exceeded" | "budget.role_exceeded";

export interface AdmitRunReservationInput {
  tenantId: string;
  runId: string;
  projectId: string | null;
  roleId: string;
  reserveUsd: number;
  /** UTC month, `YYYY-MM` (or a Date, interpreted in UTC). Defaults to now. */
  month?: string | Date;
}

export interface AxisReservation {
  axis: BudgetAxis;
  axisId: string;
  reservationId: string;
}

export type AdmitRunReservationResult =
  | { admitted: true; reservations: AxisReservation[] }
  | { admitted: false; reason: BudgetDenialReason; axis: BudgetAxis };

/** UTC `YYYY-MM-01` first-of-month date string for a month key. */
export function monthStartKey(month?: string | Date): string {
  if (month instanceof Date || month === undefined) {
    const d = month ?? new Date();
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
  }
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month.trim());
  if (match === null) {
    throw new Error("month must be UTC YYYY-MM.");
  }
  return `${match[1]}-${match[2]}-01`;
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed.length === 0) {
    throw new Error(`${field} must not be empty.`);
  }
  return trimmed;
}

interface AxisPlan {
  axis: BudgetAxis;
  axisId: string;
  ceiling: number;
}

async function loadCeiling(client: PoolClient, axis: BudgetAxis, axisId: string): Promise<number | null> {
  const sql =
    axis === "project"
      ? "SELECT budget_usd FROM projects WHERE project_id::text = $1"
      : "SELECT budget_usd FROM roles WHERE role_id = $1";
  const result = await client.query<QueryResultRow & { budget_usd: string | null }>(sql, [axisId]);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`Unknown ${axis} "${axisId}" for budget admission.`);
  }
  return row.budget_usd === null ? null : Number(row.budget_usd);
}

async function committedUsd(client: PoolClient, axis: BudgetAxis, axisId: string, monthStart: string): Promise<number> {
  // Project spend is stamped on spend_records.project_id. A role's spend is
  // derived run -> task -> role (TASK-315): spend_records has no role column and
  // routine_id must stay the routine's own id. Join on text so a non-UUID run id
  // in spend_records can never raise a cast error.
  const recordedSql =
    axis === "project"
      ? `SELECT COALESCE(SUM(cost_usd), 0) FROM spend_records
         WHERE project_id = $1
           AND occurred_at >= $2::date AND occurred_at < ($2::date + interval '1 month')`
      : `SELECT COALESCE(SUM(s.cost_usd), 0) FROM spend_records s
         JOIN runs r ON r.run_id::text = s.run_id
         JOIN tasks t ON t.task_id = r.task_id
         WHERE t.role_id = $1
           AND s.occurred_at >= $2::date AND s.occurred_at < ($2::date + interval '1 month')`;
  const result = await client.query<QueryResultRow & { total: string }>(
    `SELECT
       (${recordedSql})
       +
       (SELECT COALESCE(SUM(reserved_usd), 0) FROM spend_reservations
         WHERE axis = $3 AND axis_id = $1 AND released_at IS NULL
           AND created_at >= $2::date AND created_at < ($2::date + interval '1 month')) AS total`,
    [axisId, monthStart, axis],
  );
  return Number(result.rows[0]?.total ?? 0);
}

/**
 * One transaction: lock the applicable ledger rows (project first, then role,
 * always in that order so concurrent admissions cannot deadlock), compare
 * recorded spend + open reservations + reserveUsd to each ceiling, and either
 * roll back with a typed denial or insert one reservation per axis.
 * Axes with no ceiling (role budget NULL, no project) are not touched.
 */
export async function admitRunReservation(
  options: DatabaseOptions,
  input: AdmitRunReservationInput,
): Promise<AdmitRunReservationResult> {
  const tenantId = requireNonEmpty(input.tenantId, "tenantId");
  const runId = requireNonEmpty(input.runId, "runId");
  const roleId = requireNonEmpty(input.roleId, "roleId");
  const projectId = input.projectId === null ? null : requireNonEmpty(input.projectId, "projectId");
  if (typeof input.reserveUsd !== "number" || !Number.isFinite(input.reserveUsd) || input.reserveUsd < 0) {
    throw new Error("reserveUsd must be a finite number >= 0.");
  }
  const monthStart = monthStartKey(input.month);

  return withPool(options, async (pool) => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const plans: AxisPlan[] = [];
      const candidates: Array<[BudgetAxis, string]> = [];
      if (projectId !== null) candidates.push(["project", projectId]);
      candidates.push(["role", roleId]);

      for (const [axis, axisId] of candidates) {
        const ceiling = await loadCeiling(client, axis, axisId);
        if (ceiling === null) continue;
        await client.query(
          "INSERT INTO budget_ledgers (axis, axis_id, month) VALUES ($1, $2, $3::date) ON CONFLICT DO NOTHING",
          [axis, axisId, monthStart],
        );
        await client.query(
          "SELECT 1 FROM budget_ledgers WHERE axis = $1 AND axis_id = $2 AND month = $3::date FOR UPDATE",
          [axis, axisId, monthStart],
        );
        plans.push({ axis, axisId, ceiling });
      }

      for (const plan of plans) {
        const used = await committedUsd(client, plan.axis, plan.axisId, monthStart);
        if (used + input.reserveUsd > plan.ceiling) {
          await client.query("ROLLBACK");
          return {
            admitted: false,
            reason: plan.axis === "project" ? "budget.project_exceeded" : "budget.role_exceeded",
            axis: plan.axis,
          } as const;
        }
      }

      const reservations: AxisReservation[] = [];
      for (const plan of plans) {
        const inserted = await client.query<QueryResultRow & { reservation_id: string }>(
          `INSERT INTO spend_reservations (tenant_id, axis, axis_id, run_id, reserved_usd)
           VALUES ($1, $2, $3, $4, $5) RETURNING reservation_id`,
          [tenantId, plan.axis, plan.axisId, runId, input.reserveUsd],
        );
        const row = inserted.rows[0];
        if (row === undefined) throw new Error("admitRunReservation did not persist a reservation.");
        reservations.push({ axis: plan.axis, axisId: plan.axisId, reservationId: row.reservation_id });
      }
      await client.query("COMMIT");
      return { admitted: true, reservations };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  });
}

/** Release a run's open reservations exactly once. Returns whether any were released. */
export async function releaseRunReservation(options: DatabaseOptions, runId: string): Promise<boolean> {
  const id = requireNonEmpty(runId, "runId");
  return withPool(options, async (pool) => {
    const result = await pool.query(
      "UPDATE spend_reservations SET released_at = now() WHERE run_id = $1 AND released_at IS NULL",
      [id],
    );
    return (result.rowCount ?? 0) > 0;
  });
}
