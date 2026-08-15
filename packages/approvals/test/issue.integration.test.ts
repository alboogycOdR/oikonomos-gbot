import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  Database,
  getApprovalByNonce,
  seedInboxTriage,
  type DatabaseOptions,
} from "@oikonomos/db";
import { actionDigest } from "@oikonomos/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { issueApproval } from "../src/issue.js";
import { actionRender } from "../src/render.js";
import { createDatabaseStore } from "../src/store.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

interface PgPool {
  query<T extends object = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}

interface PgModule {
  Pool: new (config: { connectionString: string }) => PgPool;
}

// pg is a dependency of @oikonomos/db, not of this package (TASK-009: no
// extra runtime deps). Resolve it from the db package for fixture SQL only.
const requireFromDb = createRequire(fileURLToPath(new URL("../../db/package.json", import.meta.url)));
const { Pool } = requireFromDb("pg") as PgModule;

integration("issueApproval against compose Postgres", () => {
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
        "TASK-013 approval issue fixture",
        "persist-then-wait an issued approval",
        "test:task-013",
      ],
    );
    const taskId = task.rows[0]?.task_id;
    if (taskId === undefined) {
      throw new Error("failed to insert TASK-013 fixture task");
    }
    const run = await pool.query<{ run_id: string }>(
      `INSERT INTO runs (task_id, provider)
       VALUES ($1, $2)
       RETURNING run_id`,
      [taskId, "test"],
    );
    const insertedRunId = run.rows[0]?.run_id;
    if (insertedRunId === undefined) {
      throw new Error("failed to insert TASK-013 fixture run");
    }
    runId = insertedRunId;
  });

  afterAll(async () => {
    await database.close();
    await pool.end();
  });

  it("persists digest, render, destination, nonce, and expiry before returning wait", async () => {
    const store = createDatabaseStore(options);
    const request = {
      runId,
      capabilityId: "email.create_draft",
      toolName: "mcp__gmail__create_draft",
      input: { to: "review@example.test", subject: "placeholder subject" },
      destination: "review@example.test",
    };

    const signal = await issueApproval(request, { store });

    // The wait signal is in hand — the row must already exist (WBS OIK-021).
    const row = await getApprovalByNonce(options, signal.nonce);
    expect(row).not.toBeNull();
    expect(row!.approvalId).toBe(signal.approvalId);
    expect(row!.actionRender).toBe(
      actionRender({
        toolName: request.toolName,
        input: request.input,
        destination: request.destination,
      }),
    );
    expect(row!.destination).toBe(request.destination);
    expect(row!.nonce).toBe(signal.nonce);
    expect(row!.expiresAt).toEqual(signal.expiresAt);
    expect(row!.status).toBe("pending");

    const expected = actionDigest({
      toolName: request.toolName,
      input: request.input,
      destination: request.destination,
    });
    expect(signal.actionDigest).toBe(expected);
    expect(row!.actionDigest.equals(Buffer.from(expected, "hex"))).toBe(true);
  });

  it("also persists when the caller passes DatabaseOptions rather than a store", async () => {
    const signal = await issueApproval(
      {
        runId,
        capabilityId: "email.create_draft",
        toolName: "mcp__gmail__create_draft",
        input: { to: "ops@example.test" },
        destination: "ops@example.test",
      },
      { database: options },
    );

    const row = await getApprovalByNonce(options, signal.nonce);
    expect(row).not.toBeNull();
    expect(row!.approvalId).toBe(signal.approvalId);
  });

  it("issues unique nonces under concurrent Postgres writes", async () => {
    const store = createDatabaseStore(options);
    const signals = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        issueApproval(
          {
            runId,
            capabilityId: "email.create_draft",
            toolName: "mcp__gmail__create_draft",
            input: { to: `n${index}@example.test` },
            destination: `n${index}@example.test`,
          },
          { store },
        ),
      ),
    );

    const nonces = signals.map((signal) => signal.nonce);
    expect(new Set(nonces).size).toBe(16);

    const fetched = await Promise.all(nonces.map((nonce) => getApprovalByNonce(options, nonce)));
    expect(fetched.every((row) => row !== null)).toBe(true);
  });
});
