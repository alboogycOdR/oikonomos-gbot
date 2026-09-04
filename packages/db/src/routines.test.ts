import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createRole,
  createRoutine,
  defaultPoolConfig,
  getRoutine,
  listRoutines,
  recordRoutineFire,
} from "./index.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("packages/db routines — read + CRUD + FK + fire bookkeeping (TASK-084)", () => {
  let pool: Pool;
  const tenantId = "task-084-routines-suite";
  const roleId = "task-084-routines-suite-role";

  async function cleanup(): Promise<void> {
    await pool.query(`DELETE FROM tasks WHERE tenant_id = $1`, [tenantId]);
    await pool.query(`DELETE FROM role_routines WHERE role_id = $1`, [roleId]);
    await pool.query(`DELETE FROM roles WHERE role_id = $1`, [roleId]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await cleanup();
    await createRole(
      { connectionString: connectionString! },
      { roleId, tenantId, name: "Routines Suite", title: "Routines Suite Role" },
    );
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("creates a routine against the live schema and reads it back byte-identical", async () => {
    const created = await createRoutine(
      { connectionString: connectionString! },
      { roleId, tenantId, name: "daily-digest", schedule: "0 8 * * *", definition: { steps: ["a"] } },
    );

    expect(created.lane).toBe("background");
    expect(created.enabled).toBe(true);
    expect(created.lastFireStatus).toBeNull();
    expect(created.nextFireAt).toBeNull();

    const fetched = await getRoutine({ connectionString: connectionString! }, created.routineId);
    expect(fetched).toEqual(created);
  });

  it("persists a creation-time nextFireAt without recording a fire", async () => {
    const nextFireAt = new Date("2030-01-02T03:04:00.000Z");
    const created = await createRoutine(
      { connectionString: connectionString! },
      { roleId, tenantId, name: "scheduled", schedule: "4 3 2 1 *", definition: {}, nextFireAt },
    );
    expect(created.nextFireAt).toEqual(nextFireAt);
    expect(created.lastFireAt).toBeNull();
    expect(created.lastFireStatus).toBeNull();
  });

  it("getRoutine returns null for an unknown routineId", async () => {
    const result = await getRoutine(
      { connectionString: connectionString! },
      "00000000-0000-0000-0000-000000000000",
    );
    expect(result).toBeNull();
  });

  it("listRoutines is tenant-scoped: a routine in another tenant never appears", async () => {
    const otherRoleId = "task-084-routines-suite-other-role";
    await createRole(
      { connectionString: connectionString! },
      { roleId: otherRoleId, tenantId: "task-084-routines-suite-OTHER", name: "x", title: "x" },
    );
    const other = await createRoutine(
      { connectionString: connectionString! },
      {
        roleId: otherRoleId,
        tenantId: "task-084-routines-suite-OTHER",
        name: "other-tenant-routine",
        definition: {},
      },
    );

    const rows = await listRoutines({ connectionString: connectionString! }, { tenantId });
    expect(rows.map((r) => r.routineId)).not.toContain(other.routineId);

    await pool.query(`DELETE FROM role_routines WHERE routine_id = $1`, [other.routineId]);
    await pool.query(`DELETE FROM roles WHERE role_id = $1`, [otherRoleId]);
  });

  it("F7: tasks.routine_id FK rejects a task for a routine that does not exist", async () => {
    await expect(
      pool.query(
        `INSERT INTO tasks (tenant_id, role_id, title, goal, routine_id, requested_by)
         VALUES ($1, $2, 't', 'g', $3, 'alister')`,
        [tenantId, roleId, "00000000-0000-0000-0000-000000000000"],
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("F3/§3.4: a missed fire is recorded distinctly from a queued fire, and does not advance last_fire_at", async () => {
    const routine = await createRoutine(
      { connectionString: connectionString! },
      { roleId, tenantId, name: "fire-bookkeeping", definition: {} },
    );
    expect(routine.lastFireAt).toBeNull();
    expect(routine.lastFireStatus).toBeNull();

    const missed = await recordRoutineFire(
      { connectionString: connectionString! },
      routine.routineId,
      "missed",
    );
    expect(missed.lastFireStatus).toBe("missed");
    // Never queued for catch-up (Addendum F §3.4): last_fire_at stays null,
    // proving the miss did not get treated as if the routine had fired.
    expect(missed.lastFireAt).toBeNull();

    const queued = await recordRoutineFire(
      { connectionString: connectionString! },
      routine.routineId,
      "queued",
    );
    expect(queued.lastFireStatus).toBe("queued");
    expect(queued.lastFireAt).not.toBeNull();

    // A subsequent miss after a real fire still flips the status distinctly
    // and does not silently revert to "queued" or clear the timestamp.
    const missedAfterQueued = await recordRoutineFire(
      { connectionString: connectionString! },
      routine.routineId,
      "missed",
    );
    expect(missedAfterQueued.lastFireStatus).toBe("missed");
    expect(missedAfterQueued.lastFireAt).toEqual(queued.lastFireAt);
  });

  it("recordRoutineFire throws for an unknown routineId", async () => {
    await expect(
      recordRoutineFire(
        { connectionString: connectionString! },
        "00000000-0000-0000-0000-000000000000",
        "queued",
      ),
    ).rejects.toThrow(/no role_routines row/);
  });
});
