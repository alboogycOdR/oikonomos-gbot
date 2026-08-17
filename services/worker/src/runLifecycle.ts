import {
  cancelRun,
  failRun,
  getRun,
  resumeRun,
  startRun,
  type DatabaseOptions,
  type NewRun,
  type Run,
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

export async function cancelTaskRun(
  options: DatabaseOptions,
  runId: string,
): Promise<Run> {
  return cancelRun(options, runId);
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("@oikonomos/worker runLifecycle — input validation (no DB required)", () => {
    it("resumeInterruptedRun propagates the connectionString guard from getRun", async () => {
      await expect(
        resumeInterruptedRun({ connectionString: "   " }, "11111111-1111-1111-1111-111111111111"),
      ).rejects.toThrow(/connectionString/);
    });

    it("startTaskRun/failTaskRun/cancelTaskRun propagate the connectionString guard", async () => {
      const options = { connectionString: "   " };
      await expect(
        startTaskRun(options, { taskId: "11111111-1111-1111-1111-111111111111", provider: "test" }),
      ).rejects.toThrow(/connectionString/);
      await expect(
        failTaskRun(options, "11111111-1111-1111-1111-111111111111", "boom"),
      ).rejects.toThrow(/connectionString/);
      await expect(
        cancelTaskRun(options, "11111111-1111-1111-1111-111111111111"),
      ).rejects.toThrow(/connectionString/);
    });
  });
}
