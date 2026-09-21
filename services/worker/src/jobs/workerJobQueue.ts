import { PgBoss, type Job } from "pg-boss";

import { type RoutinePollingOptions, runDueRoutinePoll } from "./routineJob.js";

/** The first production queue; future routine jobs are registered separately. */
export const WORKER_HEARTBEAT_JOB = "worker.heartbeat";
export const WORKER_ROUTINE_POLL_JOB = "worker.routine-poll";
/** Durable, reference-only work item. No prompt, credential, or approval crosses this boundary. */
export const WORKER_RUN_EXECUTION_JOB = "worker.run-execution";

export interface RunExecutionJob {
  readonly version: 1;
  readonly runId: string;
}

export interface WorkerHeartbeatJob {
  requestedAt: string;
}

export interface CreateWorkerJobQueueOptions {
  connectionString: string;
  /** Lets deployments and integration tests identify pg-boss-owned connections. */
  applicationName?: string;
  onHeartbeat?(job: Job<WorkerHeartbeatJob>): Promise<void> | void;
  /** Enables the durable routine poller when its tenant configuration is supplied. */
  routinePolling?: RoutinePollingOptions;
  /** The worker-owned executor. API processes only enqueue these jobs. */
  onRunExecution?(job: Job<RunExecutionJob>): Promise<void> | void;
  /** Test seam: shortens the run-execution expiry. Production uses RUN_EXECUTION_EXPIRE_SECONDS. */
  runExecutionExpireInSeconds?: number;
  /**
   * TASK-221: pg-boss's own 'error' event, and any error thrown inside a
   * `work()` handler, is otherwise completely silent — a job just fails (or
   * retries) with nothing logged anywhere. That turned a transient failure
   * (e.g. connection-pool pressure during `runDueRoutinePoll`) into an
   * unexplained "the routine's fire outcome just didn't update" symptom
   * with no diagnostic trail. Defaults to `console.error`, matching this
   * package's existing convention (see registerCapabilities.ts).
   */
  onError?(error: unknown, context: { job: string }): Promise<void> | void;
}

const heartbeatQueueOptions = {
  policy: "singleton",
  retryLimit: 3,
  retryDelay: 1,
  retryBackoff: true,
  expireInSeconds: 60,
  retentionSeconds: 86_400,
  deleteAfterSeconds: 604_800,
} as const;

const routinePollQueueOptions = {
  policy: "singleton",
  retryLimit: 3,
  retryDelay: 1,
  retryBackoff: true,
  expireInSeconds: 60,
  retentionSeconds: 86_400,
  deleteAfterSeconds: 604_800,
} as const;

/**
 * TASK-322: a Claude-lane sandbox command may run 10 minutes
 * (chatRunDriver SANDBOX_COMMAND_TIMEOUT_MS) and a run holds several. pg-boss has no
 * handler heartbeat: at expiry it fails the job and retries it while the first
 * handler is still running, and main.ts only skips TERMINAL runs, so the old 300 s
 * expiry started a live run a second time. 30 min clears the command timeout with
 * margin; the in-flight guard below closes the remaining same-process window.
 */
export const RUN_EXECUTION_EXPIRE_SECONDS = 1_800;

const runExecutionQueueOptions = {
  policy: "singleton",
  retryLimit: 3,
  retryDelay: 1,
  retryBackoff: true,
  expireInSeconds: RUN_EXECUTION_EXPIRE_SECONDS,
  retentionSeconds: 86_400,
  deleteAfterSeconds: 604_800,
} as const;

const ROUTINE_POLL_CRON = "* * * * *";

function assertConnectionString(connectionString: string): void {
  if (connectionString.trim().length === 0) {
    throw new Error("DATABASE_URL must not be empty when starting the worker job queue.");
  }
}

/**
 * Owns the worker's pg-boss lifecycle. It deliberately has no process-level
 * side effects: the service bootstrap starts it, and its shutdown hook stops it.
 */
export class WorkerJobQueue {
  private boss: PgBoss | undefined;
  /** Run ids whose handler is executing in this process; a retry of one is a no-op. */
  private readonly inFlightRuns = new Set<string>();

  public constructor(private readonly options: CreateWorkerJobQueueOptions) {
    assertConnectionString(options.connectionString);
  }

  public async start(): Promise<void> {
    if (this.boss !== undefined) return;

    const boss = new PgBoss({
      connectionString: this.options.connectionString,
      application_name: this.options.applicationName ?? "oikonomos-worker-jobs",
    });

    const onError = this.options.onError ?? ((error: unknown) => console.error(error));
    boss.on("error", (error) => void onError(error, { job: "pg-boss" }));

    try {
      await boss.start();
      await boss.createQueue(WORKER_HEARTBEAT_JOB, heartbeatQueueOptions);
      await boss.work<WorkerHeartbeatJob>(WORKER_HEARTBEAT_JOB, async (jobs) => {
        for (const job of jobs) await this.options.onHeartbeat?.(job);
      });
      if (this.options.onRunExecution !== undefined) {
        const expireInSeconds = this.options.runExecutionExpireInSeconds ?? RUN_EXECUTION_EXPIRE_SECONDS;
        await boss.createQueue(WORKER_RUN_EXECUTION_JOB, { ...runExecutionQueueOptions, expireInSeconds });
        // createQueue is a no-op for an existing queue; re-apply so a stale 300 s expiry is replaced.
        await boss.updateQueue(WORKER_RUN_EXECUTION_JOB, { expireInSeconds });
        await boss.work<RunExecutionJob>(WORKER_RUN_EXECUTION_JOB, async (jobs) => {
          for (const job of jobs) {
            if (job.data.version !== 1 || typeof job.data.runId !== "string" || job.data.runId.trim().length === 0) {
              throw new Error("worker.run-execution received an invalid payload.");
            }
            const runId = job.data.runId.trim();
            // A retry (expiry/backoff) of a run this process is still executing must not
            // start it, or spend its budget, a second time.
            if (this.inFlightRuns.has(runId)) continue;
            this.inFlightRuns.add(runId);
            try {
              await this.options.onRunExecution!(job);
            } finally {
              this.inFlightRuns.delete(runId);
            }
          }
        });
      }
      if (this.options.routinePolling !== undefined) {
        await boss.createQueue(WORKER_ROUTINE_POLL_JOB, routinePollQueueOptions);
        await boss.work(WORKER_ROUTINE_POLL_JOB, async () => {
          try {
            await runDueRoutinePoll(this.options.routinePolling!);
          } catch (error) {
            await onError(error, { job: WORKER_ROUTINE_POLL_JOB });
            throw error; // still fails/retries the job the same as before — this only adds visibility.
          }
        });
        // pg-boss owns this durable repeating schedule, so a worker restart
        // neither loses nor duplicates the next routine sweep.
        await boss.schedule(WORKER_ROUTINE_POLL_JOB, ROUTINE_POLL_CRON);
      }
      this.boss = boss;
    } catch (error) {
      await boss.stop({ close: true }).catch(() => undefined);
      throw error;
    }
  }

  public async enqueueHeartbeat(requestedAt = new Date().toISOString()): Promise<string> {
    if (this.boss === undefined) {
      throw new Error("Worker job queue must be started before jobs can be enqueued.");
    }

    const id = await this.boss.send(WORKER_HEARTBEAT_JOB, { requestedAt });
    if (id === null) throw new Error("pg-boss did not create the heartbeat job.");
    return id;
  }

  /** Enqueue an immediate durable poll, used by bootstraps and integration tests. */
  public async enqueueRoutinePoll(): Promise<string> {
    if (this.boss === undefined) {
      throw new Error("Worker job queue must be started before jobs can be enqueued.");
    }
    if (this.options.routinePolling === undefined) {
      throw new Error("Routine polling is not configured for this worker job queue.");
    }

    const id = await this.boss.send(WORKER_ROUTINE_POLL_JOB, {});
    if (id === null) throw new Error("pg-boss did not create the routine poll job.");
    return id;
  }

  public async enqueueRunExecution(runId: string): Promise<string> {
    if (this.boss === undefined) throw new Error("Worker job queue must be started before jobs can be enqueued.");
    const normalizedRunId = runId.trim();
    if (normalizedRunId.length === 0) throw new Error("runId must not be empty.");
    const id = await this.boss.send(WORKER_RUN_EXECUTION_JOB, { version: 1, runId: normalizedRunId }, {
      singletonKey: normalizedRunId,
    });
    if (id === null) throw new Error("pg-boss did not create the run execution job.");
    return id;
  }

  public async stop(): Promise<void> {
    const boss = this.boss;
    this.boss = undefined;
    if (boss !== undefined) await boss.stop({ close: true, graceful: true, timeout: 10_000 });
  }
}

export function createWorkerJobQueue(options: CreateWorkerJobQueueOptions): WorkerJobQueue {
  return new WorkerJobQueue(options);
}

/**
 * API-facing producer: opens no executor and carries only the run reference.
 * pg-boss persists the job before this function returns, then the short-lived
 * producer connection is closed; the worker owns consumption.
 */
export async function enqueueRunExecution(connectionString: string, runId: string): Promise<string> {
  assertConnectionString(connectionString);
  const normalizedRunId = runId.trim();
  if (normalizedRunId.length === 0) throw new Error("runId must not be empty.");
  const boss = new PgBoss({ connectionString, application_name: "oikonomos-run-enqueuer" });
  try {
    await boss.start();
    await boss.createQueue(WORKER_RUN_EXECUTION_JOB, runExecutionQueueOptions);
    await boss.updateQueue(WORKER_RUN_EXECUTION_JOB, { expireInSeconds: RUN_EXECUTION_EXPIRE_SECONDS });
    const id = await boss.send(WORKER_RUN_EXECUTION_JOB, { version: 1, runId: normalizedRunId }, {
      singletonKey: normalizedRunId,
    });
    if (id === null) throw new Error("pg-boss did not create the run execution job.");
    return id;
  } finally {
    await boss.stop({ close: true }).catch(() => undefined);
  }
}
