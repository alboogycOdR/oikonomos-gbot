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
  const taskIds: string[] = [];
  const spendRunIds: string[] = [];
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
    await pool.query("DELETE FROM spend_records WHERE run_id = ANY($1)", [spendRunIds]);
    await pool.query("DELETE FROM runs WHERE run_id = ANY($1)", [spendRunIds]);
    await pool.query("DELETE FROM tasks WHERE task_id = ANY($1)", [taskIds]);
    await pool.query("DELETE FROM budget_ledgers WHERE axis_id = ANY($1) OR axis_id = ANY($2)", [projectIds, roleIds]);
    await pool.query("DELETE FROM projects WHERE project_id = ANY($1)", [projectIds]);
    await pool.query("DELETE FROM threads WHERE id = ANY($1)", [threadIds]);
    await pool.query("DELETE FROM roles WHERE role_id = ANY($1)", [roleIds]);
  }

  /** A task + run for a role; returns the run id (a uuid) for recordSpend. */
  async function newRun(roleId: string | null): Promise<string> {
    let taskId: string | null = null;
    if (roleId !== null) {
      const t = await pool.query<{ task_id: string }>(
        "INSERT INTO tasks (tenant_id, role_id, title, goal, requested_by) VALUES ($1, $2, 't', 'g', 'human:1') RETURNING task_id",
        [tenantId, roleId],
      );
      taskId = t.rows[0]!.task_id;
      taskIds.push(taskId);
    } else {
      const t = await pool.query<{ task_id: string }>(
        "INSERT INTO tasks (tenant_id, role_id, title, goal, requested_by) VALUES ($1, 'no-role', 't', 'g', 'human:1') RETURNING task_id",
        [tenantId],
      );
      taskId = t.rows[0]!.task_id;
      taskIds.push(taskId);
    }
    const r = await pool.query<{ run_id: string }>(
      "INSERT INTO runs (task_id, tenant_id, provider) VALUES ($1, $2, 'codex') RETURNING run_id",
      [taskId, tenantId],
    );
    spendRunIds.push(r.rows[0]!.run_id);
    return r.rows[0]!.run_id;
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
    const c1 = await newRun(roleId);
    expect((await admitRunReservation(options, { ...base, runId: c1, reserveUsd: 4 })).admitted).toBe(true);
    // 4 open + 7 > 10
    expect(await admitRunReservation(options, { ...base, runId: run("c2"), reserveUsd: 7 })).toMatchObject({
      admitted: false,
      reason: "budget.role_exceeded",
    });
    // recording spend on a real run of the role releases c1 and counts 8 as spent
    await recordSpend(options, { runId: c1, routineId: null, provider: "codex", model: "m", costUsd: 8 });
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

  it("TASK-315: role spend is derived run->task->role; plain-chat (routine_id null) spend counts", async () => {
    const roleId = await newRole(5);
    const runId = await newRun(roleId);
    // Same call shape chat runs use: routineId null.
    await recordSpend(options, { runId, routineId: null, provider: "codex", model: "m", costUsd: 4.5 });
    expect(
      await admitRunReservation(options, { tenantId, runId: run("t1"), projectId: null, roleId, reserveUsd: 1, month }),
    ).toMatchObject({ admitted: false, reason: "budget.role_exceeded", axis: "role" });
  });

  it("TASK-315: a routine run's spend also counts, and routine_id is left alone", async () => {
    const roleId = await newRole(5);
    const runId = await newRun(roleId);
    const rec = await recordSpend(options, { runId, routineId: "routine-x", provider: "codex", model: "m", costUsd: 4.5 });
    expect(rec.routineId).toBe("routine-x");
    expect((await admitRunReservation(options, { tenantId, runId: run("t2"), projectId: null, roleId, reserveUsd: 1, month })).admitted).toBe(false);
  });

  it("TASK-315: other roles' spend, task-less runs and non-UUID run ids are not counted and do not raise", async () => {
    const roleId = await newRole(5);
    const other = await newRole(50);
    await recordSpend(options, { runId: await newRun(other), routineId: null, provider: "codex", model: "m", costUsd: 100 });
    await recordSpend(options, { runId: run("not-a-uuid"), routineId: roleId, provider: "codex", model: "m", costUsd: 100 });
    const tasklessRunId = randomUUID();
    spendRunIds.push(tasklessRunId);
    await recordSpend(options, { runId: tasklessRunId, routineId: null, provider: "codex", model: "m", costUsd: 100 });
    expect((await admitRunReservation(options, { tenantId, runId: run("t3"), projectId: null, roleId, reserveUsd: 5, month })).admitted).toBe(true);
  });
});
