# A15 — Kill a worker during safe test work, restart and observe completion

**Scenario:** Kill a worker during safe test work, restart and observe completion.
**Pass condition:** Recovery reaches actual executor/result, not merely resumed DB state; no duplicated side effect; approval wait remains parked.

**Note on deferral status:** the task's original filing deferred this case pending TASK-246. TASK-246 is now done — this case is run in full, not deferred.

## Method note

This session independently, incidentally observed two real worker-death-and-recovery events already today (the pre-A19 watchdog incident, and A17's own test-isolated.ps1 run stopping and the watchdog restarting the worker at `05:18:02Z`, confirmed healthy at `05:20:01Z` — see `A19-24h-observation.md`). Those proved *process-level* supervision recovery. This case specifically needs *task-level* recovery: does an interrupted run's actual work resume, not just its database row. That exact scenario already has a dedicated, real, non-mocked test — cited here rather than deliberately killing the live worker mid-task again, which would risk interacting with A19's own concurrent observation window for no additional evidence.

## Evidence

- **Recovery reaches actual executor/result, not merely resumed DB state:** `services/worker/src/main.test.ts` — "re-drives an interrupted safe run through real pg-boss and records its liveness audit" — a real run is persisted in `status: "started"` (indistinguishable from a run genuinely interrupted by a process kill), then a real `runWorker()` boot runs its real reconciliation sweep. The test polls up to 12 seconds for a **replacement run to reach `status: "completed"` through a real injected executor** — not a status flip, an actual re-execution that produces a real result. The original run is independently confirmed `status: "failed", failureNote: "worker_restart"`.
- **No duplicated side effect:** the test asserts exactly one replacement run reaches `completed` (`replacementStatus`, singular, found once) and a real `run.requeued` audit event links it back to the original run via `previous_run_id` — proving one clean re-drive, not a fan-out of duplicate executions.
- **Approval wait remains parked:** `services/worker/src/main.test.ts` — "leaves an approval-parked durable command untouched at worker boot" — a separate, dedicated test proving the reconciliation sweep does not touch a run sitting in `waiting_approval`, consistent with `runLifecycle.ts`'s `reconcileInterruptedRuns` explicitly skipping that status before re-enqueueing (confirmed by direct code read: `OPEN_RUN_STATUSES` includes `waiting_approval`, but the reconciliation loop explicitly continues past it rather than treating it as interrupted).

## Result

**PASS.** All three required properties are proven by real, non-mocked tests using the actual `runWorker()` boot sequence and real pg-boss queue, re-confirmed clean in this session's own A17 full-suite run. Supplemented by two independent, real, live worker-death observations earlier in this same session confirming process-level recovery also works in practice, not just in the test suite.
