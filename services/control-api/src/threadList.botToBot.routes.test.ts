import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRole, createThread, defaultPoolConfig, sendRoleMessage, type DatabaseOptions } from "@oikonomos/db";

import { buildApp } from "./app.js";
import { buildSessionCookie, createSessionToken } from "./auth.js";
import { createDatabaseBackedDeps } from "./ports.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;
const authToken = "task-356-thread-list-secret";
const tenantId = "task-356-tenant";
const otherTenantId = "task-356-other-tenant";

integration("control-api GET /threads bot-to-bot read model (TASK-356, real Postgres)", () => {
  const options: DatabaseOptions = { connectionString: connectionString ?? "" };
  const fixturePrefix = `task-356-${randomUUID()}`;
  const senderRoleId = `${fixturePrefix}-sender`;
  const recipientRoleId = `${fixturePrefix}-recipient`;
  const foreignSenderRoleId = `${fixturePrefix}-foreign-sender`;
  const foreignRecipientRoleId = `${fixturePrefix}-foreign-recipient`;
  const roleIds = [senderRoleId, recipientRoleId, foreignSenderRoleId, foreignRecipientRoleId];
  let pool: Pool;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await Promise.all([
      createRole(options, { roleId: senderRoleId, tenantId, name: "BotA", title: "Bot A" }),
      createRole(options, { roleId: recipientRoleId, tenantId, name: "BotB", title: "Bot B" }),
      createRole(options, { roleId: foreignSenderRoleId, tenantId: otherTenantId, name: "ForeignA", title: "Foreign A" }),
      createRole(options, { roleId: foreignRecipientRoleId, tenantId: otherTenantId, name: "ForeignB", title: "Foreign B" }),
    ]);
    await createThread(options, { roleId: senderRoleId });
    const earlier = await sendRoleMessage(options, {
      tenantId,
      fromRoleId: senderRoleId,
      toRoleId: recipientRoleId,
      body: "Earlier handoff",
    });
    await pool.query("UPDATE role_messages SET created_at = now() - interval '1 minute' WHERE message_id = $1", [earlier.messageId]);
    await sendRoleMessage(options, {
      tenantId,
      fromRoleId: senderRoleId,
      toRoleId: recipientRoleId,
      body: "  Shared\n browser probe  ",
    });
    await sendRoleMessage(options, {
      tenantId: otherTenantId,
      fromRoleId: foreignSenderRoleId,
      toRoleId: foreignRecipientRoleId,
      body: "Foreign tenant handoff",
    });
    app = buildApp(createDatabaseBackedDeps(options), { authToken, logger: false });
  });

  afterAll(async () => {
    await app.close();
    await pool.query("DELETE FROM role_messages WHERE from_role_id = ANY($1) OR to_role_id = ANY($1)", [roleIds]);
    await pool.query("DELETE FROM thread_viewer_states WHERE thread_id IN (SELECT id FROM threads WHERE role_id = ANY($1))", [roleIds]);
    await pool.query("DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE role_id = ANY($1))", [roleIds]);
    await pool.query("DELETE FROM thread_members WHERE role_id = ANY($1)", [roleIds]);
    await pool.query("DELETE FROM threads WHERE role_id = ANY($1)", [roleIds]);
    await pool.query("DELETE FROM roles WHERE role_id = ANY($1)", [roleIds]);
    await pool.end();
  });

  it("exposes one tenant-scoped bot pair and the sender's latest outbound preview", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/threads",
      headers: { cookie: buildSessionCookie(createSessionToken(authToken, tenantId)) },
    });

    expect(response.statusCode).toBe(200);
    const entries = JSON.parse(response.body) as Array<{
      id: string;
      roleId?: string;
      kind?: string;
      memberRoleIds?: string[];
      title: string | null;
      preview: { text: string; authorKind: string } | null;
      lastMessageAt: string | null;
    }>;
    const pair = entries.find((entry) => entry.kind === "bot_pair");
    expect(pair).toEqual(expect.objectContaining({
      id: `bot_pair:${[senderRoleId, recipientRoleId].sort().join(":")}`,
      kind: "bot_pair",
      memberRoleIds: [senderRoleId, recipientRoleId].sort(),
      title: "BotA and BotB",
      preview: { text: "Shared browser probe", authorKind: "bot" },
      lastMessageAt: expect.any(String),
    }));
    const sender = entries.find((entry) => entry.roleId === senderRoleId);
    expect(sender?.preview).toEqual({ text: "Messaged BotB: Shared browser probe", authorKind: "bot_outbound" });
    expect(new Date(pair!.lastMessageAt!).getTime()).toBe(new Date(sender!.lastMessageAt!).getTime());
    expect(entries.some((entry) => entry.title === "ForeignA and ForeignB")).toBe(false);
  });
});
