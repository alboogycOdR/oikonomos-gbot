import { createRole, defaultPoolConfig, getRole, listMessages, type DatabaseOptions } from "@oikonomos/db";
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
      "DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE role_id = ANY($1::text[]))",
      [[senderRoleId, receiverRoleId]],
    );
    await pool.query("DELETE FROM threads WHERE role_id = ANY($1::text[])", [[senderRoleId, receiverRoleId]]);
    await pool.query("DELETE FROM role_routines WHERE role_id = ANY($1::text[])", [[senderRoleId, receiverRoleId]]);
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

  it("create_routine writes a real routine, computes next_fire_at from the cron, and posts a system confirmation to the thread", async () => {
    const thread = await pool.query<{ id: string }>("INSERT INTO threads (role_id) VALUES ($1) RETURNING id", [senderRoleId]);
    const threadId = thread.rows[0]!.id;
    const identity = { connectionString: connectionString!, tenantId: "basileia", fromRoleId: senderRoleId, threadId };

    const response = await handleWorkspaceMcpRequest(JSON.stringify({
      jsonrpc: "2.0", id: "create-routine", method: "tools/call",
      params: { name: "create_routine", arguments: { name: "Daily weather", schedule: "0 14 * * *", goal: "Check the weather" } },
    }), identity);

    expect(response).toMatchObject({
      result: { content: [{ type: "text", text: expect.stringContaining("\"description\":\"every day at 2:00 PM\"") }] },
    });

    const routine = await pool.query<{ name: string; schedule: string; next_fire_at: Date; definition: { goal?: string } }>(
      "SELECT name, schedule, next_fire_at, definition FROM role_routines WHERE role_id = $1",
      [senderRoleId],
    );
    expect(routine.rows).toHaveLength(1);
    expect(routine.rows[0]).toMatchObject({ name: "Daily weather", schedule: "0 14 * * *", definition: { goal: "Check the weather" } });
    expect(routine.rows[0]?.next_fire_at).toBeInstanceOf(Date);

    const messages = await listMessages(options, threadId);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "system", body: 'New routine "Daily weather" — every day at 2:00 PM' });
  });

  it("create_routine rejects a malformed cron expression before writing anything", async () => {
    const identity = { connectionString: connectionString!, tenantId: "basileia", fromRoleId: senderRoleId };
    const response = await handleWorkspaceMcpRequest(JSON.stringify({
      jsonrpc: "2.0", id: "bad-cron", method: "tools/call",
      params: { name: "create_routine", arguments: { name: "Bad schedule", schedule: "not a cron" } },
    }), identity);
    expect(response).toMatchObject({ result: { isError: true, content: [{ text: expect.stringContaining("cron") }] } });

    const routine = await pool.query("SELECT 1 FROM role_routines WHERE role_id = $1 AND name = $2", [senderRoleId, "Bad schedule"]);
    expect(routine.rowCount).toBe(0);
  });

  it("create_routine still works with no threadId (a routine-triggered run, not a live chat) — just skips the confirmation message", async () => {
    const identity = { connectionString: connectionString!, tenantId: "basileia", fromRoleId: senderRoleId };
    const response = await handleWorkspaceMcpRequest(JSON.stringify({
      jsonrpc: "2.0", id: "no-thread", method: "tools/call",
      params: { name: "create_routine", arguments: { name: "No thread routine", schedule: "0 9 * * 1" } },
    }), identity);
    expect(response).toMatchObject({ result: { content: [{ type: "text" }] } });
    const routine = await pool.query("SELECT 1 FROM role_routines WHERE role_id = $1 AND name = $2", [senderRoleId, "No thread routine"]);
    expect(routine.rowCount).toBe(1);
  });
});
