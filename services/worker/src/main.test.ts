import { Pool } from "pg";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createSecretRequest, createTaskExecutionRun, getAuditEventsForRun, getRun, listMessages, listRuns, type DatabaseOptions } from "@oikonomos/db";

import { purgePgBossQueue, withPgBossQueueLock } from "./jobs/pgBossTestCleanup.js";
import { WORKER_HEARTBEAT_JOB, WORKER_ROUTINE_POLL_JOB, WORKER_RUN_EXECUTION_JOB } from "./jobs/workerJobQueue.js";
import { parkTaskRun } from "./runLifecycle.js";
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
    "re-drives an interrupted safe run through real pg-boss and records its liveness audit",
    async () => {
      // A persisted started row with no worker is indistinguishable from a
      // run interrupted by a process kill. The injected SDK stream is a safe
      // local executor: no provider call or governed side effect occurs.
      const persisted = await createTaskExecutionRun(options, {
        task: {
          roleId: "inbox-triage",
          title: "TASK-246 restart-safe execution",
          goal: "Return the safe test result.",
          requestedBy: "test:task-246-worker-restart",
        },
        execution: { version: 1, kind: "chat", threadId: "00000000-0000-0000-0000-000000000001" },
        provider: "claude",
      });
      const orphan = await getRun(options, persisted.runId);
      expect(orphan?.status).toBe("started");

      await withPgBossQueueLock(pool, async () => {
        await purgePgBossQueue(pool, WORKER_HEARTBEAT_JOB);
        await purgePgBossQueue(pool, WORKER_ROUTINE_POLL_JOB);
        await purgePgBossQueue(pool, WORKER_RUN_EXECUTION_JOB);
        const logs: string[] = [];
        const worker = await runWorker({
          connectionString: connectionString!,
          // No routine ever exists for this tenant, so routine polling starts
          // cleanly with nothing to do — this test is about the reconciliation
          // sweep, not routine-poll behaviour (already covered elsewhere).
          tenantId: "task-226-boot-tenant-with-no-routines",
          reconcileFilter: { taskId: persisted.task.taskId },
          onLog: (message) => logs.push(message),
          chatRunDriverOptions: {
            manifests: [],
            platformCeilingZar: 1_000_000,
            queryFn: async function* () {
              yield { type: "result", subtype: "success", result: "restart-safe result" };
            },
          },
        });
        try {
          let replacementStatus: string | undefined;
          for (let attempt = 0; attempt < 120; attempt += 1) {
            const runs = await listRuns(options, { taskId: persisted.task.taskId, limit: 10 });
            replacementStatus = runs.runs.find((run) => run.runId !== persisted.runId)?.status;
            if (replacementStatus === "completed") break;
            await delay(100);
          }
          const oldRun = await getRun(options, persisted.runId);
          expect(oldRun).toMatchObject({ status: "failed", failureNote: "worker_restart" });
          expect(replacementStatus).toBe("completed");
          const audit = await getAuditEventsForRun(options, (await listRuns(options, { taskId: persisted.task.taskId, limit: 10 })).runs.find((run) => run.runId !== persisted.runId)!.runId);
          expect(audit.some((event) => event.eventType === "run.requeued" && event.payload.mode === "new_run" && event.payload.previous_run_id === persisted.runId)).toBe(true);
          expect(logs.some((line) => line.includes("reconciled 1 interrupted run"))).toBe(true);
          expect(logs.some((line) => line.includes("worker started"))).toBe(true);
        } finally {
          await worker.stop();
        }
      });
    },
    30_000,
  );

  it("boots cleanly with nothing to reconcile (no orphaned runs is not an error)", async () => {
    await withPgBossQueueLock(pool, async () => {
      await purgePgBossQueue(pool, WORKER_HEARTBEAT_JOB);
      await purgePgBossQueue(pool, WORKER_ROUTINE_POLL_JOB);
      await purgePgBossQueue(pool, WORKER_RUN_EXECUTION_JOB);
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

  it("leaves an approval-parked durable command untouched at worker boot", async () => {
    const persisted = await createTaskExecutionRun(options, {
      task: {
        roleId: "inbox-triage",
        title: "TASK-246 parked command",
        goal: "This must not execute before a normal approval decision.",
        requestedBy: "test:task-246-parked-restart",
      },
      execution: { version: 1, kind: "chat", threadId: "00000000-0000-0000-0000-000000000002" },
      provider: "claude",
    });
    await parkTaskRun(options, persisted.runId);
    let executorCalls = 0;
    await withPgBossQueueLock(pool, async () => {
      await purgePgBossQueue(pool, WORKER_HEARTBEAT_JOB);
      await purgePgBossQueue(pool, WORKER_ROUTINE_POLL_JOB);
      await purgePgBossQueue(pool, WORKER_RUN_EXECUTION_JOB);
      const worker = await runWorker({
        connectionString: connectionString!,
        tenantId: "task-246-parked-tenant-with-no-routines",
        reconcileFilter: { taskId: persisted.task.taskId },
        chatRunDriverOptions: {
          manifests: [],
          platformCeilingZar: 1_000_000,
          queryFn: async function* () {
            executorCalls += 1;
            yield { type: "result", subtype: "success", result: "must not run" };
          },
        },
      });
      try {
        await delay(500);
        expect((await getRun(options, persisted.runId))?.status).toBe("waiting_approval");
        expect(executorCalls).toBe(0);
      } finally {
        await worker.stop();
      }
    });
  }, 20_000);

  it("expires an unanswered secret request through the real worker sweep, fails its run, and emits its liveness audit", async () => {
    const persisted = await createTaskExecutionRun(options, {
      task: { roleId: "inbox-triage", title: "TASK-323 expiry", goal: "must stop", requestedBy: "test:task-323-expiry" },
      execution: { version: 1, kind: "chat", threadId: "00000000-0000-0000-0000-000000000323" }, provider: "claude",
    });
    await parkTaskRun(options, persisted.runId);
    const request = await createSecretRequest(options, {
      tenantId: persisted.task.tenantId, roleId: persisted.task.roleId, runId: persisted.runId, label: "token", purpose: "test expiry",
    });
    await pool.query("UPDATE secret_requests SET created_at = now() - interval '2 minutes' WHERE request_id = $1", [request.requestId]);
    await withPgBossQueueLock(pool, async () => {
      await purgePgBossQueue(pool, WORKER_HEARTBEAT_JOB);
      await purgePgBossQueue(pool, WORKER_ROUTINE_POLL_JOB);
      await purgePgBossQueue(pool, WORKER_RUN_EXECUTION_JOB);
      const worker = await runWorker({
        connectionString: connectionString!, tenantId: "task-323-no-routines", reconcileFilter: { taskId: persisted.task.taskId },
        humanRequestExpiryMs: 1, humanRequestSweepIntervalMs: 20,
      });
      try {
        for (let attempt = 0; attempt < 50 && (await getRun(options, persisted.runId))?.status !== "failed"; attempt += 1) await delay(20);
        expect(await getRun(options, persisted.runId)).toMatchObject({ status: "failed", failureNote: "Human input request expired without an answer." });
        const audit = await getAuditEventsForRun(options, persisted.runId);
        expect(audit.some((event) => event.eventType === "run.human_request_expired" && event.payload.kind === "secret_request")).toBe(true);
        expect((await listMessages(options, "00000000-0000-0000-0000-000000000323")).some((message) => message.body.includes("not answered in time"))).toBe(true);
      } finally { await worker.stop(); }
    });
  }, 20_000);
});
