import { createHash, randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  Database,
  defaultPoolConfig,
  getApprovalByNonce,
  insertApproval,
  seedInboxTriage,
  type DatabaseOptions,
} from "../src/index.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("approvals persistence", () => {
  const options: DatabaseOptions = { connectionString: connectionString! };
  let database: Database;
  let pool: Pool;
  let runId: string;

  beforeAll(async () => {
    database = new Database(options);
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await seedInboxTriage(database);

    const task = await pool.query<{ task_id: string }>(
      `INSERT INTO tasks (role_id, title, goal, requested_by)
       VALUES ($1, $2, $3, $4)
       RETURNING task_id`,
      [
        "inbox-triage",
        "TASK-020 approval fixture",
        "round-trip an approval row",
        "test:task-020",
      ],
    );
    const taskId = task.rows[0]?.task_id;
    if (taskId === undefined) {
      throw new Error("failed to insert TASK-020 fixture task");
    }
    const run = await pool.query<{ run_id: string }>(
      `INSERT INTO runs (task_id, provider)
       VALUES ($1, $2)
       RETURNING run_id`,
      [taskId, "test"],
    );
    const insertedRunId = run.rows[0]?.run_id;
    if (insertedRunId === undefined) {
      throw new Error("failed to insert TASK-020 fixture run");
    }
    runId = insertedRunId;
  });

  afterAll(async () => {
    await database.close();
    await pool.end();
  });

  it("round-trips digest, render, destination, nonce and expiry", async () => {
    const nonce = randomUUID();
    const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000);
    const actionDigest = createHash("sha256")
      .update("task-020-approval-binding")
      .digest();
    const actionRender = "create draft to review@example.test";
    const destination = "review@example.test";

    const inserted = await insertApproval(options, {
      runId,
      capabilityId: "email.create_draft",
      actionDigest,
      actionRender,
      destination,
      nonce,
      expiresAt,
    });

    expect(inserted.approvalId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(inserted.tenantId).toBe("basileia");
    expect(inserted.runId).toBe(runId);
    expect(inserted.capabilityId).toBe("email.create_draft");
    expect(inserted.actionDigest.equals(actionDigest)).toBe(true);
    expect(inserted.actionRender).toBe(actionRender);
    expect(inserted.destination).toBe(destination);
    expect(inserted.nonce).toBe(nonce);
    expect(inserted.status).toBe("pending");
    expect(inserted.expiresAt).toEqual(expiresAt);
    expect(inserted.decidedBy).toBeNull();
    expect(inserted.decidedAt).toBeNull();
    expect(inserted.consumedAt).toBeNull();

    const fetched = await getApprovalByNonce(options, nonce);
    expect(fetched).not.toBeNull();
    expect(fetched).toEqual(inserted);
  });

  it("returns null for an unknown nonce instead of throwing", async () => {
    await expect(getApprovalByNonce(options, randomUUID())).resolves.toBeNull();
  });
});
