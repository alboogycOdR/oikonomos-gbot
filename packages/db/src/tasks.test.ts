import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTask, defaultPoolConfig, getTask, listTasks } from "./index.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("packages/db tasks — read + CRUD (TASK-061 / OIK-084)", () => {
  let pool: Pool;
  const roleId = "task-061-tasks-suite";

  async function cleanup(): Promise<void> {
    await pool.query(`DELETE FROM tasks WHERE role_id = $1`, [roleId]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await pool.end();
  });

  it("creates a task against the live schema and reads it back byte-identical", async () => {
    const created = await createTask(
      { connectionString: connectionString! },
      {
        roleId,
        title: "Triage inbox",
        goal: "Draft replies to unread mail",
        requestedBy: "alister",
      },
    );

    expect(created.status).toBe("draft");
    expect(created.tenantId).toBe("basileia");
    expect(created.routineId).toBeNull();

    const fetched = await getTask({ connectionString: connectionString! }, created.taskId);
    expect(fetched).toEqual(created);
  });

  it("getTask returns null for an unknown taskId", async () => {
    const result = await getTask(
      { connectionString: connectionString! },
      "00000000-0000-0000-0000-000000000000",
    );
    expect(result).toBeNull();
  });

  it("listTasks paginates newest-first and the cursor never repeats or skips a row", async () => {
    await cleanup();
    const created = [];
    for (let i = 0; i < 5; i += 1) {
      created.push(
        await createTask(
          { connectionString: connectionString! },
          { roleId, title: `task-${i}`, goal: "g", requestedBy: "alister" },
        ),
      );
    }

    const firstPage = await listTasks(
      { connectionString: connectionString! },
      { tenantId: "basileia", status: "draft", limit: 2 },
    );
    expect(firstPage.tasks).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();
    // Newest-first: the most recently created row of our five leads.
    expect(firstPage.tasks[0]?.taskId).toBe(created[4]?.taskId);

    const seen = new Set(firstPage.tasks.map((t) => t.taskId));
    let cursor = firstPage.nextCursor;
    let guard = 0;
    while (cursor !== null && guard < 10) {
      const page = await listTasks(
        { connectionString: connectionString! },
        { tenantId: "basileia", status: "draft", limit: 2, cursor },
      );
      for (const task of page.tasks) {
        expect(seen.has(task.taskId)).toBe(false);
        seen.add(task.taskId);
      }
      cursor = page.nextCursor;
      guard += 1;
    }

    for (const task of created) {
      expect(seen.has(task.taskId)).toBe(true);
    }
  });
});
