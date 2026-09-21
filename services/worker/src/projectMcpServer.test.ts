import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAuditEventsForRun } from "@oikonomos/db";
import { handleProjectMcpRequest } from "./projectMcpServer.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

function call(identity: { connectionString: string; tenantId: string; fromRoleId: string; runId: string }, taskId: string, ownerRoleId: string) {
  return handleProjectMcpRequest(JSON.stringify({ jsonrpc: "2.0", id: taskId, method: "tools/call", params: { name: "assign_task", arguments: { taskId, ownerRoleId } } }), identity);
}

function isError(response: Record<string, unknown> | undefined): boolean {
  return (response?.result as { isError?: boolean } | undefined)?.isError === true;
}

describe("project MCP server", () => {
  it("lists exactly the six enabled project tools, with neither role nor grant verbs", async () => {
    const response = await handleProjectMcpRequest(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }), { connectionString: "postgres://unused", tenantId: "t", fromRoleId: "r" });
    const names = ((response?.result as { tools: Array<{ name: string }> }).tools).map((tool) => tool.name);
    expect(names).toEqual(["list_board", "create_task", "update_task", "assign_task", "register_artifact", "record_decision"]);
    expect(names.join(" ")).not.toMatch(/role|grant/);
  });
});

integration("project MCP durable fanout cap (TASK-321)", () => {
  const tenantId = `task-321-${randomUUID()}`;
  const manager = randomUUID();
  const otherManager = randomUUID();
  const memberA = randomUUID();
  const memberB = randomUUID();
  const roleIds = [manager, otherManager, memberA, memberB];
  let pool: Pool;

  async function fixture(managerRoleId: string): Promise<string[]> {
    const thread = await pool.query<{ id: string }>("INSERT INTO threads (role_id, title) VALUES (NULL, 'task-321') RETURNING id");
    const project = await pool.query<{ project_id: string }>("INSERT INTO projects (tenant_id, thread_id, name, goal, done_criterion, created_by) VALUES ($1, $2, 'task-321', 'g', 'd', 'test') RETURNING project_id", [tenantId, thread.rows[0]!.id]);
    const projectId = project.rows[0]!.project_id;
    for (const roleId of [managerRoleId, memberA, memberB]) {
      await pool.query("INSERT INTO project_roles (project_id, role_id, is_manager) VALUES ($1, $2, $3)", [projectId, roleId, roleId === managerRoleId]);
      await pool.query("INSERT INTO thread_members (thread_id, role_id) VALUES ($1, $2)", [thread.rows[0]!.id, roleId]);
    }
    const taskIds: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const task = await pool.query<{ task_id: string }>("INSERT INTO project_tasks (project_id, title, created_by) VALUES ($1, $2, $3) RETURNING task_id", [projectId, `task-${i}`, `role:${managerRoleId}`]);
      taskIds.push(task.rows[0]!.task_id);
    }
    return taskIds;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, max: 8 });
    for (const roleId of roleIds) await pool.query("INSERT INTO roles (role_id, tenant_id, name, title) VALUES ($1, $2, $1, $1)", [roleId, tenantId]);
  });

  afterAll(async () => {
    await pool.query("DELETE FROM role_messages WHERE tenant_id = $1", [tenantId]);
    await pool.query("DELETE FROM project_tasks WHERE project_id IN (SELECT project_id FROM projects WHERE tenant_id = $1)", [tenantId]);
    await pool.query("DELETE FROM project_roles WHERE project_id IN (SELECT project_id FROM projects WHERE tenant_id = $1)", [tenantId]);
    await pool.query("DELETE FROM thread_members WHERE thread_id IN (SELECT thread_id FROM projects WHERE tenant_id = $1)", [tenantId]);
    const threads = await pool.query<{ thread_id: string }>("DELETE FROM projects WHERE tenant_id = $1 RETURNING thread_id", [tenantId]);
    for (const row of threads.rows) await pool.query("DELETE FROM threads WHERE id = $1", [row.thread_id]);
    await pool.query("DELETE FROM roles WHERE tenant_id = $1", [tenantId]);
    await pool.end();
  });

  it("caps fresh per-call MCP tools sequentially and in parallel, audits refusals, and scopes allowances by run and manager", async () => {
    const sequentialTasks = await fixture(manager);
    const sequentialRun = randomUUID();
    const identity = { connectionString: connectionString!, tenantId, fromRoleId: manager, runId: sequentialRun };
    const sequential = [];
    for (const taskId of sequentialTasks) sequential.push(await call(identity, taskId, memberA));
    expect(sequential.filter((response) => !isError(response))).toHaveLength(3);
    expect(sequential.filter(isError)).toHaveLength(1);
    expect(JSON.stringify(sequential.find(isError))).toContain("Project fan-out cap reached for this manager turn.");
    expect((await getAuditEventsForRun({ connectionString: connectionString! }, sequentialRun)).map((event) => event.eventType).sort()).toEqual(["project.fanout_capped", "project.task_assigned", "project.task_assigned", "project.task_assigned"]);

    const secondRunTasks = await fixture(manager);
    const secondRunId = randomUUID();
    const secondRun = await Promise.all(secondRunTasks.map((taskId) => call({ ...identity, runId: secondRunId }, taskId, memberB)));
    expect(secondRun.filter((response) => !isError(response))).toHaveLength(3);
    expect(secondRun.filter(isError)).toHaveLength(1);

    const sharedRun = randomUUID();
    const concurrentTasks = await fixture(manager);
    const concurrent = await Promise.all(concurrentTasks.map((taskId) => call({ ...identity, runId: sharedRun }, taskId, memberB)));
    expect(concurrent.filter((response) => !isError(response))).toHaveLength(3);
    expect(concurrent.filter(isError)).toHaveLength(1);

    const otherTasks = await fixture(otherManager);
    const otherRun = randomUUID();
    const other = await Promise.all(otherTasks.map((taskId) => call({ connectionString: connectionString!, tenantId, fromRoleId: otherManager, runId: otherRun }, taskId, memberA)));
    expect(other.filter((response) => !isError(response))).toHaveLength(3);
    expect(other.filter(isError)).toHaveLength(1);
  });
});
