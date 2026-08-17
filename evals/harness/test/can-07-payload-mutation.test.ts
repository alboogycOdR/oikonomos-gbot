import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  createDatabaseStore,
  issueApproval,
  verifyAndConsume,
} from "@oikonomos/approvals";
import { handlePreToolUse } from "@oikonomos/broker";
import { Database, getApprovalByNonce, seedInboxTriage, type DatabaseOptions } from "@oikonomos/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  canaryCompose,
  createBrokerDeps,
  grantRow,
  invokeL1,
  permissionDecision,
  sendInput,
  TIER3_CAPABILITY_ID,
  TIER3_TOOL,
} from "./helpers.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

describe("CAN-07 — payload mutation invalidates the grant (in-process store)", () => {
  it("denies the mutated execute and marks the row invalidated", async () => {
    const built = createBrokerDeps();

    const issue = canaryCompose({
      pretooluse: { handlePreToolUse, dependencies: built.deps },
    });
    const pending = permissionDecision(
      await invokeL1(issue.composed, TIER3_TOOL, "can-07-issue", sendInput()),
    );
    expect(pending.reason).toBe("approval_pending");

    const issued = [...built.approvals.rows.values()][0];
    expect(issued).toBeDefined();
    const nonce = issued!.nonce;
    grantRow(built.approvals.rows, nonce);

    const mutated = canaryCompose({
      pretooluse: { handlePreToolUse, dependencies: built.deps },
      approvalNonceFor: () => nonce,
    });
    const denied = permissionDecision(
      await invokeL1(mutated.composed, TIER3_TOOL, "can-07-mutate", sendInput("eve@example.test")),
    );
    expect(denied.decision).toBe("deny");
    expect(denied.reason).toBe("approval.not_granted");
    expect(built.approvals.rows.get(nonce)?.status).toBe("invalidated");

    const retry = canaryCompose({
      pretooluse: { handlePreToolUse, dependencies: built.deps },
      approvalNonceFor: () => nonce,
    });
    const stillDenied = permissionDecision(
      await invokeL1(retry.composed, TIER3_TOOL, "can-07-retry", sendInput()),
    );
    expect(stillDenied.decision).toBe("deny");
    expect(stillDenied.reason).toBe("approval.not_granted");
    expect(built.approvals.rows.get(nonce)?.status).toBe("invalidated");
  });
});

describe("CAN-07 visibility — DATABASE_URL gate", () => {
  it("is visibly skipped when DATABASE_URL is unset, and present when set", () => {
    if (connectionString !== undefined) {
      expect(connectionString.length).toBeGreaterThan(0);
      return;
    }
    expect(connectionString).toBeUndefined();
  });
});

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

integration("CAN-07 — payload mutation (Postgres atomicity)", () => {
  const options: DatabaseOptions = { connectionString: connectionString! };
  let database: Database;
  let pool: PgPool;
  let runId: string;

  beforeAll(async () => {
    const requireFromDb = createRequire(
      fileURLToPath(new URL("../../../packages/db/package.json", import.meta.url)),
    );
    const { Pool } = requireFromDb("pg") as PgModule;
    database = new Database(options);
    pool = new Pool({ connectionString: connectionString! });
    await seedInboxTriage(database);

    const task = await pool.query<{ task_id: string }>(
      `INSERT INTO tasks (role_id, title, goal, requested_by)
       VALUES ($1, $2, $3, $4)
       RETURNING task_id`,
      ["inbox-triage", "CAN-07 payload mutation", "invalidate on digest mismatch", "canary:035"],
    );
    const taskId = task.rows[0]?.task_id;
    if (taskId === undefined) {
      throw new Error("CAN-07 failed to insert fixture task");
    }
    const run = await pool.query<{ run_id: string }>(
      `INSERT INTO runs (task_id, provider) VALUES ($1, $2) RETURNING run_id`,
      [taskId, "test"],
    );
    const inserted = run.rows[0]?.run_id;
    if (inserted === undefined) {
      throw new Error("CAN-07 failed to insert fixture run");
    }
    runId = inserted;
  });

  afterAll(async () => {
    await database.close();
    await pool.end();
  });

  it("digest mismatch invalidates; original nonce cannot later consume", async () => {
    const store = createDatabaseStore(options);
    const original = {
      runId,
      capabilityId: TIER3_CAPABILITY_ID,
      toolName: TIER3_TOOL,
      input: { to: "review@example.test", subject: "CAN-07" },
      destination: "review@example.test",
    };
    const signal = await issueApproval(original, { store });
    const granted = await pool.query(
      `UPDATE approvals SET status = 'granted', decided_by = $2, decided_at = now() WHERE nonce = $1`,
      [signal.nonce, "canary:035"],
    );
    expect(granted.rowCount).toBe(1);

    const denied = await verifyAndConsume(signal.nonce, { database: options }, {
      toolName: original.toolName,
      input: { to: "eve@example.test", subject: "CAN-07" },
      destination: original.destination,
    });
    expect(denied).toEqual({ consumed: false, rowCount: 0 });

    const afterMismatch = await getApprovalByNonce(options, signal.nonce);
    expect(afterMismatch?.status).toBe("invalidated");
    expect(afterMismatch?.consumedAt).toBeNull();

    const retry = await verifyAndConsume(signal.nonce, { store }, {
      toolName: original.toolName,
      input: original.input,
      destination: original.destination,
    });
    expect(retry).toEqual({ consumed: false, rowCount: 0 });
    expect((await getApprovalByNonce(options, signal.nonce))?.status).toBe("invalidated");
  });
});
