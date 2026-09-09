import { fileURLToPath } from "node:url";

import { createWorkerJobQueue } from "./jobs/workerJobQueue.js";
import { reconcileInterruptedRuns } from "./runLifecycle.js";

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
}

export async function runWorker(options: RunWorkerOptions): Promise<{ stop(): Promise<void> }> {
  const log = options.onLog ?? ((message: string) => console.log(message));

  const reconciled = await reconcileInterruptedRuns(
    { connectionString: options.connectionString },
    options.reconcileFilter ?? {},
  );
  if (reconciled.length > 0) {
    const failed = reconciled.filter((outcome) => outcome.outcome === "resume_failed");
    log(
      `reconciled ${reconciled.length} interrupted run(s) at boot: ${reconciled.length - failed.length} resumed, ${failed.length} failed to resume.`,
    );
    for (const outcome of failed) {
      console.error(`failed to resume interrupted run ${outcome.runId}: ${outcome.error ?? "unknown error"}`);
    }
  }

  const queue = createWorkerJobQueue({
    connectionString: options.connectionString,
    onHeartbeat: () => log("heartbeat"),
    routinePolling: { connectionString: options.connectionString, tenantId: options.tenantId },
    onError: (error, context) => console.error(`worker job queue error (${context.job}):`, error),
  });
  await queue.start();
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
