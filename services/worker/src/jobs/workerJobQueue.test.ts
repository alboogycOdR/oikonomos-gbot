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

import { createWorkerJobQueue, type WorkerJobQueue } from "./workerJobQueue.js";

const connectionString = process.env.DATABASE_URL;
const integration = connectionString === undefined ? describe.skip : describe;

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

async function waitFor<T>(read: () => Promise<T | undefined>): Promise<T> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(50);
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

  it("uses a real pg-boss poll job to queue each due routine and persist its fire outcome", async () => {
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

    applicationName = `oikonomos-worker-routines-${crypto.randomUUID()}`;
    queue = createWorkerJobQueue({
      connectionString: connectionString!,
      applicationName,
      routinePolling: { connectionString: connectionString!, tenantId },
    });
    await queue.start();
    await expect(queue.enqueueRoutinePoll()).resolves.toMatch(/^[0-9a-f-]{36}$/i);

    const task = await waitFor(async () => {
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
  });

  it("records a due routine as missed without queueing work when its role is not active", async () => {
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

    applicationName = `oikonomos-worker-routines-${crypto.randomUUID()}`;
    queue = createWorkerJobQueue({
      connectionString: connectionString!,
      applicationName,
      routinePolling: { connectionString: connectionString!, tenantId },
    });
    await queue.start();
    await queue.enqueueRoutinePoll();

    const persisted = await waitFor(async () => {
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
  });
});
