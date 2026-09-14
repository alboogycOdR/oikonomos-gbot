import { fileURLToPath } from "node:url";

import { createWorkerJobQueue } from "./jobs/workerJobQueue.js";
import { createChatRunDriver, type CreateChatRunDriverOptions } from "./chatRunDriver.js";
import { createRunGate } from "./runConcurrency.js";
import { getOrCreateThreadForRole, getRun, getTask, insertAuditEvent, listMessages } from "@oikonomos/db";
import { failTaskRun, parkTaskRun, reconcileInterruptedRuns, startTaskRun } from "./runLifecycle.js";
import { deliverBotToBotMessage } from "./groupFanout.js";

/**
 * TASK-226 (OIK-106) — the worker's real process entrypoint.
 *
 * Before this, `createWorkerJobQueue` and `reconcileInterruptedRuns` were
 * both real, both tested, and had ZERO production call sites: no service
 * anywhere in this repo actually booted a worker process (`services/worker`,
 * like every other service package here, was `main`-only — a library other
 * packages import from, not something anyone ran). Confirmed directly:
 * `git grep createWorkerJobQueue` outside this package's own tests returns
 * nothing, and `infra/compose/docker-compose.local.yml` runs only Postgres.
 * There is, as of this file, still no container/compose entry that runs
 * this — that is a deployment/ops concern this task deliberately leaves
 * open (see Progress_Notes) — but the process itself now exists and does
 * the right thing the moment something does run it.
 *
 * Boot sequence, in order:
 * 1. Reconcile every run left open by whatever process was running before
 *    this one — the crash-recovery sweep this task exists to wire in.
 *    Runs BEFORE the job queue starts so an orphaned run's resume can't
 *    race a freshly-dispatched job for the same run.
 * 2. Start the job queue (heartbeat + routine polling, if configured).
 *
 * `TENANT_ID` follows the existing `DEFAULT_TENANT_ID = "basileia"`
 * precedent in `packages/approvals/src/editApproval.ts` — routine polling
 * (`runDueRoutinePoll`/`listRoutines`) requires a single `tenantId` per
 * call and has no "list all tenants" mode, so this system is single-tenant
 * in practice today (matching CLAUDE.md's "Basileia-owned accounts only"
 * scope boundary); a real multi-tenant poll-fan-out is out of scope here.
 */
export interface RunWorkerOptions {
  connectionString: string;
  tenantId: string;
  onLog?(message: string): void;
  /**
   * Scopes the boot-time reconciliation sweep. Real production boot always
   * omits this (every open run in the database, per `reconcileInterruptedRuns`'
   * own documented intent) — it exists so a test can prove this call site
   * without touching runs any concurrently-running test file's fixtures
   * left open, the same `taskId`-scoping convention `runLifecycle.test.ts`
   * already established for the function itself.
   */
  reconcileFilter?: { tenantId?: string; taskId?: string };
  /** Test seam; production uses the normal worker chat-driver composition. */
  chatRunDriverOptions?: Omit<CreateChatRunDriverOptions, "connectionString">;
}

export async function runWorker(options: RunWorkerOptions): Promise<{ stop(): Promise<void> }> {
  const log = options.onLog ?? ((message: string) => console.log(message));

  const database = { connectionString: options.connectionString };
  const driver = createChatRunDriver({ ...database, ...options.chatRunDriverOptions });
  const gate = createRunGate({ maxConcurrent: 2 });
  const queue = createWorkerJobQueue({
    connectionString: options.connectionString,
    onHeartbeat: () => log("heartbeat"),
    routinePolling: { connectionString: options.connectionString, tenantId: options.tenantId },
    onError: (error, context) => console.error(`worker job queue error (${context.job}):`, error),
    onRunExecution: async (job) => {
      const run = await getRun(database, job.data.runId);
      if (run === null || run.status === "waiting_approval" || run.status === "completed" || run.status === "failed" || run.status === "cancelled") return;
      const task = await getTask(database, run.taskId);
      if (task === null) throw new Error(`run ${run.runId} references a missing task.`);
      if (task.execution == null) {
        await failTaskRun(database, run.runId, "execution_unresolvable");
        await insertAuditEvent(database, {
          tenantId: run.tenantId, runId: run.runId, actor: "system:run-execution",
          eventType: "run.execution_unresolvable", payload: { reason: "missing_execution" },
        });
        return;
      }
      const executionCommand = task.execution;
      const thread = await getOrCreateThreadForRole(database, { roleId: task.roleId });
      await gate.run(task.roleId, async (execution) => {
        if (execution.queued !== null) {
          await insertAuditEvent(database, {
            tenantId: run.tenantId, runId: run.runId, actor: "system:run-concurrency", eventType: "run.queued",
            payload: { taskId: task.taskId, roleId: task.roleId, position: execution.queued.position, reason: "consumer_gate" },
          });
        }
        if (executionCommand.kind === "fanout") {
          const source = (await listMessages(database, executionCommand.threadId)).find(
            (message) => message.id === executionCommand.sourceMessageId,
          );
          if (source === undefined) {
            await failTaskRun(database, run.runId, "execution_unresolvable");
            await insertAuditEvent(database, {
              tenantId: run.tenantId, runId: run.runId, actor: "system:run-execution",
              eventType: "run.execution_unresolvable", payload: { reason: "source_message_missing" },
            });
            return;
          }
          const result = await deliverBotToBotMessage(database, {
            fromRoleId: "human", toRoleIds: [executionCommand.recipientRoleId], body: source.body,
            runId: run.runId, tenantId: run.tenantId,
          });
          if (!result.delivered) await parkTaskRun(database, run.runId);
          return;
        }
        // The run row is created by the API before it enqueues this
        // reference.  Always retain that identity: a missing session ref
        // means "start this persisted run", not "create another run".
        // A non-empty Claude session ref additionally selects the provider
        // continuation path inside the driver.
        const resume = run.provider === "claude" && run.sessionRef !== null
          ? { runId: run.runId, sessionRef: run.sessionRef }
          : { runId: run.runId };
        await driver.run({ task, threadId: thread.id, resume });
      });
    },
  });
  await queue.start();
  const reconciled = await reconcileInterruptedRuns(database, options.reconcileFilter ?? {}, async (run) => {
    if (run.provider === "claude" && run.sessionRef !== null) {
      await queue.enqueueRunExecution(run.runId);
      return { runId: run.runId, mode: "resume" };
    }
    // A provider with no resumable session is never relabelled "resumed".
    // Close the interrupted turn, then enqueue exactly one fresh run on the
    // same persisted task; the driver rebuilds its prompt from thread state.
    await failTaskRun(database, run.runId, "worker_restart");
    const replacement = await startTaskRun(database, { taskId: run.taskId, tenantId: run.tenantId, provider: run.provider });
    await queue.enqueueRunExecution(replacement.runId);
    return { runId: replacement.runId, mode: "new_run" };
  });
  if (reconciled.length > 0) log(`reconciled ${reconciled.length} interrupted run(s) at boot: queued for execution.`);
  log("worker started: heartbeat + routine polling live.");

  return { stop: () => queue.stop() };
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString.trim().length === 0) {
    throw new Error("DATABASE_URL is required to start the worker.");
  }
  const tenantId = process.env.OIK_TENANT_ID?.trim() || "basileia";

  const worker = await runWorker({ connectionString, tenantId });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down worker gracefully...`);
    void worker
      .stop()
      .catch((error: unknown) => console.error("error during worker shutdown:", error))
      .finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
