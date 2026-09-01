import { randomUUID } from "node:crypto";

import {
  CONSUME_APPROVAL_SQL,
  Database,
  defaultPoolConfig,
  seedInboxTriage,
  type Approval,
  type DatabaseOptions,
  type NewApproval,
} from "@oikonomos/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { normalizeApprovalBinding } from "./binding.js";
import { verifyAndConsume } from "./consume.js";
import { issueApproval } from "./issue.js";
import type { ApprovalStore, ConsumeApprovalResult } from "./store.js";

const GENERATION = "11111111-2222-4333-8444-555555555555";
const NEXT_GENERATION = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

function pendingApproval(approval: NewApproval): Approval {
  return {
    approvalId: randomUUID(),
    tenantId: approval.tenantId ?? "basileia",
    runId: approval.runId,
    capabilityId: approval.capabilityId,
    actionDigest: Buffer.from(approval.actionDigest),
    actionRender: approval.actionRender,
    destination: approval.destination,
    nonce: approval.nonce ?? randomUUID(),
    status: "pending",
    requestedAt: new Date(),
    expiresAt: approval.expiresAt,
    decidedBy: null,
    decidedAt: null,
    consumedAt: null,
    controlPlaneGeneration: approval.controlPlaneGeneration ?? null,
    userContextEpoch: approval.userContextEpoch ?? null,
  };
}

describe("approval binding", () => {
  it("validates binding values before storage or redemption", () => {
    expect(normalizeApprovalBinding(undefined)).toBeUndefined();
    expect(
      normalizeApprovalBinding({
        controlPlaneGeneration: ` ${GENERATION} `,
        userContextEpoch: 0n,
      }),
    ).toEqual({ controlPlaneGeneration: GENERATION, userContextEpoch: 0n });
    expect(() => normalizeApprovalBinding({ controlPlaneGeneration: "not-a-uuid" })).toThrow(
      /controlPlaneGeneration/,
    );
    expect(() => normalizeApprovalBinding({ userContextEpoch: -1n })).toThrow(
      /userContextEpoch/,
    );
  });

  it("records issuer-supplied generation and epoch", async () => {
    let inserted: NewApproval | undefined;
    const store: ApprovalStore = {
      insert: async (approval) => {
        inserted = approval;
        return pendingApproval(approval);
      },
      getByNonce: async () => null,
      consume: async (): Promise<ConsumeApprovalResult> => ({ rowCount: 0, approval: null }),
      invalidate: async (): Promise<ConsumeApprovalResult> => ({ rowCount: 0, approval: null }),
      expirePending: async () => 0,
    };

    await issueApproval(
      {
        runId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        capabilityId: "email.create_draft",
        toolName: "mcp__gmail__create_draft",
        input: { to: "review@example.test" },
        destination: "review@example.test",
        controlPlaneGeneration: GENERATION,
        userContextEpoch: 41n,
      },
      { store },
    );

    expect(inserted).toMatchObject({
      controlPlaneGeneration: GENERATION,
      userContextEpoch: 41n,
    });
  });

  it("passes bindings into the store's atomic consume operation", async () => {
    let received: unknown;
    const store: ApprovalStore = {
      insert: async (approval) => pendingApproval(approval),
      getByNonce: async () => null,
      consume: async (_nonce, binding): Promise<ConsumeApprovalResult> => {
        received = binding;
        return { rowCount: 0, approval: null };
      },
      invalidate: async (): Promise<ConsumeApprovalResult> => ({ rowCount: 0, approval: null }),
      expirePending: async () => 0,
    };

    await expect(
      verifyAndConsume("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", { store }, undefined, {
        controlPlaneGeneration: GENERATION,
        userContextEpoch: 41n,
      }),
    ).resolves.toEqual({ consumed: false, rowCount: 0 });
    expect(received).toEqual({ controlPlaneGeneration: GENERATION, userContextEpoch: 41n });
  });

  it("pins both binding guards in the single-statement consume SQL", () => {
    expect(CONSUME_APPROVAL_SQL).toContain("control_plane_generation IS NULL OR");
    expect(CONSUME_APPROVAL_SQL).toContain("user_context_epoch IS NULL OR");
    expect(CONSUME_APPROVAL_SQL.match(/UPDATE approvals/g)).toHaveLength(1);
  });
});

interface PgPool {
  query<T extends object = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: T[] }>;
  end(): Promise<void>;
}

interface PgModule {
  Pool: new (config: Record<string, unknown>) => PgPool;
}

integration("approval binding against Postgres", () => {
  const options: DatabaseOptions = { connectionString: connectionString! };
  let database: Database;
  let pool: PgPool;
  let runId: string;

  beforeAll(async () => {
    const { createRequire } = await import("node:module");
    const { fileURLToPath } = await import("node:url");
    const requireFromDb = createRequire(
      fileURLToPath(new URL("../../db/package.json", import.meta.url)),
    );
    const { Pool } = requireFromDb("pg") as PgModule;
    database = new Database(options);
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
    await seedInboxTriage(database);
    const task = await pool.query<{ task_id: string }>(
      `INSERT INTO tasks (role_id, title, goal, requested_by)
       VALUES ($1, $2, $3, $4) RETURNING task_id`,
      ["inbox-triage", "TASK-065 binding fixture", "test approval binding", "test:task-065"],
    );
    const taskId = task.rows[0]?.task_id;
    if (taskId === undefined) throw new Error("failed to insert TASK-065 fixture task");
    const run = await pool.query<{ run_id: string }>(
      `INSERT INTO runs (task_id, provider) VALUES ($1, $2) RETURNING run_id`,
      [taskId, "test"],
    );
    runId = run.rows[0]?.run_id ?? (() => { throw new Error("failed to insert fixture run"); })();
  });

  afterAll(async () => {
    await database.close();
    await pool.end();
  });

  async function issueGranted(binding?: { controlPlaneGeneration?: string; userContextEpoch?: bigint }) {
    const signal = await issueApproval(
      {
        runId,
        capabilityId: "email.create_draft",
        toolName: "mcp__gmail__create_draft",
        input: { to: "review@example.test" },
        destination: "review@example.test",
        ...binding,
      },
      { database: options },
    );
    await pool.query("UPDATE " + "approvals SET status='granted' WHERE nonce=$1", [signal.nonce]);
    return signal;
  }

  it("refuses stale generation and stale epoch without consuming either row", async () => {
    const generationBound = await issueGranted({ controlPlaneGeneration: GENERATION });
    const epochBound = await issueGranted({ userContextEpoch: 41n });

    await expect(
      verifyAndConsume(generationBound.nonce, { database: options }, undefined, {
        controlPlaneGeneration: NEXT_GENERATION,
      }),
    ).resolves.toEqual({ consumed: false, rowCount: 0 });
    await expect(
      verifyAndConsume(epochBound.nonce, { database: options }, undefined, {
        userContextEpoch: 42n,
      }),
    ).resolves.toEqual({ consumed: false, rowCount: 0 });

    const statuses = await pool.query<{ nonce: string; status: string }>(
      `SELECT nonce, status FROM approvals WHERE nonce = ANY($1::uuid[])`,
      [[generationBound.nonce, epochBound.nonce]],
    );
    expect(statuses.rows.map((row) => row.status)).toEqual(["granted", "granted"]);
  });

  it("consumes a matching bound approval and a legacy unbound approval", async () => {
    const bound = await issueGranted({ controlPlaneGeneration: GENERATION, userContextEpoch: 41n });
    const unbound = await issueGranted();

    await expect(
      verifyAndConsume(bound.nonce, { database: options }, undefined, {
        controlPlaneGeneration: GENERATION,
        userContextEpoch: 41n,
      }),
    ).resolves.toMatchObject({ consumed: true, rowCount: 1 });
    await expect(verifyAndConsume(unbound.nonce, { database: options })).resolves.toMatchObject({
      consumed: true,
      rowCount: 1,
    });
  });
});
