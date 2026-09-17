/**
 * TASK-282 — manager-bot tool parity tests, in a file separate from the
 * existing `workspaceMcpServer.test.ts` / `geminiToolExecutors.test.ts`
 * (both outside this task's Owned_Paths, so neither is edited here). Covers
 * both adapters against real Postgres: `create_bot`/`retire_bot` must behave
 * identically for Claude (`handleWorkspaceMcpRequest`) and Gemini
 * (`createWorkspaceGeminiTools`) — the exact parity TASK-272 established and
 * this task's own AC requires.
 */
import { grantApproval, issueApproval, verifyAndConsume } from "@oikonomos/approvals";
import { recordDecision } from "@oikonomos/audit";
import { BUILTIN_TOOLS, CapabilityRegistry, handlePreToolUse, PolicyRegistry, type BrokerDependencies, type PreToolUseRequest } from "@oikonomos/broker";
import { createRole, createTask, Database, defaultPoolConfig, getRole, listRoles, type DatabaseOptions } from "@oikonomos/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { destinationFor } from "./chatRunDriver.js";
import { createWorkspaceGeminiTools } from "./geminiToolExecutors.js";
import { startTaskRun } from "./runLifecycle.js";
import { handleWorkspaceMcpRequest } from "./workspaceMcpServer.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("manager-bot tools — create_bot / retire_bot (TASK-282)", () => {
  const tenantId = "basileia";
  const managerRoleId = "task-282-manager-bot";
  const otherTenantManagerRoleId = "task-282-other-tenant-manager";
  const otherTenantId = "task-282-other-tenant";
  let pool: Pool;
  let options: DatabaseOptions;
  const createdRoleIds: string[] = [];

  async function cleanup(): Promise<void> {
    const ids = [managerRoleId, otherTenantManagerRoleId, ...createdRoleIds];
    await pool.query("DELETE FROM role_grants WHERE role_id = ANY($1::text[])", [ids]);
    await pool.query("DELETE FROM roles WHERE role_id = ANY($1::text[])", [ids]);
  }

  beforeAll(async () => {
    options = { connectionString: connectionString! };
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await cleanup();
    await createRole(options, { roleId: managerRoleId, tenantId, name: managerRoleId, title: "TASK-282 manager bot fixture" });
    await createRole(options, { roleId: otherTenantManagerRoleId, tenantId: otherTenantId, name: otherTenantManagerRoleId, title: "TASK-282 cross-tenant fixture" });
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("Claude lane: create_bot creates a role at the default floor, visible via listRoles", async () => {
    const identity = { connectionString: connectionString!, tenantId, fromRoleId: managerRoleId };
    const response = await handleWorkspaceMcpRequest(JSON.stringify({
      jsonrpc: "2.0", id: "create-bot", method: "tools/call",
      params: { name: "create_bot", arguments: { name: "claude-created-bot", title: "Claude-created bot" } },
    }), identity);
    expect(response).toMatchObject({ result: { content: [{ type: "text" }] } });
    const parsed = JSON.parse((response as { result: { content: [{ text: string }] } }).result.content[0].text) as { roleId: string; name: string; status: string };
    createdRoleIds.push(parsed.roleId);
    expect(parsed).toMatchObject({ name: "claude-created-bot", status: "active" });

    const roles = await listRoles(options, { tenantId });
    expect(roles.some((role) => role.roleId === parsed.roleId)).toBe(true);
  });

  it("Claude lane: create_bot enforces its advertised length bounds at runtime, not just in the schema (TASK-282 adversarial review finding)", async () => {
    const identity = { connectionString: connectionString!, tenantId, fromRoleId: managerRoleId };
    const oversizedDescription = await handleWorkspaceMcpRequest(JSON.stringify({
      jsonrpc: "2.0", id: "create-bot-oversized", method: "tools/call",
      params: { name: "create_bot", arguments: { name: "oversized", title: "Oversized", description: "x".repeat(2001) } },
    }), identity);
    expect(oversizedDescription).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining("at most 2000 characters") }] } });
    const oversizedTitle = await handleWorkspaceMcpRequest(JSON.stringify({
      jsonrpc: "2.0", id: "create-bot-oversized-title", method: "tools/call",
      params: { name: "create_bot", arguments: { name: "oversized2", title: "x".repeat(201) } },
    }), identity);
    expect(oversizedTitle).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining("at most 200 characters") }] } });
  });

  it("Claude lane: retire_bot moves the target to hidden, refuses self-retirement and cross-tenant retirement", async () => {
    const identity = { connectionString: connectionString!, tenantId, fromRoleId: managerRoleId };
    const created = await handleWorkspaceMcpRequest(JSON.stringify({
      jsonrpc: "2.0", id: "create-bot-2", method: "tools/call",
      params: { name: "create_bot", arguments: { name: "claude-retiree", title: "To be retired" } },
    }), identity);
    const { roleId } = JSON.parse((created as { result: { content: [{ text: string }] } }).result.content[0].text) as { roleId: string };
    createdRoleIds.push(roleId);

    const selfRetire = await handleWorkspaceMcpRequest(JSON.stringify({
      jsonrpc: "2.0", id: "self-retire", method: "tools/call",
      params: { name: "retire_bot", arguments: { roleId: managerRoleId } },
    }), identity);
    expect(selfRetire).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining("not retire itself") }] } });

    const crossTenant = await handleWorkspaceMcpRequest(JSON.stringify({
      jsonrpc: "2.0", id: "cross-tenant", method: "tools/call",
      params: { name: "retire_bot", arguments: { roleId: otherTenantManagerRoleId } },
    }), identity);
    expect(crossTenant).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining("outside its own tenant") }] } });
    expect((await getRole(options, otherTenantManagerRoleId))?.status).toBe("active");

    const retired = await handleWorkspaceMcpRequest(JSON.stringify({
      jsonrpc: "2.0", id: "retire", method: "tools/call",
      params: { name: "retire_bot", arguments: { roleId } },
    }), identity);
    expect(retired).toMatchObject({ result: { content: [{ type: "text", text: expect.stringContaining("hidden") }] } });
    expect((await getRole(options, roleId))?.status).toBe("hidden");
  });

  it("Gemini lane: create_bot / retire_bot behave identically to the Claude lane", async () => {
    const context = { connectionString: connectionString!, tenantId, roleId: managerRoleId };
    const [createBot, retireBot] = createWorkspaceGeminiTools(context, [
      "mcp__workspace__create_bot",
      "mcp__workspace__retire_bot",
    ]);
    expect(createBot?.tier).toBe(3);
    expect(retireBot?.tier).toBe(4);

    const created = await createBot!.execute({ name: "gemini-created-bot", title: "Gemini-created bot" }) as { roleId: string; name: string; status: string };
    createdRoleIds.push(created.roleId);
    expect(created).toMatchObject({ name: "gemini-created-bot", status: "active" });
    const roles = await listRoles(options, { tenantId });
    expect(roles.some((role) => role.roleId === created.roleId)).toBe(true);

    const selfRetire = await retireBot!.execute({ roleId: managerRoleId }) as { ok: boolean; code: string };
    expect(selfRetire).toMatchObject({ ok: false, code: "self_retirement" });

    const retired = await retireBot!.execute({ roleId: created.roleId }) as { roleId: string; status: string };
    expect(retired).toMatchObject({ roleId: created.roleId, status: "hidden" });
    expect((await getRole(options, created.roleId))?.status).toBe("hidden");
  });

  it("Gemini lane: create_bot also enforces its advertised length bounds at runtime (TASK-282 adversarial review finding)", async () => {
    const context = { connectionString: connectionString!, tenantId, roleId: managerRoleId };
    const [createBot] = createWorkspaceGeminiTools(context, ["mcp__workspace__create_bot"]);
    await expect(createBot!.execute({ name: "oversized", title: "Oversized", description: "x".repeat(2001) }))
      .rejects.toThrow(/at most 2000 characters/);
    await expect(createBot!.execute({ name: "oversized2", title: "x".repeat(201) }))
      .rejects.toThrow(/at most 200 characters/);
  });

  it("both adapters reject a not-found target with a clear, non-generic denial", async () => {
    const claudeResponse = await handleWorkspaceMcpRequest(JSON.stringify({
      jsonrpc: "2.0", id: "not-found", method: "tools/call",
      params: { name: "retire_bot", arguments: { roleId: "does-not-exist" } },
    }), { connectionString: connectionString!, tenantId, fromRoleId: managerRoleId });
    expect(claudeResponse).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining("not found") }] } });

    const [, geminiRetire] = createWorkspaceGeminiTools(
      { connectionString: connectionString!, tenantId, roleId: managerRoleId },
      ["mcp__workspace__create_bot", "mcp__workspace__retire_bot"],
    );
    const geminiResponse = await geminiRetire!.execute({ roleId: "does-not-exist" }) as { ok: boolean; code: string };
    expect(geminiResponse).toMatchObject({ ok: false, code: "not_found" });
  });
});

integration("manager-bot retirement is approval-gated through the production broker composition (TASK-285)", () => {
  const tenantId = "basileia";
  const managerRoleId = "task-285-manager-bot";
  let pool: Pool;
  let options: DatabaseOptions;
  let previousCapabilitiesEnabled: string | undefined;
  const createdRoleIds: string[] = [];

  async function cleanup(): Promise<void> {
    const roleIds = [managerRoleId, ...createdRoleIds];
    await pool.query("DELETE FROM audit_events WHERE run_id IN (SELECT run_id FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = ANY($1::text[])))", [roleIds]);
    await pool.query("DELETE FROM approvals WHERE run_id IN (SELECT run_id FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = ANY($1::text[])))", [roleIds]);
    await pool.query("DELETE FROM messages WHERE run_id IN (SELECT run_id FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = ANY($1::text[])))", [roleIds]);
    await pool.query("DELETE FROM runs WHERE task_id IN (SELECT task_id FROM tasks WHERE role_id = ANY($1::text[]))", [roleIds]);
    await pool.query("DELETE FROM tasks WHERE role_id = ANY($1::text[])", [roleIds]);
    await pool.query("DELETE FROM thread_members WHERE thread_id IN (SELECT id FROM threads WHERE role_id = ANY($1::text[]))", [roleIds]);
    await pool.query("DELETE FROM threads WHERE role_id = ANY($1::text[])", [roleIds]);
    await pool.query("DELETE FROM role_grants WHERE role_id = ANY($1::text[])", [roleIds]);
    await pool.query("DELETE FROM roles WHERE role_id = ANY($1::text[])", [roleIds]);
  }

  beforeAll(async () => {
    previousCapabilitiesEnabled = process.env.OIKONOMOS_CAPABILITIES_ENABLED;
    process.env.OIKONOMOS_CAPABILITIES_ENABLED = "true";
    options = { connectionString: connectionString! };
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await cleanup();
    await createRole(options, { roleId: managerRoleId, tenantId, name: managerRoleId, title: "TASK-285 manager fixture" });
    const database = new Database(options);
    try {
      // The isolated test database deliberately starts without capability
      // registration side effects. These are the real reviewed declarations
      // used by the production registry, persisted before composing it.
      await database.upsertCapability({ capabilityId: "workspace.create_bot", description: "Create a workspace bot.", defaultTier: "T3_external", adapter: "mcp:workspace", enabled: true });
      await database.upsertCapability({ capabilityId: "workspace.retire_bot", description: "Retire a workspace bot.", defaultTier: "T4_irreversible", adapter: "mcp:workspace", enabled: true });
      await database.upsertRoleGrant({ roleId: managerRoleId, capabilityId: "workspace.create_bot", maxTier: "T3_external", constraints: {} });
      await database.upsertRoleGrant({ roleId: managerRoleId, capabilityId: "workspace.retire_bot", maxTier: "T4_irreversible", constraints: {} });
    } finally {
      await database.close();
    }
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
    if (previousCapabilitiesEnabled === undefined) delete process.env.OIKONOMOS_CAPABILITIES_ENABLED;
    else process.env.OIKONOMOS_CAPABILITIES_ENABLED = previousCapabilitiesEnabled;
  });

  it("requires real approvals for T3 create_bot and E6-gated retire_bot before either handler executes", async () => {
    const task = await createTask(options, {
      roleId: managerRoleId,
      title: "TASK-285 governed retirement fixture",
      goal: "Create and retire a fixture bot through the governed workspace tools.",
      requestedBy: "task-285-suite",
    });
    const run = await startTaskRun(options, { taskId: task.taskId, provider: "claude", tenantId });
    const database = new Database(options);
    try {
      const registry = await CapabilityRegistry.build({ declared: BUILTIN_TOOLS, persisted: database });
      const policy = new PolicyRegistry({
        mountedToolNames: [...registry.enabledToolNames],
        policies: [...registry.enabledToolNames].map((toolName) => ({ toolName })),
        manifestToolNames: [...registry.enabledToolNames],
      });
      // This is the worker's real production composition (chatRunDriver's
      // private factory has this exact object literal), not a mocked port.
      const dependencies: BrokerDependencies = {
        isCapabilitiesEnabled: () => process.env.OIKONOMOS_CAPABILITIES_ENABLED === "true",
        ...registry.brokerPorts(database), destinationFor, issueApproval, verifyAndConsume,
        issueApprovalDependencies: { database: options }, consumeDependencies: { database: options }, manifestMap: policy.manifestMap,
        recordDecision: async (event) => ({ eventId: (await recordDecision(options, event)).eventId }),
      };
      const request = (toolName: string, toolUseId: string, input: Record<string, unknown>, approvalNonce?: string): PreToolUseRequest => ({
        toolName, toolUseId, input, runId: run.runId, roleId: managerRoleId, tenantId,
        agentRef: { provider: "claude", sessionRef: run.runId, isSubagent: false },
        ...(approvalNonce === undefined ? {} : { approvalNonce }),
      });

      const createInput = { name: "task-285-retiree", title: "TASK-285 retiree" };
      const createPending = await handlePreToolUse(
        request("mcp__workspace__create_bot", "task-285-create-pending", createInput),
        dependencies,
      );
      expect(createPending).toMatchObject({ decision: "deny", reason: "approval_pending" });
      const createNonce = (
        await pool.query<{ nonce: string }>(
          "SELECT nonce::text AS nonce FROM approvals WHERE run_id = $1 AND capability_id = 'workspace.create_bot' AND status = 'pending'",
          [run.runId],
        )
      ).rows[0]?.nonce;
      if (createNonce === undefined) throw new Error("TASK-285 expected a real pending create_bot approval nonce");
      expect((await grantApproval(createNonce, "human:task-285-reviewer", { database: options })).decided).toBe(true);
      await expect(
        handlePreToolUse(request("mcp__workspace__create_bot", "task-285-create-approved", createInput, createNonce), dependencies),
      ).resolves.toMatchObject({ decision: "allow", tier: "T3_external" });
      const created = await handleWorkspaceMcpRequest(JSON.stringify({ jsonrpc: "2.0", id: "task-285-create", method: "tools/call", params: { name: "create_bot", arguments: { name: "task-285-retiree", title: "TASK-285 retiree" } } }), { connectionString: connectionString!, tenantId, fromRoleId: managerRoleId });
      const createdRoleId = (JSON.parse((created as { result: { content: [{ text: string }] } }).result.content[0].text) as { roleId: string }).roleId;
      createdRoleIds.push(createdRoleId);

      const pending = await handlePreToolUse(request("mcp__workspace__retire_bot", "task-285-retire-pending", { roleId: createdRoleId }), dependencies);
      expect(pending).toMatchObject({ decision: "deny", reason: "approval_pending" });
      expect((await getRole(options, createdRoleId))?.status).toBe("active");
      const nonce = (
        await pool.query<{ nonce: string }>(
          "SELECT nonce::text AS nonce FROM approvals WHERE run_id = $1 AND capability_id = 'workspace.retire_bot' AND status = 'pending'",
          [run.runId],
        )
      ).rows[0]?.nonce;
      if (nonce === undefined) throw new Error("TASK-285 expected a real pending approval nonce");
      expect((await grantApproval(nonce, "human:task-285-reviewer", { database: options })).decided).toBe(true);
      await expect(handlePreToolUse(request("mcp__workspace__retire_bot", "task-285-retire-approved", { roleId: createdRoleId }, nonce), dependencies))
        .resolves.toMatchObject({ decision: "allow", tier: "T4_irreversible" });
      const retired = await handleWorkspaceMcpRequest(JSON.stringify({ jsonrpc: "2.0", id: "task-285-retire-approved", method: "tools/call", params: { name: "retire_bot", arguments: { roleId: createdRoleId } } }), { connectionString: connectionString!, tenantId, fromRoleId: managerRoleId });
      expect(retired).toMatchObject({ result: { content: [{ text: expect.stringContaining("hidden") }] } });
      expect((await getRole(options, createdRoleId))?.status).toBe("hidden");
    } finally { await database.close(); }
  }, 120_000);
});
