import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";


import {
  createRole,
  defaultPoolConfig,
  getRoleMessage,
  listRoleMessages,
  markRoleMessageRead,
  sendRoleMessage,
} from "./index.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("packages/db roleMessages — read + CRUD + FK (TASK-084)", () => {
  let pool: Pool;
  const tenantId = "task-084-messages-suite";
  const fromRoleId = "task-084-messages-suite-from";
  const toRoleId = "task-084-messages-suite-to";

  async function cleanup(): Promise<void> {
    await pool.query(`DELETE FROM role_messages WHERE tenant_id = $1`, [tenantId]);
    await pool.query(`DELETE FROM roles WHERE role_id IN ($1, $2)`, [fromRoleId, toRoleId]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await cleanup();
    await createRole(
      { connectionString: connectionString! },
      { roleId: fromRoleId, tenantId, name: "From", title: "From Role" },
    );
    await createRole(
      { connectionString: connectionString! },
      { roleId: toRoleId, tenantId, name: "To", title: "To Role" },
    );
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("sends a handoff and reads it back byte-identical; unread by default (F8)", async () => {
    const sent = await sendRoleMessage(
      { connectionString: connectionString! },
      {
        tenantId,
        fromRoleId,
        toRoleId,
        body: "see /workspace/report.md",
        workspaceRefs: ["/workspace/report.md"],
      },
    );

    expect(sent.readAt).toBeNull();
    expect(sent.workspaceRefs).toEqual(["/workspace/report.md"]);

    const fetched = await getRoleMessage({ connectionString: connectionString! }, sent.messageId);
    expect(fetched).toEqual(sent);
    expect(sent.handoffKind).toBeNull();
    expect(sent.factRef).toBeNull();
  });


  it("getRoleMessage returns null for an unknown messageId", async () => {
    const result = await getRoleMessage(
      { connectionString: connectionString! },
      "00000000-0000-0000-0000-000000000000",
    );
    expect(result).toBeNull();
  });

  it("F8: from_role_id/to_role_id FKs reject a message referencing a role that does not exist", async () => {
    await expect(
      sendRoleMessage(
        { connectionString: connectionString! },
        { tenantId, fromRoleId: "task-084-messages-suite-nonexistent", toRoleId, body: "x" },
      ),
    ).rejects.toThrow(/foreign key/i);
    await expect(
      sendRoleMessage(
        { connectionString: connectionString! },
        { tenantId, fromRoleId, toRoleId: "task-084-messages-suite-nonexistent", body: "x" },
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("listRoleMessages filters to a role's inbox and unreadOnly excludes read messages", async () => {
    await pool.query(`DELETE FROM role_messages WHERE tenant_id = $1`, [tenantId]);
    const first = await sendRoleMessage(
      { connectionString: connectionString! },
      { tenantId, fromRoleId, toRoleId, body: "first" },
    );
    await sendRoleMessage(
      { connectionString: connectionString! },
      { tenantId, fromRoleId, toRoleId, body: "second" },
    );

    const inbox = await listRoleMessages({ connectionString: connectionString! }, { tenantId, toRoleId });
    expect(inbox).toHaveLength(2);
    expect(inbox[0]?.body).toBe("second"); // newest-first

    await markRoleMessageRead({ connectionString: connectionString! }, first.messageId);
    const unread = await listRoleMessages(
      { connectionString: connectionString! },
      { tenantId, toRoleId, unreadOnly: true },
    );
    expect(unread.map((m) => m.messageId)).not.toContain(first.messageId);
    expect(unread).toHaveLength(1);
  });

  it("markRoleMessageRead is idempotent: marking twice keeps the original readAt", async () => {
    const sent = await sendRoleMessage(
      { connectionString: connectionString! },
      { tenantId, fromRoleId, toRoleId, body: "idempotent-read" },
    );
    const firstMark = await markRoleMessageRead({ connectionString: connectionString! }, sent.messageId);
    expect(firstMark.readAt).not.toBeNull();

    const secondMark = await markRoleMessageRead({ connectionString: connectionString! }, sent.messageId);
    expect(secondMark.readAt).toEqual(firstMark.readAt);
  });

  it("markRoleMessageRead throws for an unknown messageId", async () => {
    await expect(
      markRoleMessageRead(
        { connectionString: connectionString! },
        "00000000-0000-0000-0000-000000000000",
      ),
    ).rejects.toThrow(/no role_messages row/);
  });
});
