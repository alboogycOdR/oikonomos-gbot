import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  Database,
  getApprovalByNonce,
  seedInboxTriage,
  type DatabaseOptions,
} from "@oikonomos/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { verifyAndConsume } from "../src/consume.js";
import { issueApproval } from "../src/issue.js";
import { createDatabaseStore } from "../src/store.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

interface PgResult<T extends object> {
  rows: T[];
  rowCount: number | null;
}

interface PgPool {
  query<T extends object = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PgResult<T>>;
  end(): Promise<void>;
}

interface PgModule {
  Pool: new (config: { connectionString: string }) => PgPool;
}

const requireFromDb = createRequire(
  fileURLToPath(new URL("../../db/package.json", import.meta.url)),
);
const { Pool } = requireFromDb("pg") as PgModule;

integration("digest mismatch invalidates a granted row (CAN-07)", () => {
  const options: DatabaseOptions = { connectionString: connectionString! };
  let database: Database;
  let pool: PgPool;
  let runId: string;

  beforeAll(async () => {
    database = new Database(options);
    pool = new Pool({ connectionString: connectionString! });
    await seedInboxTriage(database);

    const task = await pool.query<{ task_id: string }>(
      `INSERT INTO tasks (role_id, title, goal, requested_by)
       VALUES ($1, $2, $3, $4)
       RETURNING task_id`,
      [
        "inbox-triage",
        "TASK-015 approval invalidate fixture",
        "invalidate on payload mutation",
        "test:task-015",
      ],
    );
    const taskId = task.rows[0]?.task_id;
    if (taskId === undefined) {
      throw new Error("failed to insert TASK-015 invalidate fixture task");
    }
    const run = await pool.query<{ run_id: string }>(
      `INSERT INTO runs (task_id, provider)
       VALUES ($1, $2)
       RETURNING run_id`,
      [taskId, "test"],
    );
    const insertedRunId = run.rows[0]?.run_id;
    if (insertedRunId === undefined) {
      throw new Error("failed to insert TASK-015 invalidate fixture run");
    }
    runId = insertedRunId;
  });

  afterAll(async () => {
    await database.close();
    await pool.end();
  });

  async function grant(nonce: string): Promise<void> {
    const updated = await pool.query(
      `UPDATE approvals
       SET status = 'granted', decided_by = $2, decided_at = now()
       WHERE nonce = $1`,
      [nonce, "test:task-015"],
    );
    if (updated.rowCount !== 1) {
      throw new Error(`failed to grant fixture nonce ${nonce}`);
    }
  }

  it("marks the row invalidated and refuses a later matching consume", async () => {
    const store = createDatabaseStore(options);
    const original = {
      runId,
      capabilityId: "email.create_draft",
      toolName: "mcp__gmail__create_draft",
      input: { to: "review@example.test", subject: "placeholder subject" },
      destination: "review@example.test",
    };
    const signal = await issueApproval(original, { store });
    await grant(signal.nonce);

    const denied = await verifyAndConsume(
      signal.nonce,
      { database: options },
      {
        toolName: original.toolName,
        input: { to: "eve@example.test", subject: "placeholder subject" },
        destination: original.destination,
      },
    );
    expect(denied).toEqual({ consumed: false, rowCount: 0 });

    const afterMismatch = await getApprovalByNonce(options, signal.nonce);
    expect(afterMismatch).not.toBeNull();
    expect(afterMismatch!.status).toBe("invalidated");
    expect(afterMismatch!.consumedAt).toBeNull();

    const retry = await verifyAndConsume(
      signal.nonce,
      { store },
      {
        toolName: original.toolName,
        input: original.input,
        destination: original.destination,
      },
    );
    expect(retry).toEqual({ consumed: false, rowCount: 0 });

    const afterRetry = await getApprovalByNonce(options, signal.nonce);
    expect(afterRetry!.status).toBe("invalidated");
  });
});
