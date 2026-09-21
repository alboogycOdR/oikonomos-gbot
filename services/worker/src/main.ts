import { fileURLToPath } from "node:url";

import { createSandboxClient } from "@oikonomos/sandbox-client";

import { createWorkerJobQueue } from "./jobs/workerJobQueue.js";
import { createChatRunDriver, type CreateChatRunDriverOptions } from "./chatRunDriver.js";
import { createRunGate } from "./runConcurrency.js";
import { expirePendingSecretRequests, getOrCreateThreadForRole, getRun, getTask, insertAuditEvent, insertMessage, listMessages } from "@oikonomos/db";
import { failTaskRun, parkTaskRun, reconcileInterruptedRuns, startTaskRun } from "./runLifecycle.js";
import { deliverBotToBotMessage } from "./groupFanout.js";
import { createRoleMessageDeliveryPoller } from "./roleMessageDelivery.js";
import { createSandboxReaperScheduler, type SandboxReaperScheduler } from "./sandboxReaper.js";
import { DEFAULT_HUMAN_REQUEST_EXPIRY_MS, HUMAN_REQUEST_EXPIRED_EVENT_TYPE, getTakeoverState, listExpiredTakeovers } from "./takeover.js";

const HUMAN_REQUEST_EXPIRY_FAILURE_NOTE = "Human input request expired without an answer.";
const DEFAULT_HUMAN_REQUEST_SWEEP_INTERVAL_MS = 60_000;

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
 * 3. Start the role-message delivery poller (TASK-273) — a separate, small
 *    pg-boss lifecycle (`RoleMessageDeliveryPoller`,
 *    `services/worker/src/roleMessageDelivery.ts`) that turns each
 *    undelivered `role_messages` row into a real chat run on the
 *    recipient's own thread. Kept independent of `WorkerJobQueue` rather
 *    than folded into it: that class's file is outside this task's
 *    `Owned_Paths`, so this mirrors its start/schedule/stop shape instead
 *    of editing it.
 * 4. Start the sandbox reaper scheduler (TASK-296) — a plain in-process
 *    interval, gated on `SANDBOX_INTEGRATION_URL` being set (same gate
 *    `chatRunDriver.ts`'s own `productionSandboxClient` uses), so a local
 *    dev boot without OpenSandbox configured never throws just for lacking
 *    something to reap. Reclaims idle/deleted-role offices and reconciles
 *    server-side orphans a cascade-deleted role left behind
 *    (`scripts/db-cleanup.mjs`) — see `sandboxReaper.ts`'s own module
 *    comment for the full incident this closes (TASK-292).
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
  /** Test/operations seams; production defaults to ten minutes and sweeps once a minute. */
  humanRequestExpiryMs?: number;
  humanRequestSweepIntervalMs?: number;
}

function positiveMs(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

async function failExpiredHumanRequest(
  database: { connectionString: string },
  runId: string,
  kind: "secret_request" | "takeover",
): Promise<void> {
  const run = await failTaskRun(database, runId, HUMAN_REQUEST_EXPIRY_FAILURE_NOTE);
  await insertAuditEvent(database, {
    tenantId: run.tenantId, runId, actor: "system:human-request-expiry",
    eventType: HUMAN_REQUEST_EXPIRED_EVENT_TYPE, payload: { kind, reason: "unanswered" },
  });
  const task = await getTask(database, run.taskId);
  if (task?.execution !== null && task?.execution !== undefined) {
    await insertMessage(database, {
      threadId: task.execution.threadId, role: "system",
      body: `I couldn't continue because a required human ${kind === "takeover" ? "takeover" : "secret request"} was not answered in time. The run has been stopped.`,
    }).catch((error: unknown) => console.error("failed to post human-request expiry message:", error));
  }
}

/** The production sweep: expiry always fails parked work; it never resumes into a challenge. */
export async function runHumanRequestExpirySweep(
  database: { connectionString: string },
  expiryMs = DEFAULT_HUMAN_REQUEST_EXPIRY_MS,
): Promise<number> {
  const olderThan = new Date(Date.now() - positiveMs(expiryMs, DEFAULT_HUMAN_REQUEST_EXPIRY_MS));
  let expired = 0;
  for (const request of await expirePendingSecretRequests(database, olderThan)) {
    await failExpiredHumanRequest(database, request.runId, "secret_request");
    expired += 1;
  }
  for (const candidate of await listExpiredTakeovers(database, olderThan)) {
    // A hand-back can race this scan; the final state check protects a human who took control.
    if (!(await getTakeoverState(database, candidate.runId)).pending) continue;
    await failExpiredHumanRequest(database, candidate.runId, "takeover");
    expired += 1;
  }
  return expired;
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
  const roleMessageDeliveryPoller = createRoleMessageDeliveryPoller({
    connectionString: options.connectionString,
    tenantId: options.tenantId,
    onError: (error, context) => console.error(`role-message delivery poller error (${context.job}):`, error),
  });
  await roleMessageDeliveryPoller.start();
  // TASK-296: only wired when a real OpenSandbox integration URL is
  // configured — mirrors chatRunDriver.ts's own productionSandboxClient
  // gate, so OIKONOMOS_CHAT_EXECUTION_MODE=local development boots without
  // throwing just because nothing is there to reap.
  const sandboxIntegrationUrl = process.env.SANDBOX_INTEGRATION_URL?.trim();
  const sandboxReaperScheduler: SandboxReaperScheduler | undefined =
    sandboxIntegrationUrl === undefined || sandboxIntegrationUrl.length === 0
      ? undefined
      : createSandboxReaperScheduler({
          ...database,
          client: createSandboxClient({ baseUrl: sandboxIntegrationUrl }),
          onSweep: (summary) => log(`sandbox reaper sweep: ${JSON.stringify(summary)}`),
          onError: (error) => console.error("sandbox reaper sweep error:", error),
        });
  sandboxReaperScheduler?.start();
  const expiryMs = positiveMs(options.humanRequestExpiryMs ?? Number(process.env.OIK_HUMAN_REQUEST_EXPIRY_MS), DEFAULT_HUMAN_REQUEST_EXPIRY_MS);
  const expiryIntervalMs = positiveMs(options.humanRequestSweepIntervalMs ?? Number(process.env.OIK_HUMAN_REQUEST_SWEEP_INTERVAL_MS), DEFAULT_HUMAN_REQUEST_SWEEP_INTERVAL_MS);
  let expirySweeping = false;
  const expire = async (): Promise<void> => {
    if (expirySweeping) return;
    expirySweeping = true;
    try {
      const expired = await runHumanRequestExpirySweep(database, expiryMs);
      if (expired > 0) log(`expired ${expired} unanswered human request(s).`);
    } catch (error) {
      console.error("human-request expiry sweep error:", error);
    } finally { expirySweeping = false; }
  };
  const humanRequestExpiryTimer = setInterval(() => { void expire(); }, expiryIntervalMs);
  humanRequestExpiryTimer.unref?.();
  void expire();
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
  log(
    `worker started: heartbeat + routine polling + role-message delivery polling live` +
      `${sandboxReaperScheduler === undefined ? " (sandbox reaper not configured)" : " + sandbox reaper sweeping"}.`,
  );

  return {
    stop: async () => {
      clearInterval(humanRequestExpiryTimer);
      sandboxReaperScheduler?.stop();
      await roleMessageDeliveryPoller.stop();
      await queue.stop();
    },
  };
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
