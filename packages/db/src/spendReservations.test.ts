import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { defaultPoolConfig, type DatabaseOptions } from "./database.js";
import { createProject } from "./projects.js";
import { recordSpend } from "./spend.js";
import { admitRunReservation, monthStartKey, releaseRunReservation } from "./spendReservations.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("packages/db spendReservations — atomic admission (TASK-300)", () => {
  let pool: Pool;
  const options: DatabaseOptions = { connectionString: connectionString! };
  const tenantId = `task-300-${randomUUID()}`;
  const tag = randomUUID().slice(0, 8);
  const roleIds: string[] = [];
  const projectIds: string[] = [];
  const threadIds: string[] = [];
  const month = monthStartKey().slice(0, 7);

  async function newRole(budget: number | null): Promise<string> {
    const roleId = `task-300-role-${tag}-${roleIds.length}`;
    await pool.query(
      "INSERT INTO roles (role_id, tenant_id, name, title, description, status, budget_usd) VALUES ($1, $2, $1, $1, '', 'active', $3)",
      [roleId, tenantId, budget],
    );
    roleIds.push(roleId);
    return roleId;
  }

  async function newProject(budget: number | null): Promise<string> {
    const thread = await pool.query<{ id: string }>(
      "INSERT INTO threads (role_id, title) VALUES (NULL, 'task-300') RETURNING id",
    );
    threadIds.push(thread.rows[0]!.id);
    const project = await createProject(options, {
      tenantId,
      threadId: thread.rows[0]!.id,
      name: "P",
      goal: "g",
      doneCriterion: "d",
      createdBy: "human:1",
    });
    await pool.query("UPDATE projects SET budget_usd = $2 WHERE project_id = $1", [project.projectId, budget]);
    projectIds.push(project.projectId);
    return project.projectId;
  }

  async function cleanup(): Promise<void> {
    await pool.query("DELETE FROM spend_reservations WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM spend_records WHERE run_id LIKE $1", [`task-300-${tag}%`]);
    await pool.query("DELETE FROM budget_ledgers WHERE axis_id = ANY($1) OR axis_id = ANY($2)", [projectIds, roleIds]);
    await pool.query("DELETE FROM projects WHERE project_id = ANY($1)", [projectIds]);
    await pool.query("DELETE FROM threads WHERE id = ANY($1)", [threadIds]);
    await pool.query("DELETE FROM roles WHERE role_id = ANY($1)", [roleIds]);
  }

  const run = (n: string) => `task-300-${tag}-${n}`;

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  /** Hold the ledger lock in a raw tx, start both admissions (both block on it), release: proves concurrency. */
  async function raceBehindLock(
    axis: "project" | "role",
    axisId: string,
    a: Parameters<typeof admitRunReservation>[1],
    b: Parameters<typeof admitRunReservation>[1],
  ) {
    await pool.query(
      "INSERT INTO budget_ledgers (axis, axis_id, month) VALUES ($1, $2, $3::date) ON CONFLICT DO NOTHING",
      [axis, axisId, monthStartKey(month)],
    );
    const holder = await pool.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM budget_ledgers WHERE axis = $1 AND axis_id = $2 FOR UPDATE", [axis, axisId]);
    const pa = admitRunReservation(options, a);
    const pb = admitRunReservation(options, b);
    let waiting = 0;
    for (let i = 0; i < 100 && waiting < 2; i += 1) {
      const r = await pool.query<{ n: string }>(
        "SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%FROM budget_ledgers%FOR UPDATE%' AND pid <> pg_backend_pid()",
      );
      waiting = Number(r.rows[0]!.n);
      if (waiting < 2) await new Promise((res) => setTimeout(res, 50));
    }
    expect(waiting).toBe(2); // both admissions are genuinely blocked concurrently
    await holder.query("COMMIT");
    holder.release();
    return Promise.all([pa, pb]);
  }

  it("project axis: two concurrent near-limit admissions -> exactly one admitted", async () => {
    const projectId = await newProject(10);
    const roleId = await newRole(null);
    const mk = (n: string) => ({ tenantId, runId: run(n), projectId, roleId, reserveUsd: 6, month });
    const results = await raceBehindLock("project", projectId, mk("p1"), mk("p2"));
    expect(results.filter((r) => r.admitted)).toHaveLength(1);
    expect(results.find((r) => !r.admitted)).toMatchObject({
      admitted: false,
      reason: "budget.project_exceeded",
      axis: "project",
    });
    const open = await pool.query(
      "SELECT 1 FROM spend_reservations WHERE axis='project' AND axis_id=$1 AND released_at IS NULL",
      [projectId],
    );
    expect(open.rowCount).toBe(1);
  });

  it("role axis: two concurrent near-limit admissions -> exactly one admitted", async () => {
    const roleId = await newRole(10);
    const mk = (n: string) => ({ tenantId, runId: run(n), projectId: null, roleId, reserveUsd: 6, month });
    const results = await raceBehindLock("role", roleId, mk("r1"), mk("r2"));
    expect(results.filter((r) => r.admitted)).toHaveLength(1);
    expect(results.find((r) => !r.admitted)).toMatchObject({
      admitted: false,
      reason: "budget.role_exceeded",
      axis: "role",
    });
  });

  it("open reservations and recorded spend both count against the ceiling", async () => {
    const roleId = await newRole(10);
    const base = { tenantId, projectId: null, roleId, month };
    expect((await admitRunReservation(options, { ...base, runId: run("c1"), reserveUsd: 4 })).admitted).toBe(true);
    // 4 open + 7 > 10
    expect(await admitRunReservation(options, { ...base, runId: run("c2"), reserveUsd: 7 })).toMatchObject({
      admitted: false,
      reason: "budget.role_exceeded",
    });
    // recording spend (routine_id carries the role) releases c1 and counts 8 as spent
    await recordSpend(options, { runId: run("c1"), routineId: roleId, provider: "codex", model: "m", costUsd: 8 });
    expect((await admitRunReservation(options, { ...base, runId: run("c3"), reserveUsd: 3 })).admitted).toBe(false);
    expect((await admitRunReservation(options, { ...base, runId: run("c4"), reserveUsd: 2 })).admitted).toBe(true);
  });

  it("releases exactly once; recordSpend releases in the same tx; a failed insert leaves it open", async () => {
    const roleId = await newRole(100);
    const base = { tenantId, projectId: null, roleId, month, reserveUsd: 5 };
    expect((await admitRunReservation(options, { ...base, runId: run("e1") })).admitted).toBe(true);

    await expect(
      recordSpend(options, {
        runId: run("e1"),
        routineId: roleId,
        provider: "codex",
        model: "m",
        costUsd: 1,
        tokens: 3_000_000_000,
      }),
    ).rejects.toThrow();
    const stillOpen = await pool.query("SELECT 1 FROM spend_reservations WHERE run_id=$1 AND released_at IS NULL", [
      run("e1"),
    ]);
    expect(stillOpen.rowCount).toBe(1);

    await recordSpend(options, { runId: run("e1"), routineId: roleId, provider: "codex", model: "m", costUsd: 1 });
    const afterSpend = await pool.query("SELECT 1 FROM spend_reservations WHERE run_id=$1 AND released_at IS NULL", [
      run("e1"),
    ]);
    expect(afterSpend.rowCount).toBe(0);
    expect(await releaseRunReservation(options, run("e1"))).toBe(false);

    await admitRunReservation(options, { ...base, runId: run("e2") });
    expect(await releaseRunReservation(options, run("e2"))).toBe(true);
    expect(await releaseRunReservation(options, run("e2"))).toBe(false);
  });

  it("NULL role budget and no project are admitted without touching ledgers", async () => {
    const roleId = await newRole(null);
    const result = await admitRunReservation(options, {
      tenantId,
      runId: run("n1"),
      projectId: null,
      roleId,
      reserveUsd: 1e6,
      month,
    });
    expect(result).toEqual({ admitted: true, reservations: [] });
    const ledgers = await pool.query("SELECT 1 FROM budget_ledgers WHERE axis_id = $1", [roleId]);
    expect(ledgers.rowCount).toBe(0);
  });
});
