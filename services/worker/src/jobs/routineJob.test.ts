import {
  createProject,
  createProjectArtifact,
  createRole,
  getOrCreateThreadForRole,
  getRoutine,
  createRoutine,
  createSkill,
  defaultPoolConfig,
  getRoutineSpendUsd,
  listMessages,
  listEnabledForRole,
  listTasks,
  setEnabledForRole,
  setRoutinePaused,
  recordRoutineFire,
} from "@oikonomos/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assembleSystemPrompt } from "../promptAssembly.js";
import { purgePgBossQueue, withPgBossQueueLock } from "./pgBossTestCleanup.js";
import { runDueRoutinePoll } from "./routineJob.js";
import { WORKER_RUN_EXECUTION_JOB } from "./workerJobQueue.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("routine parity poller (TASK-182)", () => {
  let pool: Pool;
  const tenantId = `task-182-routine-poller-${crypto.randomUUID()}`;

  beforeAll(() => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
  });

  afterAll(async () => {
    // TASK-258: a scheduled fire now atomically creates a real `runs` row
    // alongside its task, so cleanup must delete the dependent `runs` row
    // first — deleting `tasks` directly would violate `runs_task_id_fkey`.
    // Messages can reference both a run and the role-owned thread.  Remove
    // them before either parent so routine-fire notices and queued-run output
    // cannot make this suite's cleanup depend on FK timing.
    await pool.query(
      `DELETE FROM messages
       WHERE run_id IN (SELECT run_id FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE tenant_id = $1))
          OR thread_id IN (SELECT id FROM threads WHERE role_id IN (SELECT role_id FROM roles WHERE tenant_id = $1))`,
      [tenantId],
    );
    await pool.query(`DELETE FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE tenant_id = $1)`, [tenantId]);
    await pool.query(`DELETE FROM tasks WHERE tenant_id = $1`, [tenantId]);
    await pool.query(`DELETE FROM role_routines WHERE tenant_id = $1`, [tenantId]);
    await pool.query(`DELETE FROM role_skills WHERE role_id IN (SELECT role_id FROM roles WHERE tenant_id = $1)`, [tenantId]);
    // TASK-258: a scheduled fire now also gets-or-creates the role's own
    // thread (`getOrCreateThreadForRole`), so that must be cleared before
    // the role itself — deleting `roles` directly would violate
    // `threads_role_id_fkey`.
    await pool.query(`DELETE FROM project_artifacts WHERE project_id IN (SELECT project_id FROM projects WHERE tenant_id = $1)`, [tenantId]);
    await pool.query(`DELETE FROM projects WHERE tenant_id = $1`, [tenantId]);
    await pool.query(`DELETE FROM threads WHERE role_id IN (SELECT role_id FROM roles WHERE tenant_id = $1)`, [tenantId]);
    await pool.query(`DELETE FROM roles WHERE tenant_id = $1`, [tenantId]);
    await pool.query(`DELETE FROM skills WHERE tenant_id = $1`, [tenantId]);
    await pool.end();
  });

  it("records an ungranted input as stopped without provider spend or a task", async () => {
    const roleId = `task-182-stopped-${crypto.randomUUID()}`;
    await createRole({ connectionString: connectionString! }, { roleId, tenantId, name: "Stopped", title: "Stopped" });
    const routine = await createRoutine({ connectionString: connectionString! }, {
      roleId,
      tenantId,
      name: "Unavailable input",
      definition: { inputs: ["connector.not-granted"], goal: "This must not run" },
      nextFireAt: new Date(Date.now() - 1_000),
    });

    await expect(runDueRoutinePoll({ connectionString: connectionString!, tenantId })).resolves.toContainEqual({
      routineId: routine.routineId,
      outcome: "stopped",
    });
    const fires = await pool.query<{ outcome: string; reason: string }>(
      `SELECT outcome, reason FROM routine_runs WHERE routine_id = $1`,
      [routine.routineId],
    );
    expect(fires.rows).toContainEqual(expect.objectContaining({ outcome: "stopped", reason: expect.stringMatching(/not granted or available/) }));
    expect((await listTasks({ connectionString: connectionString! }, { tenantId })).tasks).toHaveLength(0);
    expect(await getRoutineSpendUsd({ connectionString: connectionString! }, routine.routineId)).toBe(0);
  });

  it("records a paused routine as skipped without creating a task", async () => {
    const roleId = `task-182-paused-${crypto.randomUUID()}`;
    await createRole({ connectionString: connectionString! }, { roleId, tenantId, name: "Paused", title: "Paused" });
    const routine = await createRoutine({ connectionString: connectionString! }, {
      roleId,
      tenantId,
      name: "Paused routine",
      definition: { goal: "This must not run" },
      nextFireAt: new Date(Date.now() - 1_000),
    });
    await setRoutinePaused({ connectionString: connectionString! }, routine.routineId, true);

    await expect(runDueRoutinePoll({ connectionString: connectionString!, tenantId })).resolves.toContainEqual({
      routineId: routine.routineId,
      outcome: "skipped_paused",
    });
    const fires = await pool.query<{ outcome: string }>(`SELECT outcome FROM routine_runs WHERE routine_id = $1`, [routine.routineId]);
    expect(fires.rows).toContainEqual({ outcome: "skipped_paused" });
    expect((await listTasks({ connectionString: connectionString! }, { tenantId })).tasks).toHaveLength(0);
  });

  it("TASK-329: notifies on a first failure, ignores missed fires, resets on success, then pauses on the tenth failure", async () => {
    await withPgBossQueueLock(pool, async () => {
      await purgePgBossQueue(pool, WORKER_RUN_EXECUTION_JOB);
      const db = { connectionString: connectionString! };
      const roleId = `task-329-fatigue-${crypto.randomUUID()}`;
      await createRole(db, { roleId, tenantId, name: "Fatigue", title: "Fatigue" });
      const routine = await createRoutine(db, {
        roleId, tenantId, name: "Watch source", definition: { inputs: ["missing.task-329.source"] },
        nextFireAt: new Date(Date.now() - 1_000),
      });
      const thread = await getOrCreateThreadForRole(db, { roleId });
      const messages = async () => (await listMessages(db, thread.id)).filter((message) => message.body.includes('Routine "Watch source"'));

      await expect(runDueRoutinePoll({ ...db, tenantId })).resolves.toContainEqual({ routineId: routine.routineId, outcome: "stopped" });
      expect(await messages()).toHaveLength(1);

      // Misses are deliberately ignored by the fatigue streak; the second
      // stop remains a later failure and must not create another notice.
      await recordRoutineFire(db, routine.routineId, "missed");
      await expect(runDueRoutinePoll({ ...db, tenantId })).resolves.toContainEqual({ routineId: routine.routineId, outcome: "stopped" });
      expect(await messages()).toHaveLength(1);

      // A successful queued fire resets the streak. Reconfigure only this
      // test fixture, then the next failure is visibly a new first failure.
      await pool.query(`UPDATE role_routines SET definition = $2::jsonb WHERE routine_id = $1`, [routine.routineId, JSON.stringify({ goal: "recover" })]);
      await expect(runDueRoutinePoll({ ...db, tenantId })).resolves.toContainEqual({ routineId: routine.routineId, outcome: "queued" });
      await pool.query(`UPDATE role_routines SET definition = $2::jsonb WHERE routine_id = $1`, [routine.routineId, JSON.stringify({ inputs: ["missing.task-329.source"] })]);

      await expect(runDueRoutinePoll({ ...db, tenantId })).resolves.toContainEqual({ routineId: routine.routineId, outcome: "stopped" });
      expect(await messages()).toHaveLength(2);
      for (let attempt = 2; attempt <= 10; attempt += 1) {
        await expect(runDueRoutinePoll({ ...db, tenantId })).resolves.toContainEqual({ routineId: routine.routineId, outcome: "stopped" });
      }

      // This is the liveness assertion: without the pause rule, a tenth
      // failure leaves the routine live and this persisted state is false.
      expect((await getRoutine(db, routine.routineId))?.paused).toBe(true);
      expect(await messages()).toHaveLength(3);
      expect((await messages()).at(-1)?.body).toContain("paused after 10 consecutive failures");
      await expect(runDueRoutinePoll({ ...db, tenantId })).resolves.toContainEqual({ routineId: routine.routineId, outcome: "skipped_paused" });
      expect(await messages()).toHaveLength(3);
      await purgePgBossQueue(pool, WORKER_RUN_EXECUTION_JOB);
    });
  }, 20_000);

  it("carries a bound skill token into the assembled prompt's skill block", async () => {
    await withPgBossQueueLock(pool, async () => {
      const roleId = `task-182-skill-${crypto.randomUUID()}`;
      const role = await createRole({ connectionString: connectionString! }, { roleId, tenantId, name: "Skill role", title: "Skill role" });
      const skill = await createSkill({ connectionString: connectionString! }, {
        tenantId,
        name: "weekly-export",
        description: "Exports a weekly report",
        body: "Gather the week's data and export it.",
      });
      await setEnabledForRole({ connectionString: connectionString! }, roleId, skill.skillId, true);
      const routine = await createRoutine({ connectionString: connectionString! }, {
        roleId,
        tenantId,
        name: "Weekly export",
        skillId: skill.skillId,
        definition: { goal: "Export this week's report" },
        nextFireAt: new Date(Date.now() - 1_000),
      });

      await expect(runDueRoutinePoll({ connectionString: connectionString!, tenantId })).resolves.toContainEqual({
        routineId: routine.routineId,
        outcome: "queued",
      });
      const task = (await listTasks({ connectionString: connectionString! }, { tenantId })).tasks.find((candidate) => candidate.routineId === routine.routineId);
      expect(task?.goal).toBe("/weekly-export Export this week's report");
      const enabledSkills = await listEnabledForRole({ connectionString: connectionString! }, roleId);
      const prompt = await assembleSystemPrompt({
        role,
        fallbackRoleId: roleId,
        message: task!.goal,
        resolveEnabledSkill: async (name) => enabledSkills.find((candidate) => candidate.name === name) ?? null,
      });
      expect(prompt).toContain("## Skill: weekly-export");
      expect(prompt).toContain("Gather the week's data and export it.");
    });
  }, 20_000);

  it("TASK-247 / §9.3: advances next_fire_at using the routine's IANA timezone across a DST boundary", async () => {
    await withPgBossQueueLock(pool, async () => {
      const roleId = `task-247-dst-${crypto.randomUUID()}`;
      await createRole({ connectionString: connectionString! }, { roleId, tenantId, name: "DST routine", title: "DST routine" });
      // 2027-03-13 09:00 America/New_York is EST (UTC-5) == 14:00Z. The next
      // 9am-local occurrence, 2027-03-14, falls the day DST springs forward,
      // so it is EDT (UTC-4) == 13:00Z — one hour earlier in UTC despite an
      // identical local wall-clock time.
      const dueAt = new Date("2027-03-13T14:00:00.000Z");
      const routine = await createRoutine({ connectionString: connectionString! }, {
        roleId,
        tenantId,
        name: "DST-crossing routine",
        schedule: "0 9 * * *",
        timezone: "America/New_York",
        definition: { goal: "Cross the DST boundary" },
        nextFireAt: dueAt,
      });

      await expect(
        runDueRoutinePoll({ connectionString: connectionString!, tenantId, now: () => new Date(dueAt.getTime() + 1_000) }),
      ).resolves.toContainEqual({ routineId: routine.routineId, outcome: "queued" });

      const refetched = await pool.query<{ next_fire_at: Date }>(
        `SELECT next_fire_at FROM role_routines WHERE routine_id = $1`,
        [routine.routineId],
      );
      expect(refetched.rows[0]?.next_fire_at.toISOString()).toBe("2027-03-14T13:00:00.000Z");
    });
  }, 20_000);

  it("TASK-258: a due routine fire creates a real run and enqueues a real worker.run-execution job, not just a task row", async () => {
    await withPgBossQueueLock(pool, async () => {
      await purgePgBossQueue(pool, WORKER_RUN_EXECUTION_JOB);

      const roleId = `task-258-real-run-${crypto.randomUUID()}`;
      await createRole({ connectionString: connectionString! }, { roleId, tenantId, name: "Real run", title: "Real run" });
      const routine = await createRoutine({ connectionString: connectionString! }, {
        roleId,
        tenantId,
        name: "Produces a real run",
        definition: { goal: "This must actually execute" },
        nextFireAt: new Date(Date.now() - 1_000),
      });

      await expect(runDueRoutinePoll({ connectionString: connectionString!, tenantId })).resolves.toContainEqual({
        routineId: routine.routineId,
        outcome: "queued",
      });

      const task = (await listTasks({ connectionString: connectionString! }, { tenantId })).tasks.find(
        (candidate) => candidate.routineId === routine.routineId,
      );
      expect(task).toBeDefined();
      // Before TASK-258, `routineJob.ts` only ever inserted a bare task row —
      // this is the exact regression check: a real `runs` row must exist for
      // it, not merely that some `createTask`-shaped port was invoked.
      const runs = await pool.query<{ run_id: string; task_id: string }>(
        `SELECT run_id, task_id FROM runs WHERE task_id = $1`,
        [task!.taskId],
      );
      expect(runs.rows).toHaveLength(1);
      const runId = runs.rows[0]!.run_id;

      // And a real pg-boss `worker.run-execution` job must be enqueued for
      // that exact run — the second half of "genuinely creates a run AND
      // enqueues worker.run-execution" (AC2). Querying `pgboss.job` directly
      // (rather than mocking the queue) is what makes this a liveness check:
      // it fails if the enqueue call is ever silently dropped or swapped for
      // a stub, not just if `routineJob.ts`'s own function is never called.
      const jobs = await pool.query<{ data: { runId: string; version: number } }>(
        `SELECT data FROM pgboss.job WHERE name = $1 AND data->>'runId' = $2`,
        [WORKER_RUN_EXECUTION_JOB, runId],
      );
      expect(jobs.rows).toHaveLength(1);
      expect(jobs.rows[0]!.data).toMatchObject({ version: 1, runId });

      await purgePgBossQueue(pool, WORKER_RUN_EXECUTION_JOB);
    });
  }, 20_000);

  it("TASK-305 / spec §11: a changes_only status routine sends nothing when STATUS.md is unchanged and fires when it changes", async () => {
    await withPgBossQueueLock(pool, async () => {
      await purgePgBossQueue(pool, WORKER_RUN_EXECUTION_JOB);
      const db = { connectionString: connectionString! };
      const roleId = `task-305-status-${crypto.randomUUID()}`;
      await createRole(db, { roleId, tenantId, name: "Manager", title: "Manager" });
      const thread = await getOrCreateThreadForRole(db, { roleId });
      const project = await createProject(db, {
        tenantId, threadId: thread.id, name: "P", goal: "g", doneCriterion: "d", createdBy: "human:1",
      });
      const addStatus = (sha: string) =>
        createProjectArtifact(db, {
          projectId: project.projectId, kind: "workspace_file",
          ref: `/oikonomos/workspace/projects/${project.projectId}/STATUS.md`, sha256: sha, label: "STATUS.md",
        });
      const routine = await createRoutine(db, {
        roleId, tenantId, name: "Status", notifyThreshold: "changes_only",
        definition: { goal: "Report status", projectId: project.projectId },
        nextFireAt: new Date(Date.now() - 1_000),
      });
      const rearm = () => pool.query(`UPDATE role_routines SET next_fire_at = now() - interval '1 second' WHERE routine_id = $1`, [routine.routineId]);
      const tasksFor = async () =>
        (await listTasks(db, { tenantId })).tasks.filter((t) => t.routineId === routine.routineId).length;

      await expect(runDueRoutinePoll({ ...db, tenantId })).resolves.toContainEqual({ routineId: routine.routineId, outcome: "skipped_unchanged" });
      expect(await tasksFor()).toBe(0);

      await addStatus("a".repeat(64));
      await rearm();
      await expect(runDueRoutinePoll({ ...db, tenantId })).resolves.toContainEqual({ routineId: routine.routineId, outcome: "queued" });
      expect(await tasksFor()).toBe(1);

      await rearm();
      await expect(runDueRoutinePoll({ ...db, tenantId })).resolves.toContainEqual({ routineId: routine.routineId, outcome: "skipped_unchanged" });
      expect(await tasksFor()).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 20));
      await addStatus("b".repeat(64));
      await rearm();
      await expect(runDueRoutinePoll({ ...db, tenantId })).resolves.toContainEqual({ routineId: routine.routineId, outcome: "queued" });
      expect(await tasksFor()).toBe(2);

      await purgePgBossQueue(pool, WORKER_RUN_EXECUTION_JOB);
    });
  }, 20_000);
});
