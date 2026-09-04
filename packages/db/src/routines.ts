import { Pool, type QueryResultRow } from "pg";

import { defaultPoolConfig, type DatabaseOptions } from "./database.js";

/**
 * TASK-084 / Addendum F §3.4 (F7) — `role_routines` are D0 rows; firing
 * creates a task in the routine's lane and does not resume anything (F3).
 * A fire whose environment is down is recorded `missed`, never queued for
 * catch-up. See N12 note in roles.ts — `description` is not a concept in
 * this table, but the same "no exported helper makes an authorization
 * decision from advisory text" spirit applies to `definition`; nothing here
 * inspects it.
 */
export const routineLanes = ["user", "agent", "background"] as const;
export type RoutineLane = (typeof routineLanes)[number];

export const routineFireOutcomes = ["queued", "missed"] as const;
export type RoutineFireOutcome = (typeof routineFireOutcomes)[number];

export interface NewRoutine {
  roleId: string;
  tenantId?: string;
  name: string;
  schedule?: string | null;
  lane?: RoutineLane;
  enabled?: boolean;
  definition: Record<string, unknown>;
  /** Initial scheduler cursor, computed by the control API at creation time. */
  nextFireAt?: Date | null;
}

export interface Routine {
  routineId: string;
  roleId: string;
  tenantId: string;
  name: string;
  schedule: string | null;
  lane: RoutineLane;
  enabled: boolean;
  definition: Record<string, unknown>;
  lastFireAt: Date | null;
  nextFireAt: Date | null;
  lastFireStatus: RoutineFireOutcome | null;
}

interface RoutineRow extends QueryResultRow {
  routine_id: string;
  role_id: string;
  tenant_id: string;
  name: string;
  schedule: string | null;
  lane: RoutineLane;
  enabled: boolean;
  definition: Record<string, unknown>;
  last_fire_at: Date | null;
  next_fire_at: Date | null;
  last_fire_status: RoutineFireOutcome | null;
}

const routineColumns = `routine_id, role_id, tenant_id, name, schedule, lane, enabled,
       definition, last_fire_at, next_fire_at, last_fire_status`;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function requireLane(value: RoutineLane, field: string): RoutineLane {
  if (!routineLanes.includes(value)) {
    throw new Error(`${field} must be one of: ${routineLanes.join(", ")}.`);
  }
  return value;
}

function requireFireOutcome(value: RoutineFireOutcome, field: string): RoutineFireOutcome {
  if (!routineFireOutcomes.includes(value)) {
    throw new Error(`${field} must be one of: ${routineFireOutcomes.join(", ")}.`);
  }
  return value;
}

function toRoutine(row: RoutineRow): Routine {
  return {
    routineId: row.routine_id,
    roleId: row.role_id,
    tenantId: row.tenant_id,
    name: row.name,
    schedule: row.schedule,
    lane: row.lane,
    enabled: row.enabled,
    definition: row.definition,
    lastFireAt: row.last_fire_at,
    nextFireAt: row.next_fire_at,
    lastFireStatus: row.last_fire_status,
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

export async function createRoutine(
  options: DatabaseOptions,
  input: NewRoutine,
): Promise<Routine> {
  const roleId = requireNonEmpty(input.roleId, "roleId");
  const name = requireNonEmpty(input.name, "name");
  const lane = requireLane(input.lane ?? "background", "lane");

  return withPool(options, async (pool) => {
    const result = await pool.query<RoutineRow>(
      `INSERT INTO role_routines (role_id, tenant_id, name, schedule, lane, enabled, definition, next_fire_at)
       VALUES ($1, COALESCE($2, 'basileia'), $3, $4, $5, $6, $7::jsonb, $8)
       RETURNING ${routineColumns}`,
      [
        roleId,
        input.tenantId ?? null,
        name,
        input.schedule ?? null,
        lane,
        input.enabled ?? true,
        JSON.stringify(input.definition),
        input.nextFireAt ?? null,
      ],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("createRoutine did not return a persisted row.");
    }
    return toRoutine(row);
  });
}

export async function getRoutine(
  options: DatabaseOptions,
  routineId: string,
): Promise<Routine | null> {
  const normalizedRoutineId = requireUuid(routineId, "routineId");

  return withPool(options, async (pool) => {
    const result = await pool.query<RoutineRow>(
      `SELECT ${routineColumns} FROM role_routines WHERE routine_id = $1`,
      [normalizedRoutineId],
    );
    return result.rows[0] === undefined ? null : toRoutine(result.rows[0]);
  });
}

export interface RoutineListFilter {
  tenantId: string;
  roleId?: string;
  enabled?: boolean;
}

export async function listRoutines(
  options: DatabaseOptions,
  filter: RoutineListFilter,
): Promise<Routine[]> {
  const tenantId = requireNonEmpty(filter.tenantId, "tenantId");
  const conditions = ["tenant_id = $1"];
  const params: unknown[] = [tenantId];

  if (filter.roleId !== undefined) {
    params.push(requireNonEmpty(filter.roleId, "roleId"));
    conditions.push(`role_id = $${params.length}`);
  }
  if (filter.enabled !== undefined) {
    params.push(filter.enabled);
    conditions.push(`enabled = $${params.length}`);
  }

  return withPool(options, async (pool) => {
    const result = await pool.query<RoutineRow>(
      `SELECT ${routineColumns} FROM role_routines
       WHERE ${conditions.join(" AND ")}
       ORDER BY routine_id`,
      params,
    );
    return result.rows.map(toRoutine);
  });
}

/**
 * Record a fire attempt. `queued` bumps `last_fire_at` to now (the routine
 * actually produced a task in its lane). `missed` records the distinct
 * `missed` status WITHOUT bumping `last_fire_at` — Addendum F §3.4 is
 * explicit that a missed fire is never queued for catch-up, so the next
 * scheduled fire must not see a stale `last_fire_at` that makes it look
 * like the miss already happened. `next_fire_at`, when supplied, is always
 * written regardless of outcome — the scheduler (TASK-076) is responsible
 * for computing it from the routine's schedule.
 */
export async function recordRoutineFire(
  options: DatabaseOptions,
  routineId: string,
  outcome: RoutineFireOutcome,
  nextFireAt?: Date | null,
): Promise<Routine> {
  const normalizedRoutineId = requireUuid(routineId, "routineId");
  const normalizedOutcome = requireFireOutcome(outcome, "outcome");

  return withPool(options, async (pool) => {
    const result = await pool.query<RoutineRow>(
      normalizedOutcome === "queued"
        ? `UPDATE role_routines
           SET last_fire_at = now(), last_fire_status = $2, next_fire_at = COALESCE($3, next_fire_at)
           WHERE routine_id = $1
           RETURNING ${routineColumns}`
        : `UPDATE role_routines
           SET last_fire_status = $2, next_fire_at = COALESCE($3, next_fire_at)
           WHERE routine_id = $1
           RETURNING ${routineColumns}`,
      [normalizedRoutineId, normalizedOutcome, nextFireAt ?? null],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`recordRoutineFire: no role_routines row for routineId ${normalizedRoutineId}.`);
    }
    return toRoutine(row);
  });
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("@oikonomos/db routines — input validation (no DB required)", () => {
    const options: DatabaseOptions = { connectionString: "   " };

    it("rejects an empty connection string before opening a pool", async () => {
      await expect(
        createRoutine(options, { roleId: "r1", name: "n", definition: {} }),
      ).rejects.toThrow(/connectionString/);
      await expect(
        getRoutine(options, "11111111-1111-1111-1111-111111111111"),
      ).rejects.toThrow(/connectionString/);
      await expect(listRoutines(options, { tenantId: "basileia" })).rejects.toThrow(
        /connectionString/,
      );
      await expect(
        recordRoutineFire(options, "11111111-1111-1111-1111-111111111111", "queued"),
      ).rejects.toThrow(/connectionString/);
    });

    it("rejects a non-UUID routineId", async () => {
      const live: DatabaseOptions = { connectionString: "postgres://x" };
      await expect(getRoutine(live, "not-a-uuid")).rejects.toThrow(/UUID/);
      await expect(recordRoutineFire(live, "not-a-uuid", "queued")).rejects.toThrow(/UUID/);
    });

    it("rejects an invalid lane on createRoutine", async () => {
      await expect(
        createRoutine(
          { connectionString: "postgres://x" },
          { roleId: "r1", name: "n", definition: {}, lane: "urgent" as RoutineLane },
        ),
      ).rejects.toThrow(/lane/);
    });

    it("rejects an invalid outcome on recordRoutineFire", async () => {
      await expect(
        recordRoutineFire(
          { connectionString: "postgres://x" },
          "11111111-1111-1111-1111-111111111111",
          "done" as RoutineFireOutcome,
        ),
      ).rejects.toThrow(/outcome/);
    });

    it("rejects empty roleId/name on createRoutine and empty tenantId on listRoutines", async () => {
      const live: DatabaseOptions = { connectionString: "postgres://x" };
      await expect(
        createRoutine(live, { roleId: "   ", name: "n", definition: {} }),
      ).rejects.toThrow(/roleId/);
      await expect(
        createRoutine(live, { roleId: "r1", name: "   ", definition: {} }),
      ).rejects.toThrow(/name/);
      await expect(listRoutines(live, { tenantId: "   " })).rejects.toThrow(/tenantId/);
    });
  });
}
