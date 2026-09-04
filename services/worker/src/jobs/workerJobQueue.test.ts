import { setTimeout as delay } from "node:timers/promises";

import { defaultPoolConfig } from "@oikonomos/db";
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
});
