import { invalidatePendingApproval } from "@oikonomos/approvals";
import { recordAuditEvent } from "@oikonomos/audit";
import {
  cancelRun,
  completeRun,
  listPendingApprovals,
  failRun,
  getRun,
  listRuns,
  parkRun,
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
  const run = await failRun(options, runId, failureNote);
  await resolveDanglingApprovals(options, run);
  return run;
}

/** Audit event recorded when a run's own end voids an approval nobody answered. */
export const APPROVAL_ABANDONED_EVENT_TYPE = "approval.abandoned_at_run_end";

/**
 * Void any approval this run left still awaiting an answer (TASK-218).
 *
 * Reported by a user 2026-09-07 and confirmed in the database: a sandboxed
 * run requested an approval at 10:52:52, COMPLETED at 10:57:27, and the
 * approval was granted at 10:59:57 — two and a half minutes after there was
 * anything left to resume. The card stayed actionable in the mobile client,
 * the operator answered it, and nothing happened. Three such approvals were
 * sitting against already-finished runs.
 *
 * Cause (not fixed here): `createRunParkPort` is wired only into the local
 * execution branch, so a sandboxed run never parks on `approval_pending` and
 * simply finishes without the tool.
 *
 * SCOPE, and it is narrow on purpose: this runs only for `failed` and
 * `cancelled` runs — the states nothing can resume, where a pending approval
 * is unambiguously dead. It deliberately does NOT run on completion. A
 * completed run holding a pending approval might be the reported dead end, or
 * might be a run awaiting the answer that TASK-155 would resume it with, and
 * those are indistinguishable here. Deciding between them is the
 * park-vs-rerun product fork the user has not ruled on, so it is left
 * undecided rather than settled by implication.
 *
 * `invalidated` is used rather than `rejected` precisely because the audit
 * trail must never suggest the operator turned something down: nobody
 * decided this, the run ended underneath it.
 *
 * Never throws. A run that has genuinely finished must not be reported as
 * failed because its tidy-up could not complete.
 */
export async function resolveDanglingApprovals(
  options: DatabaseOptions,
  run: Run,
): Promise<number> {
  try {
    const pending = await listPendingApprovals(options, { runId: run.runId, includeExpired: true });
    let resolved = 0;
    for (const approval of pending) {
      const result = await invalidatePendingApproval(approval.nonce, { database: options });
      if (!result.invalidated) continue;
      resolved += 1;
      await recordAuditEvent(options, {
        tenantId: approval.tenantId,
        runId: run.runId,
        actor: "system:run-lifecycle",
        eventType: APPROVAL_ABANDONED_EVENT_TYPE,
        payload: {
          approvalId: approval.approvalId,
          capabilityId: approval.capabilityId,
          runStatus: run.status,
        },
      });
    }
    return resolved;
  } catch {
    return 0;
  }
}

/**
 * Park a run awaiting a human approval decision (TASK-136). The thin wrapper
 * a real `RunParkPort` implementation calls into from `chatRunDriver.ts`,
 * mirroring `completeTaskRun`/`failTaskRun`'s shape exactly.
 */
export async function parkTaskRun(
  options: DatabaseOptions,
  runId: string,
): Promise<Run> {
  return parkRun(options, runId);
}

/**
 * Deliberately does NOT resolve pending approvals (TASK-218).
 *
 * A completed run holding a pending approval is the ambiguous case: it may be
 * a run that finished without the tool (the user-reported dead end), or a run
 * parked at `waiting_approval` that the operator is still expected to answer
 * so TASK-155 can resume it. Those are indistinguishable at this point, and
 * choosing between them IS the park-vs-rerun product decision this task
 * explicitly left to the user. Voiding here would decide it by implication —
 * and would break the working approval flow, which is how the existing
 * TASK-136 test caught this.
 */
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
  const run = await cancelRun(options, runId);
  await resolveDanglingApprovals(options, run);
  return run;
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
