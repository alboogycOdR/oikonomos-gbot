import type { Pool, PoolClient } from "pg";

/**
 * TASK-221/TASK-226: `WORKER_HEARTBEAT_JOB`/`WORKER_ROUTINE_POLL_JOB` are
 * fixed literal pg-boss queue names, shared by every test that starts a real
 * `WorkerJobQueue` — `workerJobQueue.test.ts` and `main.test.ts` alike, now
 * that TASK-226 added a second real caller. Confirmed by direct experiment
 * (TASK-221): under `singleton` policy, cross-run/cross-file contamination
 * on a shared queue name happens at two distinct, independently-poisonable
 * layers — `pgboss.job` rows (the dedup key under `singleton` policy) and
 * `pgboss.queue.singletons_active` (a separate, queue-level, 60s-gated
 * cache, read once per process and NOT refreshed by a same-process
 * `supervise()` call). Purge both, for every queue name any test in this
 * package might start, before any test that starts a real queue.
 */
export async function purgePgBossQueue(pool: Pool, queueName: string): Promise<void> {
  try {
    await pool.query("DELETE FROM pgboss.job WHERE name = $1", [queueName]);
    await pool.query("DELETE FROM pgboss.queue WHERE name = $1", [queueName]);
  } catch (error) {
    // pgboss.job/.queue do not exist yet on a genuinely fresh database — pg-boss
    // creates its schema on first boss.start(), which has not necessarily run yet.
    if ((error as { code?: string }).code !== "42P01") throw error;
  }
}

/**
 * A fixed key, arbitrary but stable across every test file that calls
 * `withPgBossQueueLock` — the whole point is that everyone contends for the
 * SAME lock, not one keyed per queue name (two different queue names being
 * purged/started concurrently by two different files is exactly the race
 * this exists to prevent, so a per-queue key would defeat it).
 */
const PG_BOSS_TEST_LOCK_KEY = 0x7a51_9e21;

/**
 * TASK-226: purging rows before a test starts is NOT enough on its own —
 * `workerJobQueue.test.ts` and `main.test.ts` are separate FILES, and Vitest
 * runs separate files concurrently by default (separate worker threads),
 * each with its own `Pool`. Two tests in two different files can easily
 * both purge, then both start a real `WorkerJobQueue` against the SAME
 * literal queue name at almost the same moment — the purge from one can
 * land between the other's purge and its own `queue.start()`, or their
 * `singletons_active` cache refreshes can interleave. A `pg_advisory_lock`
 * is a real, DB-side mutual exclusion primitive that serializes every test
 * (across every file, in this process or any other) that wraps its
 * pgboss-shared-queue work in this helper — the one thing purging rows
 * cannot provide on its own. Uses a single held `PoolClient` for the lock's
 * whole lifetime deliberately: `pg_advisory_lock`/`_unlock` are session-
 * scoped, so acquiring and releasing through a round-robin `Pool.query()`
 * risks the unlock landing on a different backend connection than the lock.
 */
export async function withPgBossQueueLock<T>(pool: Pool, fn: () => Promise<T>): Promise<T> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [PG_BOSS_TEST_LOCK_KEY]);
    try {
      return await fn();
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [PG_BOSS_TEST_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}
