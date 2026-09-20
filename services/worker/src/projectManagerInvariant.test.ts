import { randomUUID } from "node:crypto";

import { grantApproval, issueApproval, verifyAndConsume } from "@oikonomos/approvals";
import { recordDecision } from "@oikonomos/audit";
import { BUILTIN_TOOLS, CapabilityRegistry, handlePreToolUse, PolicyRegistry, type BrokerDependencies } from "@oikonomos/broker";
import {
  addProjectRoleMember,
  createConnectorRegistrationStore,
  createProject,
  createProjectTask,
  createRole,
  createTask,
  Database,
  defaultPoolConfig,
  getAuditEventsForRun,
  MANAGER_BOT_DEFAULT_CAPABILITIES,
  type DatabaseOptions,
} from "@oikonomos/db";
import { composeHarness, STAGE_TWO_MAXIMUM_TOOL_TIER } from "@oikonomos/harness-factory/compose";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PROJECT_TOOL_CAPABILITIES,
  WORKSPACE_CREATE_BOT_CAPABILITY_ID,
  WORKSPACE_CREATE_BOT_TOOL,
  resolveGrantedProjectConnector,
  resolveGrantedWorkspaceConnector,
} from "./connectorResolution.js";
import { createProjectGeminiTools, createWorkspaceGeminiTools } from "./geminiToolExecutors.js";
import { destinationFor } from "./chatRunDriver.js";
import { registerCapabilities } from "./registerCapabilities.js";
import { startTaskRun } from "./runLifecycle.js";

const enabledNames = PROJECT_TOOL_CAPABILITIES.map(([, name]) => name);
const disabledNames = ["mcp__project__create_role", "mcp__project__request_grant"];

function databaseFor(capabilities: readonly string[]): Database {
  return { listRoleGrants: async () => capabilities.map((capabilityId) => ({ capabilityId })) } as unknown as Database;
}

describe("project manager MCP mount (TASK-303)", () => {
  it("mounts exactly the six enabled project tools for a manager in Claude and Gemini, never declared-disabled tools", async () => {
    const connector = await resolveGrantedProjectConnector({
      database: databaseFor(PROJECT_TOOL_CAPABILITIES.map(([capability]) => capability)),
      connectionString: "postgres://fixture", roleId: "manager", tenantId: "tenant", runId: "run",
    });

    expect(connector?.allowedTools).toEqual(enabledNames);
    expect(connector?.mcpServers.project).toMatchObject({ transport: "stdio", command: process.execPath });
    expect((connector?.mcpServers.project as { args?: readonly string[] } | undefined)?.args?.[0]).toContain("projectMcpServer.js");
    const gemini = createProjectGeminiTools({ connectionString: "postgres://fixture", tenantId: "tenant", roleId: "manager", runId: "run" }, connector?.allowedTools ?? []);
    expect(gemini.map((tool) => tool.name)).toEqual(enabledNames);
    expect([...connector?.allowedTools ?? [], ...gemini.map((tool) => tool.name)]).not.toEqual(expect.arrayContaining(disabledNames));
  });

  it("does not mount a project server or Gemini project tools for a member without project grants", async () => {
    const connector = await resolveGrantedProjectConnector({
      database: databaseFor([]), connectionString: "postgres://fixture", roleId: "member", tenantId: "tenant", runId: "run",
    });
    expect(connector).toBeUndefined();
    expect(createProjectGeminiTools({ connectionString: "postgres://fixture", tenantId: "tenant", roleId: "member", runId: "run" }, [])).toEqual([]);
  });

  it("adds approval-gated workspace.create_bot for a manager and never mounts retire_bot", async () => {
    const workspace = await resolveGrantedWorkspaceConnector({
      database: databaseFor([WORKSPACE_CREATE_BOT_CAPABILITY_ID]),
      connectionString: "postgres://fixture", roleId: "manager", tenantId: "tenant", runId: "run",
    });
    expect(workspace?.allowedTools).toEqual([WORKSPACE_CREATE_BOT_TOOL]);
    expect(workspace?.allowedTools).not.toContain("mcp__workspace__retire_bot");
  });
});

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

/** A Gemini response which asks the adapter to invoke the supplied mounted tools. */
function functionCalls(calls: readonly { readonly name: string; readonly args: Record<string, unknown> }[]): Response {
  return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: calls.map(({ name, args }) => ({ functionCall: { name, args } })) } }] }));
}

function text(value: string): Response {
  return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: value }] } }] }));
}

integration("project manager liveness through the worker broker composition (TASK-303)", () => {
  const tenantId = `task-303-${randomUUID()}`;
  const managerRoleId = `task-303-manager-${randomUUID().slice(0, 8)}`;
  const memberRoleId = `task-303-member-${randomUUID().slice(0, 8)}`;
  let pool: Pool;
  let options: DatabaseOptions;
  let projectId: string;
  let threadId: string;
  let seedTaskId: string;
  let runId: string;
  const createdRoleIds: string[] = [];

  async function count(table: "roles" | "role_grants"): Promise<number> {
    const sql = table === "roles"
      ? "SELECT count(*)::text AS count FROM roles WHERE tenant_id = $1"
      : "SELECT count(*)::text AS count FROM role_grants grants JOIN roles ON roles.role_id = grants.role_id WHERE roles.tenant_id = $1";
    const result = await pool.query<{ count: string }>(sql, [tenantId]);
    return Number(result.rows[0]!.count);
  }

  async function cleanup(): Promise<void> {
    await pool.query("DELETE FROM audit_events WHERE run_id = $1", [runId]);
    await pool.query("DELETE FROM approvals WHERE run_id = $1", [runId]);
    await pool.query("DELETE FROM runs WHERE run_id = $1", [runId]);
    await pool.query("DELETE FROM tasks WHERE tenant_id = $1", [tenantId]);
    if (projectId !== undefined) {
      await pool.query("DELETE FROM project_artifacts WHERE project_id = $1", [projectId]);
      await pool.query("DELETE FROM project_decisions WHERE project_id = $1", [projectId]);
      await pool.query("DELETE FROM project_tasks WHERE project_id = $1", [projectId]);
      await pool.query("DELETE FROM project_roles WHERE project_id = $1", [projectId]);
      await pool.query("DELETE FROM projects WHERE project_id = $1", [projectId]);
    }
    if (threadId !== undefined) {
      await pool.query("DELETE FROM thread_members WHERE thread_id = $1", [threadId]);
      await pool.query("DELETE FROM threads WHERE id = $1", [threadId]);
    }
    const roleIds = [managerRoleId, memberRoleId, ...createdRoleIds];
    await pool.query("DELETE FROM role_grants WHERE role_id = ANY($1::text[])", [roleIds]);
    await pool.query("DELETE FROM roles WHERE role_id = ANY($1::text[])", [roleIds]);
  }

  beforeAll(async () => {
    process.env.OIKONOMOS_CAPABILITIES_ENABLED = "true";
    process.env.GEMINI_API_KEY = "task-303-test-key";
    options = { connectionString: connectionString! };
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    const database = new Database(options);
    try {
      await registerCapabilities({ store: createConnectorRegistrationStore(pool) });
      await createRole(options, { roleId: managerRoleId, tenantId, name: managerRoleId, title: "TASK-303 manager" });
      await createRole(options, { roleId: memberRoleId, tenantId, name: memberRoleId, title: "TASK-303 member" });
      for (const [capabilityId, maxTier] of [
        ["project.read", "T0_observe"], ["project.task_write", "T2_internal"], ["project.assign", "T2_internal"],
        ["project.artifact_write", "T2_internal"], ["project.decision_write", "T2_internal"],
        [WORKSPACE_CREATE_BOT_CAPABILITY_ID, "T3_external"],
      ] as const) await database.upsertRoleGrant({ roleId: managerRoleId, capabilityId, maxTier, constraints: {} });
    } finally { await database.close(); }
    threadId = (await pool.query<{ id: string }>("INSERT INTO threads (role_id, title) VALUES (NULL, 'TASK-303') RETURNING id")).rows[0]!.id;
    projectId = (await createProject(options, { tenantId, threadId, name: "TASK-303", goal: "mount projects", doneCriterion: "liveness", createdBy: "human:task-303" })).projectId;
    await addProjectRoleMember(options, { projectId, roleId: managerRoleId, isManager: true, responsibility: "manager" });
    await addProjectRoleMember(options, { projectId, roleId: memberRoleId, responsibility: "member" });
    seedTaskId = (await createProjectTask(options, { projectId, title: "seed", createdBy: `role:${managerRoleId}` })).taskId;
    const task = await createTask(options, { roleId: managerRoleId, tenantId, title: "TASK-303 liveness", goal: "exercise mounted tools", requestedBy: "task-303" });
    runId = (await startTaskRun(options, { taskId: task.taskId, provider: "gemini", tenantId })).runId;
  });

  afterAll(async () => { await cleanup(); await pool.end(); });

  it("invokes every mounted project tool through L1 and leaves role and grant rows unchanged, with one audit event per tool", async () => {
    const database = new Database(options);
    try {
      const registry = await CapabilityRegistry.build({ declared: BUILTIN_TOOLS, persisted: database });
      const policy = new PolicyRegistry({ mountedToolNames: [...registry.enabledToolNames], policies: [...registry.enabledToolNames].map((toolName) => ({ toolName })), manifestToolNames: [...registry.enabledToolNames] });
      const dependencies: BrokerDependencies = {
        isCapabilitiesEnabled: () => true,
        ...registry.brokerPorts(database), destinationFor, issueApproval: async () => { throw new Error("project tools must not request approval"); }, verifyAndConsume: async () => ({ consumed: false, rowCount: 0 }),
        issueApprovalDependencies: { database: options }, consumeDependencies: { database: options }, manifestMap: policy.manifestMap,
        recordDecision: async (event) => ({ eventId: (await recordDecision(options, event)).eventId }),
      };
      const mounted = createProjectGeminiTools({ connectionString: connectionString!, tenantId, roleId: managerRoleId, runId }, enabledNames);
      const calls = [
        { name: "mcp__project__list_board", args: { projectId } },
        { name: "mcp__project__create_task", args: { projectId, title: "created by liveness" } },
        { name: "mcp__project__update_task", args: { taskId: seedTaskId, state: "doing" } },
        { name: "mcp__project__assign_task", args: { taskId: seedTaskId, ownerRoleId: memberRoleId } },
        { name: "mcp__project__register_artifact", args: { projectId, kind: "workspace_file", ref: `/oikonomos/workspace/projects/${projectId}/evidence.md`, label: "evidence" } },
        { name: "mcp__project__record_decision", args: { projectId, kind: "manager_decision", summary: "liveness evidence" } },
      ] as const;
      const before = { roles: await count("roles"), grants: await count("role_grants") };
      let requests = 0;
      const composed = composeHarness<BrokerDependencies>({
        run: { runId, roleId: managerRoleId, tenantId, agentRef: { provider: "gemini", sessionRef: runId, isSubagent: false } },
        provider: "gemini", allowedTools: [], auditSink: { writeCompletionEvidence: async () => undefined },
        pretooluse: { handlePreToolUse, dependencies },
        gemini: { tools: mounted, maximumToolTier: STAGE_TWO_MAXIMUM_TOOL_TIER, fetch: async () => requests++ === 0 ? functionCalls(calls) : text("done") },
      });
      await composed.gemini!.run("exercise project tools");
      expect({ roles: await count("roles"), grants: await count("role_grants") }).toEqual(before);
      const events = await getAuditEventsForRun(options, runId);
      const projectEventTypes = events.filter((event) => event.eventType.startsWith("project.")).map((event) => event.eventType);
      expect(projectEventTypes).toContain("project.board_listed");
      expect(projectEventTypes).toContain("project.task_created");
      expect(projectEventTypes).toContain("project.task_transition");
      expect(projectEventTypes).toContain("project.task_assigned");
      expect(projectEventTypes).toContain("project.artifact_registered");
      expect(projectEventTypes).toContain("project.decision_recorded");
    } finally { await database.close(); }
  }, 30_000);

  it("parks manager create_bot at L1 until human approval, then creates exactly one floor-only role without calling the workspace MCP handler", async () => {
    const database = new Database(options);
    try {
      const registry = await CapabilityRegistry.build({ declared: BUILTIN_TOOLS, persisted: database });
      const policy = new PolicyRegistry({ mountedToolNames: [...registry.enabledToolNames], policies: [...registry.enabledToolNames].map((toolName) => ({ toolName })), manifestToolNames: [...registry.enabledToolNames] });
      const dependencies: BrokerDependencies = {
        isCapabilitiesEnabled: () => true,
        ...registry.brokerPorts(database), destinationFor, issueApproval, verifyAndConsume,
        issueApprovalDependencies: { database: options }, consumeDependencies: { database: options }, manifestMap: policy.manifestMap,
        recordDecision: async (event) => ({ eventId: (await recordDecision(options, event)).eventId }),
      };
      const input = { name: `task-303-child-${randomUUID().slice(0, 8)}`, title: "TASK-303 approval child" };
      const request = (approvalNonce?: string) => ({
        toolName: WORKSPACE_CREATE_BOT_TOOL, toolUseId: `task-303-create-${randomUUID()}`, input, runId, roleId: managerRoleId, tenantId,
        agentRef: { provider: "claude", sessionRef: runId, isSubagent: false }, ...(approvalNonce === undefined ? {} : { approvalNonce }),
      });
      const before = { roles: await count("roles"), grants: await count("role_grants") };
      await expect(handlePreToolUse(request(), dependencies)).resolves.toMatchObject({ decision: "deny", reason: "approval_pending" });
      expect({ roles: await count("roles"), grants: await count("role_grants") }).toEqual(before);
      const nonce = (await pool.query<{ nonce: string }>("SELECT nonce::text FROM approvals WHERE run_id = $1 AND capability_id = $2 AND status = 'pending' LIMIT 1", [runId, WORKSPACE_CREATE_BOT_CAPABILITY_ID])).rows[0]?.nonce;
      if (nonce === undefined) throw new Error("TASK-303 expected pending create_bot approval");
      expect((await grantApproval(nonce, "human:task-303", { database: options })).decided).toBe(true);
      await expect(handlePreToolUse(request(nonce), dependencies)).resolves.toMatchObject({ decision: "allow", tier: "T3_external" });
      // This is the actual Gemini-side worker executor, deliberately not
      // handleWorkspaceMcpRequest: the direct MCP handler has no L1 check.
      const created = await createWorkspaceGeminiTools({ connectionString: connectionString!, tenantId, roleId: managerRoleId, runId }, [WORKSPACE_CREATE_BOT_TOOL])[0]!.execute(input) as { roleId: string };
      createdRoleIds.push(created.roleId);
      expect(await count("roles")).toBe(before.roles + 1);
      const grants = await pool.query<{ capability_id: string }>("SELECT capability_id FROM role_grants WHERE role_id = $1 ORDER BY capability_id", [created.roleId]);
      expect(grants.rows.map((row) => row.capability_id)).toEqual([...MANAGER_BOT_DEFAULT_CAPABILITIES].sort());
    } finally { await database.close(); }
  }, 30_000);
});
