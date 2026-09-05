import { createRole, defaultPoolConfig, getRole, type DatabaseOptions } from "@oikonomos/db";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { handleWorkspaceMcpRequest } from "./workspaceMcpServer.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("workspace MCP server — real mailbox bridge (TASK-131)", () => {
  const senderRoleId = "task-131-workspace-mcp-sender";
  const receiverRoleId = "task-131-workspace-mcp-receiver";
  let pool: Pool;
  let options: DatabaseOptions;

  async function cleanup(): Promise<void> {
    await pool.query(
      "DELETE FROM role_messages WHERE from_role_id = ANY($1::text[]) OR to_role_id = ANY($1::text[])",
      [[senderRoleId, receiverRoleId]],
    );
    await pool.query("DELETE FROM role_grants WHERE role_id = ANY($1::text[])", [[senderRoleId, receiverRoleId]]);
    await pool.query("DELETE FROM roles WHERE role_id = ANY($1::text[])", [[senderRoleId, receiverRoleId]]);
  }

  beforeAll(async () => {
    options = { connectionString: connectionString! };
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await cleanup();
    for (const roleId of [senderRoleId, receiverRoleId]) {
      await createRole(options, {
        roleId,
        name: roleId,
        title: "TASK-131 workspace MCP fixture role",
        description: "TASK-131 real mailbox bridge fixture.",
      });
    }
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("persists a typed handoff using the worker-bound sender identity", async () => {
    const response = await handleWorkspaceMcpRequest(JSON.stringify({
      jsonrpc: "2.0",
      id: "typed-handoff",
      method: "tools/call",
      params: {
        name: "send_to_role",
        arguments: {
          fromRoleId: "model-cannot-impersonate-this",
          toRoleId: receiverRoleId,
          body: "Research is ready for review.",
          handoffKind: "research.complete",
          factRef: { tenantId: "basileia", scope: "agent", roleId: senderRoleId, key: "research.findings" },
        },
      },
    }), { connectionString: connectionString!, tenantId: "basileia", fromRoleId: senderRoleId });

    expect(response).toMatchObject({ jsonrpc: "2.0", id: "typed-handoff" });
    const row = await pool.query<{ from_role_id: string; to_role_id: string; handoff_kind: string; fact_ref: unknown }>(
      `SELECT from_role_id, to_role_id, handoff_kind, fact_ref
       FROM role_messages WHERE from_role_id = $1 AND to_role_id = $2`,
      [senderRoleId, receiverRoleId],
    );
    expect(row.rows).toEqual([
      {
        from_role_id: senderRoleId,
        to_role_id: receiverRoleId,
        handoff_kind: "research.complete",
        fact_ref: { tenantId: "basileia", scope: "agent", roleId: senderRoleId, key: "research.findings" },
      },
    ]);
  });

  it("renames only the worker-bound calling role and rejects cross-role input", async () => {
    const identity = { connectionString: connectionString!, tenantId: "basileia", fromRoleId: senderRoleId };
    const listed = await handleWorkspaceMcpRequest(JSON.stringify({ jsonrpc: "2.0", id: "tool-list", method: "tools/list" }), identity);
    expect(listed).toMatchObject({ result: { tools: expect.arrayContaining([
      expect.objectContaining({ name: "rename_self", inputSchema: expect.objectContaining({ additionalProperties: false }) }),
    ]) } });

    const renamed = await handleWorkspaceMcpRequest(JSON.stringify({
      jsonrpc: "2.0", id: "rename-self", method: "tools/call",
      params: { name: "rename_self", arguments: { name: "Renamed by self" } },
    }), identity);
    expect(renamed).toMatchObject({ result: { content: [{ type: "text", text: expect.stringContaining("Renamed by self") }] } });
    expect((await getRole(options, senderRoleId))?.name).toBe("Renamed by self");

    const crossRoleAttempt = await handleWorkspaceMcpRequest(JSON.stringify({
      jsonrpc: "2.0", id: "cross-role", method: "tools/call",
      params: { name: "rename_self", arguments: { name: "Should not apply", roleId: receiverRoleId } },
    }), identity);
    expect(crossRoleAttempt).toMatchObject({ result: { isError: true } });
    expect((await getRole(options, receiverRoleId))?.name).toBe(receiverRoleId);
  });

  it("returns clear errors for empty and excessively long self-rename names", async () => {
    const identity = { connectionString: connectionString!, tenantId: "basileia", fromRoleId: senderRoleId };
    for (const [name, error] of [["   ", "name must not be empty"], ["x".repeat(101), "name must be at most"]] as const) {
      const response = await handleWorkspaceMcpRequest(JSON.stringify({
        jsonrpc: "2.0", id: `invalid-${name.length}`, method: "tools/call",
        params: { name: "rename_self", arguments: { name } },
      }), identity);
      expect(response).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining(error) }] } });
    }
  });
});
