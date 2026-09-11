import { withPool, type DatabaseOptions } from "./database.js";

/**
 * TASK-230 — per-phase latency instrumentation. Nothing previously
 * recorded how long a real chat run took broken down by phase; only the
 * coarse `runs.started_at`/`ended_at` existed. See
 * `infra/postgres/migrations/022_run_phase_timings.up.sql`.
 */
export interface RunPhaseTiming {
  runId: string;
  phase: string;
  durationMs: number;
}

export async function recordRunPhaseTiming(
  options: DatabaseOptions,
  timing: RunPhaseTiming,
): Promise<void> {
  await withPool(options, async (pool) => {
    await pool.query(
      `INSERT INTO run_phase_timings (run_id, phase, duration_ms) VALUES ($1, $2, $3)`,
      [timing.runId, timing.phase, timing.durationMs],
    );
  });
}

export interface PhaseLatencyStats {
  phase: string;
  count: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

/**
 * Aggregate latency stats per phase over the most recent [limit] runs'
 * worth of recorded timings (default 500). Uses Postgres's own
 * `percentile_cont` rather than pulling raw rows and computing
 * percentiles in JS — correct under concurrent writes and cheap at any
 * realistic row count.
 */
export async function queryRunLatencyStats(
  options: DatabaseOptions,
  input: { limit?: number } = {},
): Promise<PhaseLatencyStats[]> {
  const limit = input.limit ?? 500;
  return withPool(options, async (pool) => {
    const result = await pool.query<{
      phase: string;
      count: string;
      p50_ms: string;
      p95_ms: string;
      max_ms: string;
    }>(
      `WITH recent_runs AS (
         SELECT run_id FROM runs ORDER BY started_at DESC LIMIT $1
       )
       SELECT
         phase,
         count(*) AS count,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50_ms,
         percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms,
         max(duration_ms) AS max_ms
       FROM run_phase_timings
       WHERE run_id IN (SELECT run_id FROM recent_runs)
       GROUP BY phase
       ORDER BY p95_ms DESC`,
      [limit],
    );
    return result.rows.map((row) => ({
      phase: row.phase,
      count: Number.parseInt(row.count, 10),
      p50Ms: Number.parseFloat(row.p50_ms),
      p95Ms: Number.parseFloat(row.p95_ms),
      maxMs: Number.parseFloat(row.max_ms),
    }));
  });
}
