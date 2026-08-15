import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  Database,
  getApprovalByNonce,
  seedInboxTriage,
  type DatabaseOptions,
} from "@oikonomos/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { issueApproval } from "../src/issue.js";
import { sweepExpiredApprovals } from "../src/sweep.js";
import { createDatabaseStore } from "../src/store.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

interface PgPool {
  query<T extends object = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
  end(): Promise<void>;
}

interface PgModule {
  Pool: new (config: { connectionString: string }) => PgPool;
}

const requireFromDb = createRequire(
  fileURLToPath(new URL("../../db/package.json", import.meta.url)),
);
const { Pool } = requireFromDb("pg") as PgModule;

const RACERS = 8;
const EXPIRED_ROWS = 12;

integration("expiry sweeper against compose Postgres (OIK-024)", () => {
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
        "TASK-015 approval sweep fixture",
        "expire pending approvals idempotently",
        "test:task-015",
      ],
    );
    const taskId = task.rows[0]?.task_id;
    if (taskId === undefined) {
      throw new Error("failed to insert TASK-015 sweep fixture task");
    }
    const run = await pool.query<{ run_id: string }>(
      `INSERT INTO runs (task_id, provider)
       VALUES ($1, $2)
       RETURNING run_id`,
      [taskId, "test"],
    );
    const insertedRunId = run.rows[0]?.run_id;
    if (insertedRunId === undefined) {
      throw new Error("failed to insert TASK-015 sweep fixture run");
    }
    runId = insertedRunId;
  });

  afterAll(async () => {
    await database.close();
    await pool.end();
  });

  it("expires pending rows once under repeated and concurrent sweeps", async () => {
    const store = createDatabaseStore(options);
    const expiredAt = new Date(Date.now() - 10_000);
    const liveAt = new Date(Date.now() + 60 * 60 * 1000);

    const expiredSignals = await Promise.all(
      Array.from({ length: EXPIRED_ROWS }, (_, index) =>
        issueApproval(
          {
            runId,
            capabilityId: "email.create_draft",
            toolName: "mcp__gmail__create_draft",
            input: { to: `expired${index}@example.test` },
            destination: `expired${index}@example.test`,
            expiresAt: expiredAt,
          },
          { store },
        ),
      ),
    );
    const live = await issueApproval(
      {
        runId,
        capabilityId: "email.create_draft",
        toolName: "mcp__gmail__create_draft",
        input: { to: "live@example.test" },
        destination: "live@example.test",
        expiresAt: liveAt,
      },
      { store },
    );

    const raced = await Promise.all(
      Array.from({ length: RACERS }, () => sweepExpiredApprovals({ database: options })),
    );
    expect(raced.reduce((sum, result) => sum + result.expired, 0)).toBe(EXPIRED_ROWS);
    expect(raced.every((result) => result.expired >= 0)).toBe(true);

    const second = await sweepExpiredApprovals({ store });
    expect(second).toEqual({ expired: 0 });

    const fetchedExpired = await Promise.all(
      expiredSignals.map((signal) => getApprovalByNonce(options, signal.nonce)),
    );
    expect(fetchedExpired.every((row) => row?.status === "expired")).toBe(true);

    const fetchedLive = await getApprovalByNonce(options, live.nonce);
    expect(fetchedLive).not.toBeNull();
    expect(fetchedLive!.status).toBe("pending");
  });
});
