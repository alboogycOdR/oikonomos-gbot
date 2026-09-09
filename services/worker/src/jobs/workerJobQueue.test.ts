import { setTimeout as delay } from "node:timers/promises";

import {
  createRole,
  createRoutine,
  defaultPoolConfig,
  getRoutine,
  listTasks,
  recordRoutineFire,
} from "@oikonomos/db";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createWorkerJobQueue, WORKER_ROUTINE_POLL_JOB, type WorkerJobQueue } from "./workerJobQueue.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

/**
 * TASK-221: `WORKER_ROUTINE_POLL_JOB` is a fixed literal, unlike this file's other
 * per-test identifiers (tenantId/roleId/applicationName, all randomized). This is
 * what actually produced the "flaky" timeouts this task was filed to investigate —
 * NOT a defect in the poll path itself (proven live: a real pg-boss instance left
 * running self-heals and drains normally with zero code changes). Two DISTINCT,
 * confirmed layers of cross-run contamination on this one shared queue name:
 *
 * 1. `pgboss.job` rows. Under `singleton` policy the queue name is the dedup key,
 *    so a single leftover `active` row from any prior ungracefully-killed process
 *    (a crash, a `Ctrl+C`, a power loss — anything that skips `queue.stop()`)
 *    occupies the singleton slot for every future run, until pg-boss's own
 *    supervise/monitor cycle (60s default) expires it.
 * 2. `pgboss.queue.singletons_active` — a SEPARATE, queue-level cache of which
 *    singleton keys were active as of the last monitor pass, refreshed on the same
 *    60s-gated cycle. Confirmed by direct experiment: even after (1) is purged and
 *    even after manually forcing `boss.supervise()`, a job can still go unfetched
 *    in that same process, because `getQueueCache()` reads this cached queue row
 *    once per process and does not re-read after a same-process supervise() call.
 *    A genuinely fresh process reads it cleanly the instant the DB-side row itself
 *    is clean — proven by direct fetch() experiment. Deleting the queue row (not
 *    just its jobs) forces `createQueue()` to reinsert clean defaults, which is the
 *    only reset that is reliable from inside a single short-lived test process.
 *
 * Purge both before every test that touches this queue so neither layer of state
 * from any external process — this suite's own prior runs included — can leak in.
 */
async function purgeRoutinePollJobs(pool: Pool): Promise<void> {
  try {
    await pool.query("DELETE FROM pgboss.job WHERE name = $1", [WORKER_ROUTINE_POLL_JOB]);
    await pool.query("DELETE FROM pgboss.queue WHERE name = $1", [WORKER_ROUTINE_POLL_JOB]);
  } catch (error) {
    // pgboss.job/.queue do not exist yet on a genuinely fresh database — pg-boss
    // creates its schema on first boss.start(), which has not necessarily run yet.
    if ((error as { code?: string }).code !== "42P01") throw error;
  }
}

async function waitForNoConnections(pool: Pool, applicationName: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await pool.query<{ count: string }>(
      "SELECT count(*) FROM pg_stat_activity WHERE application_name = $1",
      [applicationName],
    );
    if (result.rows[0]?.count === "0") return;
    await delay(50);
  }
  throw new Error(`pg-boss connections for ${applicationName} remained after shutdown.`);
}

/**
 * TASK-221: pg-boss's own default `pollingInterval` is 2000ms (LISTEN/NOTIFY gives an
 * instant wake when it fires, but is not guaranteed on every connection path — this
 * container's setup does not reliably deliver it), so a budget at or near 2000ms races
 * the mechanism's own default cadence instead of testing the behaviour. 12s comfortably
 * clears one worst-case base-interval poll plus scheduling jitter without masking a
 * genuinely broken poll path, which would still exhaust this and fail loudly.
 */
async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(100);
  }
  throw new Error("Timed out waiting for the pg-boss routine poll job.");
}

describe("WorkerJobQueue input validation", () => {
  it("rejects an empty database URL before opening a connection", () => {
    expect(() => createWorkerJobQueue({ connectionString: "  " })).toThrow(/DATABASE_URL/);
  });

  it("requires the queue to start before it accepts jobs", async () => {
    const queue = createWorkerJobQueue({ connectionString: "postgres://unused" });
    await expect(queue.enqueueHeartbeat()).rejects.toThrow(/started/);
  });
});

integration("WorkerJobQueue — pg-boss lifecycle against PostgreSQL", () => {
  let pool: Pool;
  let queue: WorkerJobQueue | undefined;
  let applicationName: string;

  beforeAll(() => {
    pool = new Pool({ connectionString: connectionString!, ...defaultPoolConfig });
  });

  afterEach(async () => {
    await queue?.stop();
    queue = undefined;
  });

  afterAll(async () => {
    await pool.end();
  });

  it("runs a scheduled heartbeat job through real pg-boss", async () => {
    let resolveObserved: (requestedAt: string) => void;
    const observed = new Promise<string>((resolve) => {
      resolveObserved = resolve;
    });
    applicationName = `oikonomos-worker-jobs-${crypto.randomUUID()}`;
    queue = createWorkerJobQueue({
      connectionString: connectionString!,
      applicationName,
      onHeartbeat: (job) => resolveObserved(job.data.requestedAt),
    });

    await queue.start();
    const requestedAt = new Date().toISOString();
    await expect(queue.enqueueHeartbeat(requestedAt)).resolves.toMatch(/^[0-9a-f-]{36}$/i);
    await expect(observed).resolves.toBe(requestedAt);
  });

  it("closes every pg-boss connection on shutdown", async () => {
    applicationName = `oikonomos-worker-jobs-${crypto.randomUUID()}`;
    queue = createWorkerJobQueue({ connectionString: connectionString!, applicationName });

    await queue.start();
    await queue.stop();
    queue = undefined;
    await waitForNoConnections(pool, applicationName);
  });

  // Explicit timeout: must comfortably clear waitFor's own budget (see its comment) —
  // Vitest's 5000ms default would otherwise kill the test before waitFor gets to try.
  it("uses a real pg-boss poll job to queue each due routine and persist its fire outcome", async () => {
    await purgeRoutinePollJobs(pool);
    const tenantId = `task-132-queued-${crypto.randomUUID()}`;
    const roleId = `task-132-queued-role-${crypto.randomUUID()}`;
    await createRole(
      { connectionString: connectionString! },
      { roleId, tenantId, name: "Routine queue role", title: "Routine queue role" },
    );
    const routine = await createRoutine(
      { connectionString: connectionString! },
      {
        roleId,
        tenantId,
        name: "Prepare daily digest",
        definition: { goal: "Compile the daily digest" },
      },
    );
    const dueAt = new Date(Date.now() - 1_000);
    await recordRoutineFire({ connectionString: connectionString! }, routine.routineId, "missed", dueAt);

    // TASK-221: captures anything WorkerJobQueue's onError reports, so a poll job
    // that throws (e.g. a transient DB error under parallel-suite load) shows up
    // here with a real stack instead of surfacing only as "the status didn't
    // change" with no explanation.
    const pollErrors: unknown[] = [];
    applicationName = `oikonomos-worker-routines-${crypto.randomUUID()}`;
    queue = createWorkerJobQueue({
      connectionString: connectionString!,
      applicationName,
      routinePolling: { connectionString: connectionString!, tenantId },
      onError: (error) => { pollErrors.push(error); },
    });
    await queue.start();
    await expect(queue.enqueueRoutinePoll()).resolves.toMatch(/^[0-9a-f-]{36}$/i);

    const task = await waitFor(async () => {
      if (pollErrors.length > 0) throw new Error(`routine poll errored: ${String(pollErrors[0])}`);
      const page = await listTasks({ connectionString: connectionString! }, { tenantId });
      return page.tasks.find((candidate) => candidate.routineId === routine.routineId);
    });
    expect(task).toMatchObject({
      roleId,
      title: "Prepare daily digest",
      goal: "Compile the daily digest",
      requestedBy: `routine:${routine.routineId}`,
    });
    const persisted = await getRoutine({ connectionString: connectionString! }, routine.routineId);
    expect(persisted).toMatchObject({
      lastFireStatus: "queued",
      nextFireAt: dueAt,
    });
    expect(persisted?.lastFireAt).not.toBeNull();
  }, 15_000);

  it("records a due routine as missed without queueing work when its role is not active", async () => {
    await purgeRoutinePollJobs(pool);
    const tenantId = `task-132-missed-${crypto.randomUUID()}`;
    const roleId = `task-132-missed-role-${crypto.randomUUID()}`;
    await createRole(
      { connectionString: connectionString! },
      { roleId, tenantId, name: "Hidden routine role", title: "Hidden routine role", status: "hidden" },
    );
    const routine = await createRoutine(
      { connectionString: connectionString! },
      { roleId, tenantId, name: "Do not run", definition: {} },
    );
    const dueAt = new Date(Date.now() - 1_000);
    const beforePoll = await recordRoutineFire(
      { connectionString: connectionString! },
      routine.routineId,
      "queued",
      dueAt,
    );
    expect(beforePoll.lastFireStatus).toBe("queued");

    const pollErrors: unknown[] = [];
    applicationName = `oikonomos-worker-routines-${crypto.randomUUID()}`;
    queue = createWorkerJobQueue({
      connectionString: connectionString!,
      applicationName,
      routinePolling: { connectionString: connectionString!, tenantId },
      onError: (error) => { pollErrors.push(error); },
    });
    await queue.start();
    await queue.enqueueRoutinePoll();

    const persisted = await waitFor(async () => {
      if (pollErrors.length > 0) throw new Error(`routine poll errored: ${String(pollErrors[0])}`);
      const candidate = await getRoutine({ connectionString: connectionString! }, routine.routineId);
      return candidate?.lastFireStatus === "missed" ? candidate : undefined;
    });
    expect(persisted).toMatchObject({
      lastFireStatus: "missed",
      nextFireAt: dueAt,
    });
    expect(persisted.lastFireAt).toEqual(beforePoll.lastFireAt);
    const tasks = await listTasks({ connectionString: connectionString! }, { tenantId });
    expect(tasks.tasks).toHaveLength(0);
  }, 15_000);
});
