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

    const afterFirst = await listMessages({ connectionString: connectionString! }, threadId, { after: first.id });
    expect(afterFirst.map((message) => message.id)).toEqual([second.id, third.id]);
  });
});
