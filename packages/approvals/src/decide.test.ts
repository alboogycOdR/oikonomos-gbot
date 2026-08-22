import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import {
  Database,
  seedInboxTriage,
  type Approval,
  type DatabaseOptions,
  type NewApproval,
} from "@oikonomos/db";

import { verifyAndConsume } from "./consume.js";
import {
  decideApproval,
  grantApproval,
  rejectApproval,
  type DecideDependencies,
} from "./decide.js";
import { issueApproval, type IssueApprovalRequest } from "./issue.js";
import {
  GRANT_APPROVAL_SQL,
  REJECT_APPROVAL_SQL,
  createDatabaseStore,
  type ApprovalStore,
  type ConsumeApprovalResult,
} from "./store.js";

if (import.meta.vitest) {
  const { afterAll, beforeAll, describe, expect, it } = import.meta.vitest;

  const FIXTURE_RUN_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const DECIDER = "telegram:user:task-062";

  function fixtureRequest(
    overrides: Partial<IssueApprovalRequest> = {},
  ): IssueApprovalRequest {
    return {
      runId: FIXTURE_RUN_ID,
      capabilityId: "email.create_draft",
      toolName: "mcp__gmail__create_draft",
      input: { to: "review@example.test", subject: "placeholder subject" },
      destination: "review@example.test",
      ...overrides,
    };
  }

  interface MemoryStore {
    readonly store: ApprovalStore;
    readonly rows: Map<string, Approval>;
    readonly events: string[];
  }

  function createMemoryStore(): MemoryStore {
    const rows = new Map<string, Approval>();
    const events: string[] = [];

    function decideRow(
      nonce: string,
      decidedBy: string,
      next: "granted" | "rejected",
    ): ConsumeApprovalResult {
      events.push(next === "granted" ? "grant" : "reject");
      const row = rows.get(nonce);
      if (
        row === undefined ||
        row.status !== "pending" ||
        row.expiresAt.getTime() <= Date.now() ||
        row.consumedAt !== null
      ) {
        return { rowCount: 0, approval: null };
      }
      const decided: Approval = {
        ...row,
        status: next,
        decidedBy,
        decidedAt: new Date(),
        consumedAt: null,
      };
      rows.set(nonce, decided);
      return { rowCount: 1, approval: decided };
    }

    const store: ApprovalStore = {
      async insert(approval: NewApproval): Promise<Approval> {
        events.push("persist");
        if (approval.nonce === undefined) {
          throw new Error("test store requires a caller-supplied nonce");
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
      async getByNonce(nonce: string): Promise<Approval | null> {
        return rows.get(nonce) ?? null;
      },
      async consume(nonce: string): Promise<ConsumeApprovalResult> {
        events.push("consume");
        const row = rows.get(nonce);
        if (
          row === undefined ||
          row.status !== "granted" ||
          row.expiresAt.getTime() <= Date.now() ||
          row.consumedAt !== null
        ) {
          return { rowCount: 0, approval: null };
        }
        const consumed: Approval = {
          ...row,
          status: "consumed",
          consumedAt: new Date(),
        };
        rows.set(nonce, consumed);
        return { rowCount: 1, approval: consumed };
      },
      async invalidate(nonce: string): Promise<ConsumeApprovalResult> {
        events.push("invalidate");
        const row = rows.get(nonce);
        if (row === undefined || row.status !== "granted" || row.consumedAt !== null) {
          return { rowCount: 0, approval: null };
        }
        const invalidated: Approval = { ...row, status: "invalidated" };
        rows.set(nonce, invalidated);
        return { rowCount: 1, approval: invalidated };
      },
      async expirePending(scope?: { readonly runId: string }): Promise<number> {
        events.push("expire");
        const now = Date.now();
        let expired = 0;
        for (const [nonce, row] of rows) {
          if (row.status !== "pending" || row.expiresAt.getTime() > now) {
            continue;
          }
          if (scope !== undefined && row.runId !== scope.runId) {
            continue;
          }
          rows.set(nonce, { ...row, status: "expired" });
          expired += 1;
        }
        return expired;
      },
      async grant(nonce: string, decidedBy: string): Promise<ConsumeApprovalResult> {
        return decideRow(nonce, decidedBy, "granted");
      },
      async reject(nonce: string, decidedBy: string): Promise<ConsumeApprovalResult> {
        return decideRow(nonce, decidedBy, "rejected");
      },
    };

    return { store, rows, events };
  }

  describe("N8 — grant and reject are pinned status-guarded statements", () => {
    it("requires pending + unexpired + unused on both transitions", () => {
      const pendingGuard =
        /WHERE nonce=\$1 AND status='pending' AND expires_at>now\(\) AND consumed_at IS NULL/;
      expect(GRANT_APPROVAL_SQL).toMatch(pendingGuard);
      expect(REJECT_APPROVAL_SQL).toMatch(pendingGuard);
      expect(GRANT_APPROVAL_SQL).toMatch(/status='granted'/);
      expect(REJECT_APPROVAL_SQL).toMatch(/status='rejected'/);
      expect(GRANT_APPROVAL_SQL).toMatch(/decided_by=\$2, decided_at=now\(\)/);
      expect(REJECT_APPROVAL_SQL).toMatch(/decided_by=\$2, decided_at=now\(\)/);
    });

    it("does not consume — neither statement sets consumed_at=now()", () => {
      expect(GRANT_APPROVAL_SQL).not.toMatch(/consumed_at=now\(\)/);
      expect(REJECT_APPROVAL_SQL).not.toMatch(/consumed_at=now\(\)/);
    });

    it("MUTATION-PROVEN: dropping the pending status guard turns this red", () => {
      expect(GRANT_APPROVAL_SQL).toContain("AND status='pending'");
      expect(REJECT_APPROVAL_SQL).toContain("AND status='pending'");
    });

    it("store.ts issues each transition as one UPDATE with no BEGIN/COMMIT/SELECT", () => {
      const storeSrc = readFileSync(new URL("./store.ts", import.meta.url), "utf8");
      expect(storeSrc).toContain("GRANT_APPROVAL_SQL");
      expect(storeSrc).toContain("REJECT_APPROVAL_SQL");
      expect(storeSrc).not.toMatch(/\bBEGIN\b/);
      expect(storeSrc).not.toMatch(/\bCOMMIT\b/);
      expect(storeSrc).not.toMatch(/\bSELECT\b/);
      expect((storeSrc.match(/GRANT_APPROVAL_SQL/g) ?? []).length).toBeGreaterThanOrEqual(2);
      expect((storeSrc.match(/REJECT_APPROVAL_SQL/g) ?? []).length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("grantApproval / rejectApproval — pending transitions", () => {
    it("moves pending → granted with rowCount 1 and leaves consumed_at null", async () => {
      const memory = createMemoryStore();
      const signal = await issueApproval(fixtureRequest(), { store: memory.store });

      const result = await grantApproval(signal.nonce, DECIDER, { store: memory.store });
      expect(result.decided).toBe(true);
      if (!result.decided) {
        throw new Error("expected grant to succeed");
      }
      expect(result.rowCount).toBe(1);
      expect(result.approval.status).toBe("granted");
      expect(result.approval.consumedAt).toBeNull();
      expect(result.approval.decidedBy).toBe(DECIDER);
      expect(result.approval.decidedAt).not.toBeNull();
      expect(memory.rows.get(signal.nonce)!.status).toBe("granted");
      expect(memory.events).toEqual(["persist", "grant"]);
    });

    it("moves pending → rejected with rowCount 1 and leaves consumed_at null", async () => {
      const memory = createMemoryStore();
      const signal = await issueApproval(fixtureRequest(), { store: memory.store });

      const result = await rejectApproval(signal.nonce, DECIDER, { store: memory.store });
      expect(result.decided).toBe(true);
      if (!result.decided) {
        throw new Error("expected reject to succeed");
      }
      expect(result.rowCount).toBe(1);
      expect(result.approval.status).toBe("rejected");
      expect(result.approval.consumedAt).toBeNull();
      expect(memory.events).toEqual(["persist", "reject"]);
    });
  });

  describe("granting does not consume (N8 separation)", () => {
    it("a granted approval still requires verifyAndConsume to be used", async () => {
      const memory = createMemoryStore();
      const request = fixtureRequest();
      const signal = await issueApproval(request, { store: memory.store });

      const granted = await grantApproval(signal.nonce, DECIDER, { store: memory.store });
      expect(granted.decided).toBe(true);
      expect(memory.rows.get(signal.nonce)!.status).toBe("granted");
      expect(memory.rows.get(signal.nonce)!.consumedAt).toBeNull();
      expect(memory.events).toEqual(["persist", "grant"]);

      const stillUnused = await verifyAndConsume(signal.nonce, { store: memory.store }, {
        toolName: request.toolName,
        input: request.input,
        destination: request.destination,
      });
      expect(stillUnused.consumed).toBe(true);
      if (!stillUnused.consumed) {
        throw new Error("expected consume after grant");
      }
      expect(stillUnused.approval.status).toBe("consumed");
      expect(memory.events).toEqual(["persist", "grant", "consume"]);
    });

    it("a still-pending approval cannot be consumed", async () => {
      const memory = createMemoryStore();
      const signal = await issueApproval(fixtureRequest(), { store: memory.store });
      const result = await verifyAndConsume(signal.nonce, { store: memory.store });
      expect(result).toEqual({ consumed: false, rowCount: 0 });
      expect(memory.rows.get(signal.nonce)!.status).toBe("pending");
    });

    it("a rejected approval cannot be consumed", async () => {
      const memory = createMemoryStore();
      const signal = await issueApproval(fixtureRequest(), { store: memory.store });
      await rejectApproval(signal.nonce, DECIDER, { store: memory.store });
      const result = await verifyAndConsume(signal.nonce, { store: memory.store });
      expect(result).toEqual({ consumed: false, rowCount: 0 });
      expect(memory.rows.get(signal.nonce)!.status).toBe("rejected");
      expect(memory.rows.get(signal.nonce)!.consumedAt).toBeNull();
    });
  });

  describe("repeat / concurrent decide — exactly one success", () => {
    it("a second grant on the same nonce affects zero rows", async () => {
      const memory = createMemoryStore();
      const signal = await issueApproval(fixtureRequest(), { store: memory.store });
      const first = await grantApproval(signal.nonce, DECIDER, { store: memory.store });
      const second = await grantApproval(signal.nonce, "telegram:other", { store: memory.store });
      expect(first.decided).toBe(true);
      expect(second).toEqual({ decided: false, rowCount: 0 });
      expect(memory.rows.get(signal.nonce)!.decidedBy).toBe(DECIDER);
    });

    it("reject then grant affects zero rows", async () => {
      const memory = createMemoryStore();
      const signal = await issueApproval(fixtureRequest(), { store: memory.store });
      expect((await rejectApproval(signal.nonce, DECIDER, { store: memory.store })).decided).toBe(
        true,
      );
      expect(await grantApproval(signal.nonce, DECIDER, { store: memory.store })).toEqual({
        decided: false,
        rowCount: 0,
      });
      expect(memory.rows.get(signal.nonce)!.status).toBe("rejected");
    });

    it("grant then reject affects zero rows", async () => {
      const memory = createMemoryStore();
      const signal = await issueApproval(fixtureRequest(), { store: memory.store });
      expect((await grantApproval(signal.nonce, DECIDER, { store: memory.store })).decided).toBe(
        true,
      );
      expect(await rejectApproval(signal.nonce, DECIDER, { store: memory.store })).toEqual({
        decided: false,
        rowCount: 0,
      });
      expect(memory.rows.get(signal.nonce)!.status).toBe("granted");
    });

    it("exactly one of N parallel grantApproval calls succeeds", async () => {
      const memory = createMemoryStore();
      const signal = await issueApproval(fixtureRequest(), { store: memory.store });
      const racers = 16;
      const results = await Promise.all(
        Array.from({ length: racers }, (_, i) =>
          grantApproval(signal.nonce, `${DECIDER}:${String(i)}`, { store: memory.store }),
        ),
      );
      expect(results.filter((result) => result.decided)).toHaveLength(1);
      expect(results.filter((result) => !result.decided)).toHaveLength(racers - 1);
      expect(memory.rows.get(signal.nonce)!.status).toBe("granted");
    });
  });

  describe("expired and invalidated rows cannot be granted (OIK-023)", () => {
    it("refuses a row already in status expired", async () => {
      const memory = createMemoryStore();
      const signal = await issueApproval(
        fixtureRequest({ expiresAt: new Date(Date.now() - 1_000) }),
        { store: memory.store },
      );
      const expired = await memory.store.expirePending();
      expect(expired).toBe(1);
      expect(memory.rows.get(signal.nonce)!.status).toBe("expired");

      const result = await grantApproval(signal.nonce, DECIDER, { store: memory.store });
      expect(result).toEqual({ decided: false, rowCount: 0 });
      expect(memory.rows.get(signal.nonce)!.status).toBe("expired");
    });

    it("refuses a still-pending row whose expires_at has elapsed", async () => {
      const memory = createMemoryStore();
      const signal = await issueApproval(
        fixtureRequest({ expiresAt: new Date(Date.now() - 1_000) }),
        { store: memory.store },
      );
      expect(memory.rows.get(signal.nonce)!.status).toBe("pending");

      const result = await grantApproval(signal.nonce, DECIDER, { store: memory.store });
      expect(result).toEqual({ decided: false, rowCount: 0 });
      expect(memory.rows.get(signal.nonce)!.status).toBe("pending");
      expect(memory.rows.get(signal.nonce)!.consumedAt).toBeNull();
    });

    it("refuses an invalidated row", async () => {
      const memory = createMemoryStore();
      const signal = await issueApproval(fixtureRequest(), { store: memory.store });
      const granted = await grantApproval(signal.nonce, DECIDER, { store: memory.store });
      expect(granted.decided).toBe(true);
      const invalidated = await memory.store.invalidate!(signal.nonce);
      expect(invalidated.rowCount).toBe(1);
      expect(memory.rows.get(signal.nonce)!.status).toBe("invalidated");

      const retry = await grantApproval(signal.nonce, DECIDER, { store: memory.store });
      expect(retry).toEqual({ decided: false, rowCount: 0 });
      expect(memory.rows.get(signal.nonce)!.status).toBe("invalidated");
    });
  });

  describe("decideApproval — fail closed on invalid input", () => {
    it("rejects a non-UUID nonce before calling grant", async () => {
      let grantCalls = 0;
      const store: ApprovalStore = {
        insert: async () => {
          throw new Error("insert must not run");
        },
        getByNonce: async () => null,
        consume: async () => ({ rowCount: 0, approval: null }),
        invalidate: async () => ({ rowCount: 0, approval: null }),
        expirePending: async () => 0,
        grant: async () => {
          grantCalls += 1;
          return { rowCount: 0, approval: null };
        },
      };
      await expect(grantApproval("not-a-uuid", DECIDER, { store })).rejects.toThrow(/nonce/);
      await expect(grantApproval("   ", DECIDER, { store })).rejects.toThrow(/nonce/);
      expect(grantCalls).toBe(0);
    });

    it("rejects an empty decidedBy before calling grant", async () => {
      let grantCalls = 0;
      const store: ApprovalStore = {
        insert: async () => {
          throw new Error("insert must not run");
        },
        getByNonce: async () => null,
        consume: async () => ({ rowCount: 0, approval: null }),
        invalidate: async () => ({ rowCount: 0, approval: null }),
        expirePending: async () => 0,
        grant: async () => {
          grantCalls += 1;
          return { rowCount: 0, approval: null };
        },
      };
      await expect(grantApproval(randomUUID(), "  ", { store })).rejects.toThrow(/decidedBy/);
      expect(grantCalls).toBe(0);
    });

    it("rejects a store that lacks grant/reject rather than no-opping", async () => {
      const store: ApprovalStore = {
        insert: async () => {
          throw new Error("insert must not run");
        },
        getByNonce: async () => null,
        consume: async () => ({ rowCount: 0, approval: null }),
        invalidate: async () => ({ rowCount: 0, approval: null }),
        expirePending: async () => 0,
      };
      await expect(grantApproval(randomUUID(), DECIDER, { store })).rejects.toThrow(/grant/);
      await expect(rejectApproval(randomUUID(), DECIDER, { store })).rejects.toThrow(/reject/);
    });

    it("fails closed if a store claims rowCount 1 without the decided row", async () => {
      const store: ApprovalStore = {
        insert: async () => {
          throw new Error("insert must not run");
        },
        getByNonce: async () => null,
        consume: async () => ({ rowCount: 0, approval: null }),
        invalidate: async () => ({ rowCount: 0, approval: null }),
        expirePending: async () => 0,
        grant: async () => ({ rowCount: 1, approval: null }),
      };
      await expect(grantApproval(randomUUID(), DECIDER, { store })).rejects.toThrow(/rowCount/);
    });
  });

  const connectionString = process.env.DATABASE_URL;
  const integration = connectionString === undefined ? describe.skip : describe;

  integration("grant/reject against compose Postgres", () => {
    const options: DatabaseOptions = { connectionString: connectionString! };
    const requireFromDb = createRequire(
      fileURLToPath(new URL("../../db/package.json", import.meta.url)),
    );
    const { Pool } = requireFromDb("pg") as {
      Pool: new (config: { connectionString: string; max?: number }) => {
        query<T extends object = Record<string, unknown>>(
          text: string,
          values?: readonly unknown[],
        ): Promise<{ rows: T[]; rowCount: number | null }>;
        connect(): Promise<{
          query<T extends object = Record<string, unknown>>(
            text: string,
            values?: readonly unknown[],
          ): Promise<{ rows: T[]; rowCount: number | null }>;
          release(): void;
        }>;
        end(): Promise<void>;
      };
    };

    let database: Database;
    let pool: InstanceType<typeof Pool>;
    let runId: string;
    const deps: DecideDependencies = { database: options };

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
          "TASK-062 approval decide fixture",
          "atomic grant and reject of a pending nonce",
          "test:task-062",
        ],
      );
      const taskId = task.rows[0]?.task_id;
      if (taskId === undefined) {
        throw new Error("failed to insert TASK-062 fixture task");
      }
      const run = await pool.query<{ run_id: string }>(
        `INSERT INTO runs (task_id, provider)
         VALUES ($1, $2)
         RETURNING run_id`,
        [taskId, "test"],
      );
      const insertedRunId = run.rows[0]?.run_id;
      if (insertedRunId === undefined) {
        throw new Error("failed to insert TASK-062 fixture run");
      }
      runId = insertedRunId;
    });

    afterAll(async () => {
      await database.close();
      await pool.end();
    });

    it("pending → granted is one row and verifyAndConsume is still required", async () => {
      const store = createDatabaseStore(options);
      const signal = await issueApproval(fixtureRequest({ runId }), { store });
      const granted = await grantApproval(signal.nonce, DECIDER, deps);
      expect(granted.decided).toBe(true);
      if (!granted.decided) {
        throw new Error("expected grant to succeed");
      }
      expect(granted.approval.status).toBe("granted");
      expect(granted.approval.consumedAt).toBeNull();

      const consumed = await verifyAndConsume(signal.nonce, { store });
      expect(consumed.consumed).toBe(true);
    });

    it("pending → rejected is one row and cannot later be granted or consumed", async () => {
      const store = createDatabaseStore(options);
      const signal = await issueApproval(fixtureRequest({ runId }), { store });
      const rejected = await rejectApproval(signal.nonce, DECIDER, deps);
      expect(rejected.decided).toBe(true);
      expect(await grantApproval(signal.nonce, DECIDER, deps)).toEqual({
        decided: false,
        rowCount: 0,
      });
      expect(await verifyAndConsume(signal.nonce, { store })).toEqual({
        consumed: false,
        rowCount: 0,
      });
    });

    it("exactly one of N parallel grantApproval calls succeeds", async () => {
      const store = createDatabaseStore(options);
      const signal = await issueApproval(fixtureRequest({ runId }), { store });
      const racers = 16;
      const results = await Promise.all(
        Array.from({ length: racers }, () => grantApproval(signal.nonce, DECIDER, deps)),
      );
      expect(results.filter((result) => result.decided)).toHaveLength(1);
      expect(results.filter((result) => !result.decided)).toHaveLength(racers - 1);
    });

    it("exactly one success when pre-connected clients race the pinned grant statement", async () => {
      const store = createDatabaseStore(options);
      const signal = await issueApproval(fixtureRequest({ runId }), { store });
      const racers = Array.from(
        { length: 16 },
        () => new Pool({ connectionString: connectionString!, max: 1 }),
      );
      const clients = await Promise.all(racers.map((racer) => racer.connect()));
      try {
        const raced = await Promise.all(
          clients.map((client) =>
            client.query(
              `${GRANT_APPROVAL_SQL} RETURNING approval_id`,
              [signal.nonce, DECIDER],
            ),
          ),
        );
        expect(raced.filter((result) => result.rowCount === 1)).toHaveLength(1);
        expect(raced.filter((result) => result.rowCount === 0)).toHaveLength(15);
      } finally {
        for (const client of clients) {
          client.release();
        }
        await Promise.all(racers.map((racer) => racer.end()));
      }
    });

    it("expired and invalidated rows cannot be granted", async () => {
      const store = createDatabaseStore(options);
      const expiredSignal = await issueApproval(
        fixtureRequest({ runId, expiresAt: new Date(Date.now() - 1_000) }),
        { store },
      );
      expect(await store.expirePending({ runId })).toBeGreaterThanOrEqual(1);
      expect(await grantApproval(expiredSignal.nonce, DECIDER, deps)).toEqual({
        decided: false,
        rowCount: 0,
      });

      const unswept = await issueApproval(
        fixtureRequest({ runId, expiresAt: new Date(Date.now() - 1_000) }),
        { store },
      );
      expect(await grantApproval(unswept.nonce, DECIDER, deps)).toEqual({
        decided: false,
        rowCount: 0,
      });

      const live = await issueApproval(fixtureRequest({ runId }), { store });
      expect((await grantApproval(live.nonce, DECIDER, deps)).decided).toBe(true);
      expect((await store.invalidate(live.nonce)).rowCount).toBe(1);
      expect(await grantApproval(live.nonce, DECIDER, deps)).toEqual({
        decided: false,
        rowCount: 0,
      });
    });
  });
}
