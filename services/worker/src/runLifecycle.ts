import {
  cancelRun,
  completeRun,
  failRun,
  getRun,
  listRuns,
  resumeRun,
  startRun,
  type DatabaseOptions,
  type NewRun,
  type Run,
  type RunStatus,
} from "@oikonomos/db";

/**
 * WBS OIK-038 — the worker's run-lifecycle integration point.
 *
 * All persistence goes through `@oikonomos/db`'s typed `runs` module via
 * the package barrel; there is no raw SQL here (N-rule). The pg-boss job
 * queue wiring itself (OIK-105) is a later ticket — these functions are
 * the seam a future job handler calls into to drive start/resume/fail/
 * cancel for the run it owns.
 */

export async function startTaskRun(
  options: DatabaseOptions,
  input: NewRun,
): Promise<Run> {
  return startRun(options, input);
}

/**
 * Resume a run after the worker process that was executing it was
 * killed. Reads the persisted `session_ref` back from the database and
 * hands it straight to `resumeRun`, so the harness picks up the same
 * session — the concrete mechanism behind AC1 ("resume after a killed
 * process returns to the correct state").
 *
 * Throws if the run does not exist, or if it is not in an open status
 * (`resumeRun` surfaces `RunNotFoundError` / `IllegalRunTransitionError`
 * from `@oikonomos/db` unchanged).
 */
export async function resumeInterruptedRun(
  options: DatabaseOptions,
  runId: string,
): Promise<Run> {
  const existing = await getRun(options, runId);
  if (existing === null) {
    throw new Error(`Cannot resume unknown run ${runId}.`);
  }
  return resumeRun(options, runId, existing.sessionRef ?? undefined);
}

export async function failTaskRun(
  options: DatabaseOptions,
  runId: string,
  failureNote: string,
): Promise<Run> {
  return failRun(options, runId, failureNote);
}

export async function completeTaskRun(
  options: DatabaseOptions,
  runId: string,
): Promise<Run> {
  return completeRun(options, runId);
}

export async function cancelTaskRun(
  options: DatabaseOptions,
  runId: string,
): Promise<Run> {
  return cancelRun(options, runId);
}

/**
 * Statuses a run can still be sitting in when a worker process dies mid-run
 * — mirrors `packages/db/src/runs.ts`'s private `OPEN_STATUSES`. That list
 * is not yet re-exported from `@oikonomos/db`'s package barrel
 * (`packages/db/src/index.ts` sits outside this task's `Owned_Paths`, so it
 * cannot be edited here — see the TASK-133 dossier), so this is a
 * deliberate, narrow duplication of the same three literal values rather
 * than an ownership violation. If `packages/db`'s barrel export is ever
 * added, this array should be replaced with the imported one.
 */
const OPEN_RUN_STATUSES: readonly RunStatus[] = [
  "started",
  "waiting_approval",
  "resumed",
];

export interface ReconcileOutcome {
  runId: string;
  outcome: "resumed" | "resume_failed";
  /** Present only when `outcome` is `"resume_failed"`. */
  error?: string;
}

/**
 * Boot-time reconciliation (OIK-106): find every run left in an open,
 * non-terminal status with no live process still executing it — the
 * fingerprint of a run orphaned by a prior worker process's death — and
 * resume each one via `resumeInterruptedRun`.
 *
 * Deliberately callable on its own (AC3): a real worker-process entrypoint
 * calls this once at startup, but nothing here depends on process boot, so
 * it is fully testable in isolation against a real database.
 *
 * A run whose resume fails (e.g. a concurrent transition already moved it
 * to a terminal status between the scan and the resume attempt) is recorded
 * as `resume_failed` rather than thrown — one orphaned run's failure must
 * not stop reconciliation of the rest. Completed/failed/cancelled runs are
 * never touched: they are never fetched in the first place, since the scan
 * itself is scoped to `OPEN_RUN_STATUSES`.
 *
 * Scope note (explicit, not silently ignored): this does not coordinate
 * across multiple concurrent worker-process instances — two worker
 * processes racing to reconcile at the same time could both attempt to
 * resume the same run. `resumeRun`'s underlying `UPDATE ... WHERE status IN
 * (...)` is still atomic per-row (only one of the two racing calls can
 * actually flip the row), so a race cannot corrupt state, but nothing here
 * prevents the redundant attempt. Multi-instance coordination is out of
 * this task's scope (single-worker-instance deployment only).
 *
 * `filter.tenantId`/`filter.taskId` narrow the scan the same way they
 * narrow `listRuns` itself — real worker boot always calls this
 * unfiltered (a boot-time scan legitimately means "every open run in the
 * database"), while tests scope it to their own fixture's `taskId` so they
 * never touch another test's unrelated runs.
 */
export async function reconcileInterruptedRuns(
  options: DatabaseOptions,
  filter: { tenantId?: string; taskId?: string } = {},
): Promise<ReconcileOutcome[]> {
  const orphaned: Run[] = [];
  for (const status of OPEN_RUN_STATUSES) {
    let cursor: string | undefined;
    do {
      const page = await listRuns(options, { ...filter, status, limit: 200, cursor });
      orphaned.push(...page.runs);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
  }

  const outcomes: ReconcileOutcome[] = [];
  for (const run of orphaned) {
    try {
      await resumeInterruptedRun(options, run.runId);
      outcomes.push({ runId: run.runId, outcome: "resumed" });
    } catch (error) {
      outcomes.push({
        runId: run.runId,
        outcome: "resume_failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcomes;
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("@oikonomos/worker runLifecycle — input validation (no DB required)", () => {
    it("resumeInterruptedRun propagates the connectionString guard from getRun", async () => {
      await expect(
        resumeInterruptedRun({ connectionString: "   " }, "11111111-1111-1111-1111-111111111111"),
      ).rejects.toThrow(/connectionString/);
    });

    it("startTaskRun/completeTaskRun/failTaskRun/cancelTaskRun propagate the connectionString guard", async () => {
      const options = { connectionString: "   " };
      await expect(
        startTaskRun(options, { taskId: "11111111-1111-1111-1111-111111111111", provider: "test" }),
      ).rejects.toThrow(/connectionString/);
      await expect(
        completeTaskRun(options, "11111111-1111-1111-1111-111111111111"),
      ).rejects.toThrow(/connectionString/);
      await expect(
        failTaskRun(options, "11111111-1111-1111-1111-111111111111", "boom"),
      ).rejects.toThrow(/connectionString/);
      await expect(
        cancelTaskRun(options, "11111111-1111-1111-1111-111111111111"),
      ).rejects.toThrow(/connectionString/);
    });

    it("reconcileInterruptedRuns propagates the connectionString guard", async () => {
      await expect(
        reconcileInterruptedRuns({ connectionString: "   " }),
      ).rejects.toThrow(/connectionString/);
    });
  });
}
