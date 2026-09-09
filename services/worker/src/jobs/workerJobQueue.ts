import { PgBoss, type Job } from "pg-boss";

import { type RoutinePollingOptions, runDueRoutinePoll } from "./routineJob.js";

/** The first production queue; future routine jobs are registered separately. */
export const WORKER_HEARTBEAT_JOB = "worker.heartbeat";
export const WORKER_ROUTINE_POLL_JOB = "worker.routine-poll";

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

  public async stop(): Promise<void> {
    const boss = this.boss;
    this.boss = undefined;
    if (boss !== undefined) await boss.stop({ close: true, graceful: true, timeout: 10_000 });
  }
}

export function createWorkerJobQueue(options: CreateWorkerJobQueueOptions): WorkerJobQueue {
  return new WorkerJobQueue(options);
}
