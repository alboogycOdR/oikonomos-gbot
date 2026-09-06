import {
  createRole,
  createRoutine,
  createSkill,
  defaultPoolConfig,
  getRoutineSpendUsd,
  listEnabledForRole,
  listTasks,
  setEnabledForRole,
  setRoutinePaused,
} from "@oikonomos/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assembleSystemPrompt } from "../promptAssembly.js";
import { runDueRoutinePoll } from "./routineJob.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("routine parity poller (TASK-182)", () => {
  let pool: Pool;
  const tenantId = `task-182-routine-poller-${crypto.randomUUID()}`;

  beforeAll(() => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM tasks WHERE tenant_id = $1`, [tenantId]);
    await pool.query(`DELETE FROM role_routines WHERE tenant_id = $1`, [tenantId]);
    await pool.query(`DELETE FROM role_skills WHERE role_id IN (SELECT role_id FROM roles WHERE tenant_id = $1)`, [tenantId]);
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

  it("carries a bound skill token into the assembled prompt's skill block", async () => {
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
});
