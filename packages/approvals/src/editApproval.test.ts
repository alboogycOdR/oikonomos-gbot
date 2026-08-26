import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  Database,
  seedInboxTriage,
  type Approval,
  type DatabaseOptions,
} from "@oikonomos/db";

import { bindActionDigest } from "./bind.js";
import { verifyAndConsume } from "./consume.js";
import { grantApproval, rejectApproval } from "./decide.js";
import {
  editApproval,
  type EditApprovalDependencies,
} from "./editApproval.js";
import { invalidatePendingApproval } from "./invalidatePending.js";
import { issueApproval, type IssueApprovalRequest } from "./issue.js";
import { actionRender } from "./render.js";
import {
  INSERT_APPROVAL_SQL,
  INVALIDATE_APPROVAL_SQL,
  INVALIDATE_PENDING_APPROVAL_SQL,
  createDatabaseStore,
} from "./store.js";

if (import.meta.vitest) {
  const { afterAll, beforeAll, describe, expect, it } = import.meta.vitest;

  const DECIDER = "telegram:user:task-080";
  const INJECTED_FAULT = "injected fault between invalidate and insert";

  const ORIGINAL_PAYLOAD = {
    toolName: "mcp__gmail__create_draft",
    input: { to: "review@example.test", subject: "original subject" },
    destination: "review@example.test",
  };

  const EDITED_PAYLOAD = {
    toolName: "mcp__gmail__create_draft",
    input: { to: "review@example.test", subject: "edited subject" },
    destination: "review@example.test",
  };

  describe("editApproval — source pins (no DB)", () => {
    const editSrc = readFileSync(new URL("./editApproval.ts", import.meta.url), "utf8");
    const storeSrc = readFileSync(new URL("./store.ts", import.meta.url), "utf8");
    const dbSrc = readFileSync(
      new URL("../../db/src/approvals.ts", import.meta.url),
      "utf8",
    );

    it("keeps INVALIDATE_APPROVAL_SQL and TASK-064 pending SQL disjoint and pinned in store.ts", () => {
      expect(storeSrc).toContain("INVALIDATE_APPROVAL_SQL");
      expect(storeSrc).toContain("INVALIDATE_PENDING_APPROVAL_SQL");
      expect(INVALIDATE_APPROVAL_SQL).toContain("status='granted'");
      expect(INVALIDATE_APPROVAL_SQL).not.toContain("status='pending'");
      expect(INVALIDATE_PENDING_APPROVAL_SQL).toContain("status='pending'");
      expect(INVALIDATE_PENDING_APPROVAL_SQL).toContain("expires_at>now()");
      expect(INVALIDATE_PENDING_APPROVAL_SQL).toContain("consumed_at IS NULL");
    });

    it("reuses the pinned pending SQL constant rather than copying its WHERE clause", () => {
      expect(editSrc).toContain("INVALIDATE_PENDING_APPROVAL_SQL");
      expect(editSrc).not.toContain("status='pending' AND expires_at>now() AND consumed_at IS NULL");
    });

    it("runs invalidate then insert between BEGIN and COMMIT on one client", () => {
      const begin = editSrc.indexOf('await client.query("BEGIN")');
      const invalidate = editSrc.indexOf("INVALIDATE_PENDING_APPROVAL_SQL", begin);
      const insert = editSrc.indexOf("INSERT_APPROVAL_SQL", begin);
      const commit = editSrc.indexOf('await client.query("COMMIT")', begin);
      expect(begin).toBeGreaterThan(-1);
      expect(invalidate).toBeGreaterThan(begin);
      expect(insert).toBeGreaterThan(invalidate);
      expect(commit).toBeGreaterThan(insert);
      expect(editSrc).toContain("withApprovalClient");
      expect(editSrc).toContain("ROLLBACK");
    });

    it("does not put BEGIN/COMMIT/SELECT into store.ts (existing decide pin)", () => {
      expect(storeSrc).not.toMatch(/\bBEGIN\b/);
      expect(storeSrc).not.toMatch(/\bCOMMIT\b/);
      expect(storeSrc).not.toMatch(/\bSELECT\b/);
      expect(storeSrc).toContain("withApprovalClient");
      expect(storeSrc).toContain("connect()");
    });

    it("replacement INSERT matches packages/db insertApproval (no extra WHERE)", () => {
      const compact = (sql: string) => sql.replace(/\s+/g, " ").trim();
      expect(compact(dbSrc)).toContain(compact(INSERT_APPROVAL_SQL));
      expect(INSERT_APPROVAL_SQL).not.toMatch(/\bWHERE\b/);
    });

    it("fails closed on an invalid nonce before opening a client", async () => {
      await expect(
        editApproval("not-a-uuid", fixtureRequest("00000000-0000-4000-8000-000000000000"), {
          database: { connectionString: "postgres://invalid" },
        }),
      ).rejects.toThrow(/nonce/);
    });

    it("fails closed on empty edited fields before opening a client", async () => {
      const nonce = "11111111-1111-4111-8111-111111111111";
      const deps: EditApprovalDependencies = {
        database: { connectionString: "postgres://invalid" },
      };
      await expect(
        editApproval(nonce, fixtureRequest("00000000-0000-4000-8000-000000000000", { toolName: "  " }), deps),
      ).rejects.toThrow(/toolName/);
      await expect(
        editApproval(
          nonce,
          fixtureRequest("00000000-0000-4000-8000-000000000000", { destination: "" }),
          deps,
        ),
      ).rejects.toThrow(/destination/);
    });
  });

  function fixtureRequest(
    runId: string,
    overrides: Partial<IssueApprovalRequest> = {},
  ): IssueApprovalRequest {
    return {
      runId,
      capabilityId: "email.create_draft",
      ...ORIGINAL_PAYLOAD,
      ...overrides,
    };
  }

  const connectionString = process.env.DATABASE_URL;
  const integration = connectionString === undefined ? describe.skip : describe;

  integration("editApproval against compose Postgres", () => {
    const options: DatabaseOptions = { connectionString: connectionString! };
    const deps: EditApprovalDependencies = { database: options };
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
    let taskId: string;

    async function insertRun(): Promise<string> {
      const run = await pool.query<{ run_id: string }>(
        "INSERT INTO runs (task_id, provider) VALUES ($1, $2) RETURNING run_id",
        [taskId, "test"],
      );
      const runId = run.rows[0]?.run_id;
      if (runId === undefined) {
        throw new Error("failed to create TASK-080 fixture run");
      }
      return runId;
    }

    async function loadByNonce(nonce: string): Promise<Approval | null> {
      return createDatabaseStore(options).getByNonce(nonce);
    }

    async function pendingCount(runId: string): Promise<number> {
      const result = await pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM approvals WHERE run_id = $1 AND status = 'pending'",
        [runId],
      );
      return Number(result.rows[0]?.n ?? "0");
    }

    beforeAll(async () => {
      database = new Database(options);
      pool = new Pool({ connectionString: connectionString! });
      await seedInboxTriage(database);
      const task = await pool.query<{ task_id: string }>(
        `INSERT INTO tasks (role_id, title, goal, requested_by)
         VALUES ($1, $2, $3, $4) RETURNING task_id`,
        ["inbox-triage", "TASK-080 fixture", "atomic editApproval", "test:task-080"],
      );
      const insertedTaskId = task.rows[0]?.task_id;
      if (insertedTaskId === undefined) {
        throw new Error("failed to create TASK-080 fixture task");
      }
      taskId = insertedTaskId;
    });

    afterAll(async () => {
      await database.close();
      await pool.end();
    });

    it("invalidates the original and issues one pending replacement bound to the edited payload", async () => {
      const store = createDatabaseStore(options);
      const runId = await insertRun();
      const original = await issueApproval(fixtureRequest(runId), { store });
      const originalRow = await loadByNonce(original.nonce);
      expect(originalRow).not.toBeNull();

      const result = await editApproval(
        original.nonce,
        fixtureRequest(runId, EDITED_PAYLOAD),
        deps,
      );
      expect(result.edited).toBe(true);
      if (!result.edited) {
        throw new Error("expected edit to succeed");
      }
      expect(result.replacement.nonce).not.toBe(original.nonce);
      expect(result.invalidated.status).toBe("invalidated");
      expect(result.invalidated.consumedAt).toBeNull();
      expect(result.invalidated.nonce).toBe(original.nonce);

      const oldRow = await loadByNonce(original.nonce);
      const newRow = await loadByNonce(result.replacement.nonce);
      expect(oldRow).toMatchObject({ status: "invalidated", consumedAt: null });
      expect(newRow).toMatchObject({
        status: "pending",
        consumedAt: null,
        destination: EDITED_PAYLOAD.destination,
      });
      expect(await pendingCount(runId)).toBe(1);

      const expectedDigest = bindActionDigest(EDITED_PAYLOAD);
      const expectedRender = actionRender(EDITED_PAYLOAD);
      expect(result.replacement.actionDigest).toBe(expectedDigest);
      expect(result.replacement.actionRender).toBe(expectedRender);
      expect(newRow!.actionRender).toBe(expectedRender);
      expect(newRow!.actionDigest.equals(Buffer.from(expectedDigest, "hex"))).toBe(true);
      expect(newRow!.actionRender).not.toBe(originalRow!.actionRender);
      expect(newRow!.actionDigest.equals(originalRow!.actionDigest)).toBe(false);
      expect(expectedRender).toContain("edited subject");
      expect(expectedRender).toContain(EDITED_PAYLOAD.destination);
    });

    it("refuses the old nonce via decide AND consume; replacement is the only pending row", async () => {
      const store = createDatabaseStore(options);
      const runId = await insertRun();
      const original = await issueApproval(fixtureRequest(runId), { store });
      const edited = await editApproval(
        original.nonce,
        fixtureRequest(runId, EDITED_PAYLOAD),
        deps,
      );
      expect(edited.edited).toBe(true);
      if (!edited.edited) {
        throw new Error("expected edit to succeed");
      }

      expect(await grantApproval(original.nonce, DECIDER, { database: options })).toEqual({
        decided: false,
        rowCount: 0,
      });
      expect(await rejectApproval(original.nonce, DECIDER, { database: options })).toEqual({
        decided: false,
        rowCount: 0,
      });
      expect(
        await verifyAndConsume(original.nonce, { database: options }, EDITED_PAYLOAD),
      ).toEqual({ consumed: false, rowCount: 0 });
      expect(
        await verifyAndConsume(original.nonce, { database: options }, ORIGINAL_PAYLOAD),
      ).toEqual({ consumed: false, rowCount: 0 });

      expect(await pendingCount(runId)).toBe(1);
      const live = await loadByNonce(edited.replacement.nonce);
      expect(live?.status).toBe("pending");
    });

    it("forced failure between invalidate and insert rolls back — original stays pending, no replacement", async () => {
      const store = createDatabaseStore(options);
      const runId = await insertRun();
      const original = await issueApproval(fixtureRequest(runId), { store });
      const before = await pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM approvals WHERE run_id = $1",
        [runId],
      );

      await expect(
        editApproval(original.nonce, fixtureRequest(runId, EDITED_PAYLOAD), deps, {
          afterInvalidate: async () => {
            throw new Error(INJECTED_FAULT);
          },
        }),
      ).rejects.toThrow(INJECTED_FAULT);

      const after = await loadByNonce(original.nonce);
      expect(after).toMatchObject({
        status: "pending",
        nonce: original.nonce,
        consumedAt: null,
      });
      expect(after!.actionDigest.equals((await store.getByNonce(original.nonce))!.actionDigest)).toBe(
        true,
      );
      const counts = await pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM approvals WHERE run_id = $1",
        [runId],
      );
      expect(counts.rows[0]?.n).toBe(before.rows[0]?.n);
      expect(await pendingCount(runId)).toBe(1);
    });

    it("MUTATION-PROVEN: two independent pools leave the original invalidated after the same fault", async () => {
      const store = createDatabaseStore(options);
      const runId = await insertRun();
      const original = await issueApproval(fixtureRequest(runId), { store });

      await expect(
        (async () => {
          // Pool 1 commits independently (invalidatePending → withPool → end).
          const voided = await invalidatePendingApproval(original.nonce, { database: options });
          expect(voided.invalidated).toBe(true);
          // Pool 2 (insert) never runs — the injected fault is the missing second write.
          throw new Error(INJECTED_FAULT);
        })(),
      ).rejects.toThrow(INJECTED_FAULT);

      const after = await loadByNonce(original.nonce);
      expect(after?.status).toBe("invalidated");
      expect(await pendingCount(runId)).toBe(0);
    });

    it("releases the client after a fault so a later edit still succeeds", async () => {
      const store = createDatabaseStore(options);
      const runId = await insertRun();
      const original = await issueApproval(fixtureRequest(runId), { store });
      for (let i = 0; i < 8; i += 1) {
        await expect(
          editApproval(original.nonce, fixtureRequest(runId, EDITED_PAYLOAD), deps, {
            afterInvalidate: async () => {
              throw new Error(INJECTED_FAULT);
            },
          }),
        ).rejects.toThrow(INJECTED_FAULT);
      }
      const result = await editApproval(
        original.nonce,
        fixtureRequest(runId, EDITED_PAYLOAD),
        deps,
      );
      expect(result.edited).toBe(true);
      expect((await loadByNonce(original.nonce))?.status).toBe("invalidated");
    });

    it("refuses granted, rejected, invalidated, expired, and consumed inputs with zero writes", async () => {
      const store = createDatabaseStore(options);
      const runId = await insertRun();
      const granted = await issueApproval(fixtureRequest(runId), { store });
      const rejected = await issueApproval(fixtureRequest(runId), { store });
      const invalidated = await issueApproval(fixtureRequest(runId), { store });
      const expired = await issueApproval(
        fixtureRequest(runId, { expiresAt: new Date(Date.now() - 1_000) }),
        { store },
      );
      const consumed = await issueApproval(fixtureRequest(runId), { store });

      expect((await grantApproval(granted.nonce, DECIDER, { database: options })).decided).toBe(
        true,
      );
      expect((await rejectApproval(rejected.nonce, DECIDER, { database: options })).decided).toBe(
        true,
      );
      expect(
        (await invalidatePendingApproval(invalidated.nonce, { database: options })).invalidated,
      ).toBe(true);
      expect((await store.expirePending({ runId }))).toBe(1);
      expect((await grantApproval(consumed.nonce, DECIDER, { database: options })).decided).toBe(
        true,
      );
      expect(
        (await verifyAndConsume(consumed.nonce, { database: options }, ORIGINAL_PAYLOAD)).consumed,
      ).toBe(true);

      const snapshots = await Promise.all(
        [granted, rejected, invalidated, expired, consumed].map(async (signal) => {
          const row = await loadByNonce(signal.nonce);
          if (row === null) {
            throw new Error(`missing fixture row for ${signal.nonce}`);
          }
          return row;
        }),
      );
      const beforeCount = await pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM approvals WHERE run_id = $1",
        [runId],
      );

      for (const [index, signal] of [granted, rejected, invalidated, expired, consumed].entries()) {
        const result = await editApproval(
          signal.nonce,
          fixtureRequest(runId, EDITED_PAYLOAD),
          deps,
        );
        expect(result).toEqual({ edited: false, rowCount: 0 });
        const after = await loadByNonce(signal.nonce);
        expect(after).toEqual(snapshots[index]);
      }

      const afterCount = await pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM approvals WHERE run_id = $1",
        [runId],
      );
      expect(afterCount.rows[0]?.n).toBe(beforeCount.rows[0]?.n);
    });

    it("exactly one of concurrent edits succeeds", async () => {
      const store = createDatabaseStore(options);
      const runId = await insertRun();
      const original = await issueApproval(fixtureRequest(runId), { store });
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          editApproval(original.nonce, fixtureRequest(runId, EDITED_PAYLOAD), deps),
        ),
      );
      expect(results.filter((result) => result.edited)).toHaveLength(1);
      expect(results.filter((result) => !result.edited)).toHaveLength(7);
      expect(await pendingCount(runId)).toBe(1);
      expect((await loadByNonce(original.nonce))?.status).toBe("invalidated");
    });
  });
}
