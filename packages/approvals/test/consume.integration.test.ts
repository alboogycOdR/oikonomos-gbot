import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  CONSUME_APPROVAL_SQL,
  consumeApproval,
  Database,
  getApprovalByNonce,
  insertApproval,
  seedInboxTriage,
  type Approval,
  type DatabaseOptions,
} from "@oikonomos/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { verifyAndConsume } from "../src/consume.js";
import { createDatabaseStore } from "../src/store.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

interface PgResult<T extends object> {
  rows: T[];
  rowCount: number | null;
}

interface PgClient {
  query<T extends object = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PgResult<T>>;
  release(): void;
}

interface PgPool {
  query<T extends object = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<PgResult<T>>;
  connect(): Promise<PgClient>;
  end(): Promise<void>;
}

interface PgModule {
  Pool: new (config: { connectionString: string; max?: number }) => PgPool;
}

const requireFromDb = createRequire(
  fileURLToPath(new URL("../../db/package.json", import.meta.url)),
);
const { Pool } = requireFromDb("pg") as PgModule;

const RACERS = 16;

integration("consumeApproval against compose Postgres", () => {
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
        "TASK-014 approval consume fixture",
        "atomic consume of a granted nonce",
        "test:task-014",
      ],
    );
    const taskId = task.rows[0]?.task_id;
    if (taskId === undefined) {
      throw new Error("failed to insert TASK-014 fixture task");
    }
    const run = await pool.query<{ run_id: string }>(
      `INSERT INTO runs (task_id, provider)
       VALUES ($1, $2)
       RETURNING run_id`,
      [taskId, "test"],
    );
    const insertedRunId = run.rows[0]?.run_id;
    if (insertedRunId === undefined) {
      throw new Error("failed to insert TASK-014 fixture run");
    }
    runId = insertedRunId;
  });

  afterAll(async () => {
    await database.close();
    await pool.end();
  });

  async function insertPending(overrides: { expiresAt?: Date; nonce?: string } = {}): Promise<Approval> {
    return insertApproval(options, {
      runId,
      capabilityId: "email.create_draft",
      actionDigest: createHash("sha256").update(`task-014-${randomUUID()}`).digest(),
      actionRender: "create draft to review@example.test",
      destination: "review@example.test",
      nonce: overrides.nonce ?? randomUUID(),
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 4 * 60 * 60 * 1000),
    });
  }

  async function grant(nonce: string): Promise<void> {
    const updated = await pool.query(
      `UPDATE approvals
       SET status = 'granted', decided_by = $2, decided_at = now()
       WHERE nonce = $1`,
      [nonce, "test:task-014"],
    );
    if (updated.rowCount !== 1) {
      throw new Error(`failed to grant fixture nonce ${nonce}`);
    }
  }

  it("consumes a granted unexpired nonce with rowCount 1", async () => {
    const inserted = await insertPending();
    await grant(inserted.nonce);

    const result = await consumeApproval(options, inserted.nonce);
    expect(result.rowCount).toBe(1);
    expect(result.approval).not.toBeNull();
    expect(result.approval!.status).toBe("consumed");
    expect(result.approval!.consumedAt).not.toBeNull();
    expect(result.approval!.nonce).toBe(inserted.nonce);

    const fetched = await getApprovalByNonce(options, inserted.nonce);
    expect(fetched).not.toBeNull();
    expect(fetched!.status).toBe("consumed");
    expect(fetched!.consumedAt).not.toBeNull();
  });

  it("honours expiry — a granted but expired approval cannot be consumed", async () => {
    const inserted = await insertPending({ expiresAt: new Date(Date.now() - 5_000) });
    await grant(inserted.nonce);

    const result = await consumeApproval(options, inserted.nonce);
    expect(result).toEqual({ rowCount: 0, approval: null });

    const fetched = await getApprovalByNonce(options, inserted.nonce);
    expect(fetched).not.toBeNull();
    expect(fetched!.status).toBe("granted");
    expect(fetched!.consumedAt).toBeNull();
  });

  it("denies replay of a consumed nonce and leaves status='consumed' (CAN-06)", async () => {
    const inserted = await insertPending();
    await grant(inserted.nonce);

    const first = await consumeApproval(options, inserted.nonce);
    expect(first.rowCount).toBe(1);
    const consumedAt = first.approval!.consumedAt;
    expect(consumedAt).not.toBeNull();

    const replay = await consumeApproval(options, inserted.nonce);
    expect(replay).toEqual({ rowCount: 0, approval: null });

    const fetched = await getApprovalByNonce(options, inserted.nonce);
    expect(fetched).not.toBeNull();
    expect(fetched!.status).toBe("consumed");
    expect(fetched!.consumedAt).toEqual(consumedAt);
  });

  it("does not consume a pending (not granted) approval", async () => {
    const inserted = await insertPending();

    const result = await consumeApproval(options, inserted.nonce);
    expect(result).toEqual({ rowCount: 0, approval: null });

    const fetched = await getApprovalByNonce(options, inserted.nonce);
    expect(fetched!.status).toBe("pending");
    expect(fetched!.consumedAt).toBeNull();
  });

  it("does not consume an invalidated approval", async () => {
    const inserted = await insertPending();
    await grant(inserted.nonce);
    const invalidated = await pool.query(
      `UPDATE approvals SET status = 'invalidated' WHERE nonce = $1`,
      [inserted.nonce],
    );
    expect(invalidated.rowCount).toBe(1);

    const result = await consumeApproval(options, inserted.nonce);
    expect(result).toEqual({ rowCount: 0, approval: null });

    const fetched = await getApprovalByNonce(options, inserted.nonce);
    expect(fetched!.status).toBe("invalidated");
    expect(fetched!.consumedAt).toBeNull();
  });

  it("returns rowCount 0 for an unknown nonce", async () => {
    await expect(consumeApproval(options, randomUUID())).resolves.toEqual({
      rowCount: 0,
      approval: null,
    });
  });

  it("exactly one of N parallel consumeApproval calls succeeds", async () => {
    const inserted = await insertPending();
    await grant(inserted.nonce);

    const results = await Promise.all(
      Array.from({ length: RACERS }, () => consumeApproval(options, inserted.nonce)),
    );

    expect(results.filter((result) => result.rowCount === 1)).toHaveLength(1);
    expect(results.filter((result) => result.rowCount === 0)).toHaveLength(RACERS - 1);

    const fetched = await getApprovalByNonce(options, inserted.nonce);
    expect(fetched!.status).toBe("consumed");
    expect(fetched!.consumedAt).not.toBeNull();
  });

  it("exactly one success when pre-connected clients race the pinned statement", async () => {
    const inserted = await insertPending();
    await grant(inserted.nonce);

    const racers = Array.from({ length: RACERS }, () => new Pool({ connectionString: connectionString!, max: 1 }));
    const clients = await Promise.all(racers.map((racer) => racer.connect()));
    try {
      const raced = await Promise.all(
        clients.map((client) =>
          client.query<{ approval_id: string }>(
            `${CONSUME_APPROVAL_SQL} RETURNING approval_id`,
            [inserted.nonce, null, null],
          ),
        ),
      );
      expect(raced.filter((result) => result.rowCount === 1)).toHaveLength(1);
      expect(raced.filter((result) => result.rowCount === 0)).toHaveLength(RACERS - 1);
    } finally {
      for (const client of clients) {
        client.release();
      }
      await Promise.all(racers.map((racer) => racer.end()));
    }

    const fetched = await getApprovalByNonce(options, inserted.nonce);
    expect(fetched!.status).toBe("consumed");
  });

  it("verifyAndConsume over DatabaseOptions also gates on row count 1", async () => {
    const inserted = await insertPending();
    await grant(inserted.nonce);

    const allowed = await verifyAndConsume(inserted.nonce, { database: options });
    expect(allowed.consumed).toBe(true);
    if (!allowed.consumed) {
      throw new Error("expected verifyAndConsume to succeed");
    }
    expect(allowed.approval.status).toBe("consumed");

    const denied = await verifyAndConsume(inserted.nonce, {
      store: createDatabaseStore(options),
    });
    expect(denied).toEqual({ consumed: false, rowCount: 0 });
  });
});
