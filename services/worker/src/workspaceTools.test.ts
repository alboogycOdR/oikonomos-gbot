/**
 * TASK-282 — manager-bot tool parity tests, in a file separate from the
 * existing `workspaceMcpServer.test.ts` / `geminiToolExecutors.test.ts`
 * (both outside this task's Owned_Paths, so neither is edited here). Covers
 * both adapters against real Postgres: `create_bot`/`retire_bot` must behave
 * identically for Claude (`handleWorkspaceMcpRequest`) and Gemini
 * (`createWorkspaceGeminiTools`) — the exact parity TASK-272 established and
 * this task's own AC requires.
 */
import { createRole, defaultPoolConfig, getRole, listRoles, type DatabaseOptions } from "@oikonomos/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createWorkspaceGeminiTools } from "./geminiToolExecutors.js";
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
