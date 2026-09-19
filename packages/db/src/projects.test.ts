import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { defaultPoolConfig, type DatabaseOptions } from "./database.js";
import {
  addProjectRoleMember,
  createProject,
  createProjectTask,
  linkProjectTaskRun,
  listProjectRoleMembers,
  listProjectTaskRunIds,
  PROJECT_ROSTER_CAP,
  removeProjectRoleMember,
  setProjectManager,
} from "./projects.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

// TASK-298: roster (project_roles + thread_members) and project_task_runs
// against real Postgres. Own tenant so other suites' fixtures never collide.
integration("packages/db projects — roster, manager, task-run link (TASK-298)", () => {
  let pool: Pool;
  const options: DatabaseOptions = { connectionString: connectionString! };
  const tenantId = `task-298-${randomUUID()}`;
  const rolePrefix = `task-298-role-${randomUUID().slice(0, 8)}`;
  const roleIds = Array.from({ length: PROJECT_ROSTER_CAP + 1 }, (_, i) => `${rolePrefix}-${i}`);
  const threadIds: string[] = [];
  const projectIds: string[] = [];

  async function newProject(): Promise<{ projectId: string; threadId: string }> {
    const thread = await pool.query<{ id: string }>(
      "INSERT INTO threads (role_id, title) VALUES (NULL, 'task-298') RETURNING id",
    );
    const threadId = thread.rows[0]!.id;
    threadIds.push(threadId);
    const project = await createProject(options, {
      tenantId,
      threadId,
      name: "P",
      goal: "g",
      doneCriterion: "d",
      createdBy: "human:1",
    });
    projectIds.push(project.projectId);
    return { projectId: project.projectId, threadId };
  }

  async function threadMembers(threadId: string): Promise<string[]> {
    const r = await pool.query<{ role_id: string }>(
      "SELECT role_id FROM thread_members WHERE thread_id = $1 ORDER BY role_id",
      [threadId],
    );
    return r.rows.map((row) => row.role_id);
  }

  async function cleanup(): Promise<void> {
    await pool.query("DELETE FROM project_task_runs WHERE task_id IN (SELECT task_id FROM project_tasks WHERE project_id = ANY($1))", [projectIds]);
    await pool.query("DELETE FROM project_tasks WHERE project_id = ANY($1)", [projectIds]);
    await pool.query("DELETE FROM project_roles WHERE project_id = ANY($1)", [projectIds]);
    await pool.query("DELETE FROM projects WHERE project_id = ANY($1)", [projectIds]);
    await pool.query("DELETE FROM thread_members WHERE thread_id = ANY($1)", [threadIds]);
    await pool.query("DELETE FROM threads WHERE id = ANY($1)", [threadIds]);
    await pool.query("DELETE FROM runs WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM tasks WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM roles WHERE role_id LIKE $1", [`${rolePrefix}%`]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    for (const roleId of roleIds) {
      await pool.query(
        "INSERT INTO roles (role_id, tenant_id, name, title, description, status) VALUES ($1, $2, $1, $1, '', 'active')",
        [roleId, tenantId],
      );
    }
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("adds and removes roster members, keeping thread_members and project_roles in step", async () => {
    const { projectId, threadId } = await newProject();
    await addProjectRoleMember(options, { projectId, roleId: roleIds[0]!, responsibility: "research" });
    await addProjectRoleMember(options, { projectId, roleId: roleIds[1]! });
    expect((await listProjectRoleMembers(options, projectId)).map((m) => m.roleId)).toEqual([roleIds[0], roleIds[1]]);
    expect(await threadMembers(threadId)).toEqual([roleIds[0], roleIds[1]]);

    expect(await removeProjectRoleMember(options, { projectId, roleId: roleIds[0]! })).toBe(true);
    expect(await removeProjectRoleMember(options, { projectId, roleId: roleIds[0]! })).toBe(false);
    expect((await listProjectRoleMembers(options, projectId)).map((m) => m.roleId)).toEqual([roleIds[1]]);
    expect(await threadMembers(threadId)).toEqual([roleIds[1]]);
  });

  it("rejects a second is_manager=true row at the database", async () => {
    const { projectId } = await newProject();
    await addProjectRoleMember(options, { projectId, roleId: roleIds[0]!, isManager: true });
    // Raw insert proves the constraint itself, not just the accessor.
    await expect(
      pool.query("INSERT INTO project_roles (project_id, role_id, is_manager) VALUES ($1, $2, true)", [projectId, roleIds[1]]),
    ).rejects.toThrow(/project_roles_one_manager_idx/);
    await expect(
      addProjectRoleMember(options, { projectId, roleId: roleIds[1]!, isManager: true }),
    ).rejects.toThrow(/project_roles_one_manager_idx/);
  });

  it("a failure mid-transaction leaves neither thread_members nor project_roles changed", async () => {
    const { projectId, threadId } = await newProject();
    await addProjectRoleMember(options, { projectId, roleId: roleIds[0]!, isManager: true });
    // The thread_members insert succeeds first, then the manager index rejects
    // the project_roles insert: the rollback must undo the thread_members row.
    await expect(
      addProjectRoleMember(options, { projectId, roleId: roleIds[1]!, isManager: true }),
    ).rejects.toThrow();
    expect(await threadMembers(threadId)).toEqual([roleIds[0]]);
    expect((await listProjectRoleMembers(options, projectId)).map((m) => m.roleId)).toEqual([roleIds[0]]);
  });

  it("refuses a roster larger than PROJECT_ROSTER_CAP (6)", async () => {
    const { projectId, threadId } = await newProject();
    for (const roleId of roleIds.slice(0, PROJECT_ROSTER_CAP)) {
      await addProjectRoleMember(options, { projectId, roleId });
    }
    await expect(
      addProjectRoleMember(options, { projectId, roleId: roleIds[PROJECT_ROSTER_CAP]! }),
    ).rejects.toThrow(/at most 6/);
    expect(await threadMembers(threadId)).toHaveLength(PROJECT_ROSTER_CAP);
    // Re-adding an existing member (e.g. to change responsibility) is not growth.
    const updated = await addProjectRoleMember(options, { projectId, roleId: roleIds[0]!, responsibility: "new" });
    expect(updated.responsibility).toBe("new");
  });

  it("setProjectManager swaps and clears the manager; rejects a non-member", async () => {
    const { projectId } = await newProject();
    await addProjectRoleMember(options, { projectId, roleId: roleIds[0]! });
    await addProjectRoleMember(options, { projectId, roleId: roleIds[1]! });
    await setProjectManager(options, { projectId, roleId: roleIds[0]! });
    await setProjectManager(options, { projectId, roleId: roleIds[1]! });
    const managers = (await listProjectRoleMembers(options, projectId)).filter((m) => m.isManager);
    expect(managers.map((m) => m.roleId)).toEqual([roleIds[1]]);

    await expect(setProjectManager(options, { projectId, roleId: roleIds[2]! })).rejects.toThrow(/not on the roster/);
    // The failed promote rolled back the demote too.
    expect((await listProjectRoleMembers(options, projectId)).filter((m) => m.isManager)).toHaveLength(1);

    await setProjectManager(options, { projectId, roleId: null });
    expect((await listProjectRoleMembers(options, projectId)).filter((m) => m.isManager)).toHaveLength(0);
  });

  it("links a task to runs idempotently", async () => {
    const { projectId } = await newProject();
    const task = await createProjectTask(options, { projectId, title: "t", createdBy: "human:1" });
    const runtimeTaskId = randomUUID();
    const runId = randomUUID();
    await pool.query(
      "INSERT INTO tasks (task_id, tenant_id, role_id, title, goal, requested_by) VALUES ($1, $2, $3, 't', 'g', 'test')",
      [runtimeTaskId, tenantId, roleIds[0]],
    );
    await pool.query("INSERT INTO runs (run_id, task_id, tenant_id, provider) VALUES ($1, $2, $3, 'test')", [runId, runtimeTaskId, tenantId]);

    await linkProjectTaskRun(options, { taskId: task.taskId, runId });
    await linkProjectTaskRun(options, { taskId: task.taskId, runId });
    expect(await listProjectTaskRunIds(options, task.taskId)).toEqual([runId]);
    await expect(linkProjectTaskRun(options, { taskId: task.taskId, runId: randomUUID() })).rejects.toThrow();
  });
});

describe("packages/db projects — roster input validation (no DB, TASK-298)", () => {
  const options: DatabaseOptions = { connectionString: "postgres://unused" };
  it("rejects a malformed projectId before touching the pool", async () => {
    await expect(addProjectRoleMember(options, { projectId: "nope", roleId: "r" })).rejects.toThrow(/UUID/);
    await expect(removeProjectRoleMember(options, { projectId: "nope", roleId: "r" })).rejects.toThrow(/UUID/);
  });
});
