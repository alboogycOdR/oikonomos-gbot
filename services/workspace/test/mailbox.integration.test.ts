import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createRole, defaultPoolConfig } from "@oikonomos/db";

import { sendToRole } from "../src/mailbox.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("services/workspace sendToRole — end-to-end against real role_messages (TASK-090)", () => {
  let pool: Pool;
  const tenantId = "task-090-mailbox-suite";
  const fromRoleId = "task-090-mailbox-suite-from";
  const toRoleId = "task-090-mailbox-suite-to";
  const options = { connectionString: connectionString! };

  async function cleanup(): Promise<void> {
    await pool.query(`DELETE FROM role_messages WHERE tenant_id = $1`, [tenantId]);
    await pool.query(`DELETE FROM roles WHERE role_id IN ($1, $2)`, [fromRoleId, toRoleId]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await cleanup();
    await createRole(options, { roleId: fromRoleId, tenantId, name: "From", title: "From Role" });
    await createRole(options, { roleId: toRoleId, tenantId, name: "To", title: "To Role" });
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("persists a real handoff with a resolved, durable workspace ref and an unread receipt", async () => {
    const ack = await sendToRole(options, {
      tenantId,
      fromRoleId,
      toRoleId,
      body: "see the draft I left you",
      workspaceRefs: ["drafts/handoff.md"],
    });

    expect(ack.toRoleId).toBe(toRoleId);
    expect(ack.createdAt).toBeInstanceOf(Date);

    const result = await pool.query<{ workspace_refs: string[]; read_at: Date | null }>(
      `SELECT workspace_refs, read_at FROM role_messages WHERE message_id = $1`,
      [ack.messageId],
    );
    expect(result.rows[0]?.workspace_refs).toEqual(["/oikonomos/workspace/drafts/handoff.md"]);
    expect(result.rows[0]?.read_at).toBeNull();
  });

  it("refuses to persist a handoff whose workspace ref escapes the workspace root", async () => {
    await expect(
      sendToRole(options, {
        tenantId,
        fromRoleId,
        toRoleId,
        body: "x",
        workspaceRefs: ["../../etc/passwd"],
      }),
    ).rejects.toThrow();

    const result = await pool.query(`SELECT 1 FROM role_messages WHERE tenant_id = $1 AND body = 'x'`, [
      tenantId,
    ]);
    expect(result.rowCount).toBe(0);
  });
});
