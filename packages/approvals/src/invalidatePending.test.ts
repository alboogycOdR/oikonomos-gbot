import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  Database,
  seedInboxTriage,
  type Approval,
  type DatabaseOptions,
  type NewApproval,
} from "@oikonomos/db";

import { issueApproval, type IssueApprovalRequest } from "./issue.js";
import {
  invalidatePendingApproval,
  type InvalidatePendingDependencies,
} from "./invalidatePending.js";
import {
  createDatabaseStore,
  INVALIDATE_APPROVAL_SQL,
  INVALIDATE_PENDING_APPROVAL_SQL,
  type ApprovalStore,
  type ConsumeApprovalResult,
} from "./store.js";

if (import.meta.vitest) {
  const { afterAll, beforeAll, describe, expect, it } = import.meta.vitest;

  const RUN_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

  function fixtureRequest(
    overrides: Partial<IssueApprovalRequest> = {},
  ): IssueApprovalRequest {
    return {
      runId: RUN_ID,
      capabilityId: "email.create_draft",
      toolName: "mcp__gmail__create_draft",
      input: { to: "review@example.test", subject: "edited subject" },
      destination: "review@example.test",
      ...overrides,
    };
  }

  function createMemoryStore(): { store: ApprovalStore; rows: Map<string, Approval> } {
    const rows = new Map<string, Approval>();

    function transition(
      nonce: string,
      expected: Approval["status"],
      next: Approval["status"],
      requireUnexpired: boolean,
    ): ConsumeApprovalResult {
      const row = rows.get(nonce);
      if (
        row === undefined ||
        row.status !== expected ||
        row.consumedAt !== null ||
        (requireUnexpired && row.expiresAt.getTime() <= Date.now())
      ) {
        return { rowCount: 0, approval: null };
      }
      const updated = { ...row, status: next };
      rows.set(nonce, updated);
      return { rowCount: 1, approval: updated };
    }

    const store: ApprovalStore = {
      async insert(approval: NewApproval): Promise<Approval> {
        if (approval.nonce === undefined) {
          throw new Error("test store requires a nonce");
        }
        const row: Approval = {
          approvalId: randomUUID(),
          tenantId: approval.tenantId ?? "basileia",
          runId: approval.runId,
          capabilityId: approval.capabilityId,
          actionDigest: Buffer.from(approval.actionDigest),
          actionRender: approval.actionRender,
          destination: approval.destination,
          nonce: approval.nonce,
          status: "pending",
          requestedAt: new Date(),
          expiresAt: approval.expiresAt,
          decidedBy: null,
          decidedAt: null,
          consumedAt: null,
        };
        rows.set(row.nonce, row);
        return row;
      },
      async getByNonce(nonce) {
        return rows.get(nonce) ?? null;
      },
      async consume(nonce) {
        const result = transition(nonce, "granted", "consumed", true);
        if (result.approval !== null) {
          const consumed = { ...result.approval, consumedAt: new Date() };
          rows.set(nonce, consumed);
          return { rowCount: 1, approval: consumed };
        }
        return result;
      },
      async invalidate(nonce) {
        return transition(nonce, "granted", "invalidated", false);
      },
      async invalidatePending(nonce) {
        return transition(nonce, "pending", "invalidated", true);
      },
      async expirePending() {
        let count = 0;
        for (const [nonce, row] of rows) {
          if (row.status === "pending" && row.expiresAt.getTime() <= Date.now()) {
            rows.set(nonce, { ...row, status: "expired" });
            count += 1;
          }
        }
        return count;
      },
      async grant(nonce, decidedBy) {
        const result = transition(nonce, "pending", "granted", true);
        if (result.approval === null) {
          return result;
        }
        const granted = { ...result.approval, decidedBy, decidedAt: new Date() };
        rows.set(nonce, granted);
        return { rowCount: 1, approval: granted };
      },
      async reject(nonce, decidedBy) {
        const result = transition(nonce, "pending", "rejected", true);
        if (result.approval === null) {
          return result;
        }
        const rejected = { ...result.approval, decidedBy, decidedAt: new Date() };
        rows.set(nonce, rejected);
        return { rowCount: 1, approval: rejected };
      },
    };
    return { store, rows };
  }

  async function issuePending(store: ApprovalStore, overrides = {}) {
    return issueApproval(fixtureRequest(overrides), { store });
  }

  describe("invalidatePendingApproval — pending edit transition", () => {
    it("uses the one pinned pending-only statement; removing its status guard fails this test", () => {
      expect(INVALIDATE_PENDING_APPROVAL_SQL).toContain("status='pending'");
      expect(INVALIDATE_PENDING_APPROVAL_SQL).toContain("expires_at>now()");
      expect(INVALIDATE_PENDING_APPROVAL_SQL).toContain("consumed_at IS NULL");
    });

    it("keeps the original granted-only OIK-023 statement byte-for-byte disjoint", () => {
      expect(INVALIDATE_APPROVAL_SQL).toContain("status='granted'");
      expect(INVALIDATE_APPROVAL_SQL).not.toContain("status='pending'");
    });

    it("invalidates exactly one live pending nonce and never consumes it", async () => {
      const memory = createMemoryStore();
      const signal = await issuePending(memory.store);

      const result = await invalidatePendingApproval(signal.nonce, { store: memory.store });

      expect(result.invalidated).toBe(true);
      expect(memory.rows.get(signal.nonce)).toMatchObject({
        status: "invalidated",
        consumedAt: null,
      });
    });

    it("keeps pending and granted invalidation paths disjoint", async () => {
      const memory = createMemoryStore();
      const pending = await issuePending(memory.store);
      expect(await memory.store.invalidate(pending.nonce)).toEqual({ rowCount: 0, approval: null });
      expect((await invalidatePendingApproval(pending.nonce, { store: memory.store })).invalidated).toBe(
        true,
      );

      const granted = await issuePending(memory.store);
      await memory.store.grant!(granted.nonce, "test:cx");
      expect(
        await invalidatePendingApproval(granted.nonce, { store: memory.store }),
      ).toEqual({ invalidated: false, rowCount: 0 });
      expect((await memory.store.invalidate(granted.nonce)).rowCount).toBe(1);
    });

    it("allows exactly one of concurrent invalidations", async () => {
      const memory = createMemoryStore();
      const signal = await issuePending(memory.store);
      const results = await Promise.all(
        Array.from({ length: 16 }, () =>
          invalidatePendingApproval(signal.nonce, { store: memory.store }),
        ),
      );
      expect(results.filter((result) => result.invalidated)).toHaveLength(1);
      expect(results.filter((result) => !result.invalidated)).toHaveLength(15);
    });

    it("refuses expired, rejected, granted, invalidated, and consumed rows", async () => {
      const memory = createMemoryStore();
      const expired = await issuePending(memory.store, { expiresAt: new Date(Date.now() - 1) });
      const rejected = await issuePending(memory.store);
      const granted = await issuePending(memory.store);
      const invalidated = await issuePending(memory.store);
      const consumed = await issuePending(memory.store);
      await memory.store.expirePending();
      await memory.store.reject!(rejected.nonce, "test:cx");
      await memory.store.grant!(granted.nonce, "test:cx");
      await invalidatePendingApproval(invalidated.nonce, { store: memory.store });
      await memory.store.grant!(consumed.nonce, "test:cx");
      await memory.store.consume(consumed.nonce);

      for (const nonce of [
        expired.nonce,
        rejected.nonce,
        granted.nonce,
        invalidated.nonce,
        consumed.nonce,
      ]) {
        await expect(invalidatePendingApproval(nonce, { store: memory.store })).resolves.toEqual({
          invalidated: false,
          rowCount: 0,
        });
      }
    });

    it("fails closed before calling the store for an invalid nonce or missing port", async () => {
      let calls = 0;
      const missingPort: ApprovalStore = {
        insert: async () => {
          throw new Error("must not insert");
        },
        getByNonce: async () => null,
        consume: async () => ({ rowCount: 0, approval: null }),
        invalidate: async () => ({ rowCount: 0, approval: null }),
        expirePending: async () => 0,
      };
      const countingStore: ApprovalStore = {
        ...missingPort,
        invalidatePending: async () => {
          calls += 1;
          return { rowCount: 0, approval: null };
        },
      };
      await expect(invalidatePendingApproval("not-a-uuid", { store: countingStore })).rejects.toThrow(
        /nonce/,
      );
      expect(calls).toBe(0);
      await expect(invalidatePendingApproval(randomUUID(), { store: missingPort })).rejects.toThrow(
        /invalidatePending/,
      );
    });
  });

  const connectionString = process.env.DATABASE_URL;
  const integration = connectionString === undefined ? describe.skip : describe;

  integration("invalidatePendingApproval against compose Postgres", () => {
    const options: DatabaseOptions = { connectionString: connectionString! };
    const requireFromDb = createRequire(
      fileURLToPath(new URL("../../db/package.json", import.meta.url)),
    );
    const { Pool } = requireFromDb("pg") as {
      Pool: new (config: { connectionString: string }) => {
        query<T extends object = Record<string, unknown>>(
          text: string,
          values?: readonly unknown[],
        ): Promise<{ rows: T[]; rowCount: number | null }>;
        end(): Promise<void>;
      };
    };
    let database: Database;
    let pool: InstanceType<typeof Pool>;
    let runId: string;
    const deps: InvalidatePendingDependencies = { database: options };

    beforeAll(async () => {
      database = new Database(options);
      pool = new Pool({ connectionString: connectionString! });
      await seedInboxTriage(database);
      const task = await pool.query<{ task_id: string }>(
        `INSERT INTO tasks (role_id, title, goal, requested_by)
         VALUES ($1, $2, $3, $4) RETURNING task_id`,
        ["inbox-triage", "TASK-064 fixture", "pending approval invalidation", "test:task-064"],
      );
      const taskId = task.rows[0]?.task_id;
      if (taskId === undefined) throw new Error("failed to create TASK-064 fixture task");
      const run = await pool.query<{ run_id: string }>(
        "INSERT INTO runs (task_id, provider) VALUES ($1, $2) RETURNING run_id",
        [taskId, "test"],
      );
      runId = run.rows[0]?.run_id ?? (() => { throw new Error("failed to create run"); })();
    });

    afterAll(async () => {
      await database.close();
      await pool.end();
    });

    it("transitions one pending nonce, preserves consumed_at, and rejects a repeat", async () => {
      const store = createDatabaseStore(options);
      const signal = await issuePending(store, { runId });
      expect((await invalidatePendingApproval(signal.nonce, deps)).invalidated).toBe(true);
      expect(await invalidatePendingApproval(signal.nonce, deps)).toEqual({
        invalidated: false,
        rowCount: 0,
      });
      const row = await store.getByNonce(signal.nonce);
      expect(row).toMatchObject({ status: "invalidated", consumedAt: null });
    });

    it("proves the two database invalidation paths are disjoint", async () => {
      const store = createDatabaseStore(options);
      const pending = await issuePending(store, { runId });
      expect((await store.invalidate(pending.nonce)).rowCount).toBe(0);
      expect((await invalidatePendingApproval(pending.nonce, deps)).invalidated).toBe(true);

      const granted = await issuePending(store, { runId });
      await store.grant!(granted.nonce, "test:cx");
      expect(await invalidatePendingApproval(granted.nonce, deps)).toEqual({
        invalidated: false,
        rowCount: 0,
      });
      expect((await store.invalidate(granted.nonce)).rowCount).toBe(1);
    });

    it("allows exactly one of N database callers to invalidate the nonce", async () => {
      const store = createDatabaseStore(options);
      const signal = await issuePending(store, { runId });
      const results = await Promise.all(
        Array.from({ length: 16 }, () => invalidatePendingApproval(signal.nonce, deps)),
      );
      expect(results.filter((result) => result.invalidated)).toHaveLength(1);
      expect(results.filter((result) => !result.invalidated)).toHaveLength(15);
    });
  });
}
