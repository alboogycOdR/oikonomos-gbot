import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getRun, type DatabaseOptions } from "@oikonomos/db";

import { purgePgBossQueue, withPgBossQueueLock } from "./jobs/pgBossTestCleanup.js";
import { WORKER_HEARTBEAT_JOB, WORKER_ROUTINE_POLL_JOB } from "./jobs/workerJobQueue.js";
import { startTaskRun } from "./runLifecycle.js";
import { runWorker } from "./main.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

integration("runWorker — the real worker process entrypoint (TASK-226 / OIK-106)", () => {
  const options: DatabaseOptions = { connectionString: connectionString! };
  let pool: Pool;
  let taskId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString! });
    const task = await pool.query<{ task_id: string }>(
      `INSERT INTO tasks (role_id, title, goal, requested_by)
       VALUES ($1, $2, $3, $4)
       RETURNING task_id`,
      ["inbox-triage", "TASK-226 worker-boot fixture", "exercise runWorker's real call site", "test:task-226-worker"],
    );
    const insertedTaskId = task.rows[0]?.task_id;
    if (insertedTaskId === undefined) {
      throw new Error("failed to insert TASK-226 worker fixture task");
    }
    taskId = insertedTaskId;
  });

  afterAll(async () => {
    await pool.end();
  });

  it(
    "boots and resumes a run orphaned by a prior process's death — not just that reconcileInterruptedRuns " +
      "works in isolation (already covered by runLifecycle.test.ts), but that the REAL entrypoint invokes it",
    async () => {
      // Constructed directly rather than actually killing a process, matching
      // TASK-133's own established convention (runLifecycle.test.ts) — a
      // `started` run with no live process behind it is indistinguishable,
      // from the database's point of view, from one truly orphaned.
      const orphan = await startTaskRun(options, {
        taskId,
        provider: "claude-code",
        sessionRef: "task-226-boot-session-1",
      });
      expect(orphan.status).toBe("started");

      await withPgBossQueueLock(pool, async () => {
        await purgePgBossQueue(pool, WORKER_HEARTBEAT_JOB);
        await purgePgBossQueue(pool, WORKER_ROUTINE_POLL_JOB);
        const logs: string[] = [];
        const worker = await runWorker({
          connectionString: connectionString!,
          // No routine ever exists for this tenant, so routine polling starts
          // cleanly with nothing to do — this test is about the reconciliation
          // sweep, not routine-poll behaviour (already covered elsewhere).
          tenantId: "task-226-boot-tenant-with-no-routines",
          reconcileFilter: { taskId },
          onLog: (message) => logs.push(message),
        });
        try {
          const persisted = await getRun(options, orphan.runId);
          expect(persisted?.status).toBe("resumed");
          expect(persisted?.sessionRef).toBe("task-226-boot-session-1");
          expect(logs.some((line) => line.includes("reconciled 1 interrupted run"))).toBe(true);
          expect(logs.some((line) => line.includes("worker started"))).toBe(true);
        } finally {
          await worker.stop();
        }
      });
    },
    20_000,
  );

  it("boots cleanly with nothing to reconcile (no orphaned runs is not an error)", async () => {
    await withPgBossQueueLock(pool, async () => {
      await purgePgBossQueue(pool, WORKER_HEARTBEAT_JOB);
      await purgePgBossQueue(pool, WORKER_ROUTINE_POLL_JOB);
      const logs: string[] = [];
      const worker = await runWorker({
        connectionString: connectionString!,
        tenantId: "task-226-boot-tenant-with-no-routines",
        reconcileFilter: { taskId: "00000000-0000-0000-0000-000000000000" },
        onLog: (message) => logs.push(message),
      });
      try {
        expect(logs.some((line) => line.startsWith("reconciled"))).toBe(false);
        expect(logs.some((line) => line.includes("worker started"))).toBe(true);
      } finally {
        await worker.stop();
      }
    });
  }, 20_000);
});
