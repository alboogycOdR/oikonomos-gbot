import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createRole,
  defaultPoolConfig,
  getOrCreateThreadForRole,
  insertMessage,
  listMessages,
} from "./index.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("packages/db messages — transcript round trip (TASK-105)", () => {
  let pool: Pool;
  const tenantId = "task-105-messages-suite";
  const roleId = "task-105-messages-suite-role";
  let threadId: string;

  async function cleanup(): Promise<void> {
    await pool.query("DELETE FROM messages WHERE thread_id IN (SELECT id FROM threads WHERE role_id = $1)", [roleId]);
    await pool.query("DELETE FROM thread_members WHERE thread_id IN (SELECT id FROM threads WHERE role_id = $1)", [roleId]);
    await pool.query("DELETE FROM threads WHERE role_id = $1", [roleId]);
    await pool.query("DELETE FROM roles WHERE role_id = $1", [roleId]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await cleanup();
    await createRole(
      { connectionString: connectionString! },
      { roleId, tenantId, name: "Messages Suite", title: "Messages Suite Role" },
    );
    threadId = (await getOrCreateThreadForRole({ connectionString: connectionString! }, { roleId })).id;
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("round-trips messages oldest-first and returns only rows after the exclusive cursor", async () => {
    const first = await insertMessage({ connectionString: connectionString! }, { threadId, role: "user", body: "first" });
    const second = await insertMessage({ connectionString: connectionString! }, { threadId, role: "bot", body: "second" });
    const third = await insertMessage({ connectionString: connectionString! }, { threadId, role: "system", body: "third" });

    const transcript = await listMessages({ connectionString: connectionString! }, threadId);
    expect(transcript.map((message) => message.id)).toEqual([first.id, second.id, third.id]);
    expect(transcript.map((message) => message.body)).toEqual(["first", "second", "third"]);
    expect(transcript.map((message) => message.senderRoleId)).toEqual([null, null, null]);

    const afterFirst = await listMessages({ connectionString: connectionString! }, threadId, { after: first.id });
    expect(afterFirst.map((message) => message.id)).toEqual([second.id, third.id]);
  });

  it("persists and reads back senderRoleId alongside existing role='user'/'bot' rows (TASK-120)", async () => {
    const userMessage = await insertMessage({ connectionString: connectionString! }, { threadId, role: "user", body: "human line" });
    expect(userMessage.senderRoleId).toBeNull();

    const botMessage = await insertMessage(
      { connectionString: connectionString! },
      { threadId, role: "bot", body: "bot line", senderRoleId: roleId },
    );
    expect(botMessage.senderRoleId).toBe(roleId);

    const transcript = await listMessages({ connectionString: connectionString! }, threadId, { after: userMessage.id });
    const reread = transcript.find((message) => message.id === botMessage.id);
    expect(reread?.senderRoleId).toBe(roleId);
  });

  it("persists and reads back a structured attachments array (TASK-166)", async () => {
    const attachment = {
      id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      filename: "notes.txt",
      contentType: "text/plain",
      byteSize: 12,
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    };
    const written = await insertMessage(
      { connectionString: connectionString! },
      { threadId, role: "user", body: "see attached", attachments: [attachment] },
    );
    expect(written.attachments).toEqual([attachment]);

    const emptyBody = await insertMessage(
      { connectionString: connectionString! },
      {
        threadId,
        role: "user",
        body: "   ",
        attachments: [{ ...attachment, id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" }],
      },
    );
    expect(emptyBody.body).toBe("");
    expect(emptyBody.attachments).toEqual([{ ...attachment, id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" }]);

    const reread = (await listMessages({ connectionString: connectionString! }, threadId)).find(
      (message) => message.id === written.id,
    );
    expect(reread?.attachments).toEqual([attachment]);
    expect(reread).not.toHaveProperty("storageKey");
    expect(reread).not.toHaveProperty("absolutePath");
  });
});
