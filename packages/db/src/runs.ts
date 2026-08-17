import { Pool, type QueryResultRow } from "pg";

import { defaultPoolConfig, type DatabaseOptions } from "./database.js";

/**
 * WBS OIK-038 / Synthesis §5.1 — run lifecycle state machine.
 *
 * `runs.status` is a Postgres enum already defined in
 * `infra/postgres/migrations/001_schema_v1.up.sql`; this module maps to it
 * verbatim and must never introduce a value the enum doesn't have.
 */
export const runStatuses = [
  "started",
  "waiting_approval",
  "resumed",
  "completed",
  "failed",
  "cancelled",
] as const;

export type RunStatus = (typeof runStatuses)[number];

/**
 * Non-terminal statuses a run can still transition out of. `resume`,
 * `fail`, and `cancel` are only legal from one of these; `completed`,
 * `failed`, and `cancelled` are terminal and reject every further
 * transition attempted through this module.
 */
const OPEN_STATUSES: readonly RunStatus[] = [
  "started",
  "waiting_approval",
  "resumed",
];

export interface NewRun {
  taskId: string;
  provider: string;
  tenantId?: string;
  sessionRef?: string;
}

export interface Run {
  runId: string;
  taskId: string;
  tenantId: string;
  provider: string;
  sessionRef: string | null;
  status: RunStatus;
  startedAt: Date;
  endedAt: Date | null;
  failureNote: string | null;
}

interface RunRow extends QueryResultRow {
  run_id: string;
  task_id: string;
  tenant_id: string;
  provider: string;
  session_ref: string | null;
  status: RunStatus;
  started_at: Date;
  ended_at: Date | null;
  failure_note: string | null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const runColumns = `run_id, task_id, tenant_id, provider, session_ref, status,
       started_at, ended_at, failure_note`;

/** Thrown when a transition targets a run_id that has no row in `runs`. */
export class RunNotFoundError extends Error {
  public readonly runId: string;

  public constructor(runId: string) {
    super(`Run ${runId} was not found.`);
    this.name = "RunNotFoundError";
    this.runId = runId;
  }
}

/**
 * Thrown when a transition is attempted from a status that doesn't allow
 * it — e.g. resuming a run that already completed. `fromStatus` is the
 * run's actual status at the time of the (failed) attempt.
 */
export class IllegalRunTransitionError extends Error {
  public readonly runId: string;
  public readonly fromStatus: RunStatus;
  public readonly action: string;

  public constructor(runId: string, fromStatus: RunStatus, action: string) {
    super(
      `Run ${runId} cannot ${action} from status '${fromStatus}'.`,
    );
    this.name = "IllegalRunTransitionError";
    this.runId = runId;
    this.fromStatus = fromStatus;
    this.action = action;
  }
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${field} must not be empty.`);
  }
  return trimmed;
}

function requireUuid(value: string, field: string): string {
  const trimmed = requireNonEmpty(value, field);
  if (!UUID_RE.test(trimmed)) {
    throw new Error(`${field} must be a UUID.`);
  }
  return trimmed;
}

function toRun(row: RunRow): Run {
  return {
    runId: row.run_id,
    taskId: row.task_id,
    tenantId: row.tenant_id,
    provider: row.provider,
    sessionRef: row.session_ref,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    failureNote: row.failure_note,
  };
}

async function withPool<T>(
  options: DatabaseOptions,
  fn: (pool: Pool) => Promise<T>,
): Promise<T> {
  if (options.connectionString.trim().length === 0) {
    throw new Error("Database connectionString must not be empty.");
  }

  const pool = new Pool({
    connectionString: options.connectionString,
    ...defaultPoolConfig,
    ...options.poolConfig,
  });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

/**
 * Resolve why a transition matched zero rows: either the run doesn't
 * exist, or it exists but is no longer in an open status. Always throws.
 */
async function raiseTransitionFailure(
  pool: Pool,
  runId: string,
  action: string,
): Promise<never> {
  const current = await pool.query<Pick<RunRow, "status">>(
    `SELECT status FROM runs WHERE run_id = $1`,
    [runId],
  );
  const row = current.rows[0];
  if (row === undefined) {
    throw new RunNotFoundError(runId);
  }
  throw new IllegalRunTransitionError(runId, row.status, action);
}

/**
 * Start a new run. Status is always the table default (`started`).
 */
export async function startRun(
  options: DatabaseOptions,
  input: NewRun,
): Promise<Run> {
  const taskId = requireUuid(input.taskId, "taskId");
  const provider = requireNonEmpty(input.provider, "provider");
  const sessionRef =
    input.sessionRef === undefined
      ? null
      : requireNonEmpty(input.sessionRef, "sessionRef");

  return withPool(options, async (pool) => {
    const result = await pool.query<RunRow>(
      `INSERT INTO runs (task_id, tenant_id, provider, session_ref)
       VALUES ($1, COALESCE($2, 'basileia'), $3, $4)
       RETURNING ${runColumns}`,
      [taskId, input.tenantId ?? null, provider, sessionRef],
    );

    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("startRun did not return a persisted row.");
    }
    return toRun(row);
  });
}

export async function getRun(
  options: DatabaseOptions,
  runId: string,
): Promise<Run | null> {
  const normalizedRunId = requireUuid(runId, "runId");

  return withPool(options, async (pool) => {
    const result = await pool.query<RunRow>(
      `SELECT ${runColumns}
       FROM runs
       WHERE run_id = $1`,
      [normalizedRunId],
    );
    return result.rows[0] === undefined ? null : toRun(result.rows[0]);
  });
}

/**
 * Resume a run — after a killed process, a fresh worker re-reads the
 * persisted `session_ref` (via `getRun`) and hands it back here so the
 * harness can pick up the same session; when `sessionRef` is omitted the
 * previously stored value is preserved unchanged. Legal only from an open
 * status (`started`, `waiting_approval`, or `resumed` itself, so repeated
 * kill/resume cycles are idempotent); anything else throws
 * `IllegalRunTransitionError`, and an unknown run_id throws
 * `RunNotFoundError`.
 */
export async function resumeRun(
  options: DatabaseOptions,
  runId: string,
  sessionRef?: string,
): Promise<Run> {
  const normalizedRunId = requireUuid(runId, "runId");
  const normalizedSessionRef =
    sessionRef === undefined ? null : requireNonEmpty(sessionRef, "sessionRef");

  return withPool(options, async (pool) => {
    const result = await pool.query<RunRow>(
      `UPDATE runs
       SET status = 'resumed', session_ref = COALESCE($2, session_ref)
       WHERE run_id = $1
         AND status IN ('started', 'waiting_approval', 'resumed')
       RETURNING ${runColumns}`,
      [normalizedRunId, normalizedSessionRef],
    );

    const rowCount = result.rowCount ?? 0;
    if (rowCount === 1 && result.rows[0] !== undefined) {
      return toRun(result.rows[0]);
    }
    if (rowCount > 1) {
      throw new Error(
        `resumeRun matched ${rowCount} rows for run ${normalizedRunId}; expected 0 or 1.`,
      );
    }
    return raiseTransitionFailure(pool, normalizedRunId, "resume");
  });
}

/**
 * Fail a run. Legal only from an open status; terminal, sets `ended_at`
 * and `failure_note`.
 */
export async function failRun(
  options: DatabaseOptions,
  runId: string,
  failureNote: string,
): Promise<Run> {
  const normalizedRunId = requireUuid(runId, "runId");
  const normalizedFailureNote = requireNonEmpty(failureNote, "failureNote");

  return withPool(options, async (pool) => {
    const result = await pool.query<RunRow>(
      `UPDATE runs
       SET status = 'failed', ended_at = now(), failure_note = $2
       WHERE run_id = $1
         AND status IN ('started', 'waiting_approval', 'resumed')
       RETURNING ${runColumns}`,
      [normalizedRunId, normalizedFailureNote],
    );

    const rowCount = result.rowCount ?? 0;
    if (rowCount === 1 && result.rows[0] !== undefined) {
      return toRun(result.rows[0]);
    }
    if (rowCount > 1) {
      throw new Error(
        `failRun matched ${rowCount} rows for run ${normalizedRunId}; expected 0 or 1.`,
      );
    }
    return raiseTransitionFailure(pool, normalizedRunId, "fail");
  });
}

/**
 * Cancel a run. Legal only from an open status; terminal, sets `ended_at`.
 */
export async function cancelRun(
  options: DatabaseOptions,
  runId: string,
): Promise<Run> {
  const normalizedRunId = requireUuid(runId, "runId");

  return withPool(options, async (pool) => {
    const result = await pool.query<RunRow>(
      `UPDATE runs
       SET status = 'cancelled', ended_at = now()
       WHERE run_id = $1
         AND status IN ('started', 'waiting_approval', 'resumed')
       RETURNING ${runColumns}`,
      [normalizedRunId],
    );

    const rowCount = result.rowCount ?? 0;
    if (rowCount === 1 && result.rows[0] !== undefined) {
      return toRun(result.rows[0]);
    }
    if (rowCount > 1) {
      throw new Error(
        `cancelRun matched ${rowCount} rows for run ${normalizedRunId}; expected 0 or 1.`,
      );
    }
    return raiseTransitionFailure(pool, normalizedRunId, "cancel");
  });
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("@oikonomos/db runs — input validation (no DB required)", () => {
    const options: DatabaseOptions = { connectionString: "   " };

    it("rejects an empty connection string before opening a pool", async () => {
      await expect(
        startRun(options, { taskId: "11111111-1111-1111-1111-111111111111", provider: "test" }),
      ).rejects.toThrow(/connectionString/);
      await expect(
        getRun(options, "11111111-1111-1111-1111-111111111111"),
      ).rejects.toThrow(/connectionString/);
      await expect(
        resumeRun({ connectionString: "postgres://x" }, "not-a-uuid"),
      ).rejects.toThrow(/UUID/);
      await expect(
        failRun({ connectionString: "postgres://x" }, "not-a-uuid", "boom"),
      ).rejects.toThrow(/UUID/);
      await expect(
        cancelRun({ connectionString: "postgres://x" }, "not-a-uuid"),
      ).rejects.toThrow(/UUID/);
    });

    it("rejects an empty provider on startRun", async () => {
      await expect(
        startRun(
          { connectionString: "postgres://x" },
          { taskId: "11111111-1111-1111-1111-111111111111", provider: "   " },
        ),
      ).rejects.toThrow(/provider/);
    });

    it("rejects an empty failureNote on failRun", async () => {
      await expect(
        failRun(
          { connectionString: "postgres://x" },
          "11111111-1111-1111-1111-111111111111",
          "   ",
        ),
      ).rejects.toThrow(/failureNote/);
    });
  });

  describe("RunNotFoundError / IllegalRunTransitionError", () => {
    it("carries structured fields, not just a message", () => {
      const notFound = new RunNotFoundError("11111111-1111-1111-1111-111111111111");
      expect(notFound.name).toBe("RunNotFoundError");
      expect(notFound.runId).toBe("11111111-1111-1111-1111-111111111111");

      const illegal = new IllegalRunTransitionError(
        "11111111-1111-1111-1111-111111111111",
        "completed",
        "resume",
      );
      expect(illegal.name).toBe("IllegalRunTransitionError");
      expect(illegal.fromStatus).toBe("completed");
      expect(illegal.action).toBe("resume");
      expect(illegal.message).toMatch(/cannot resume from status 'completed'/);
    });
  });
}
