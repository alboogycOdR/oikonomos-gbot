# TASK-322 dossier

**Brief:** Verify and fix run-queue expiry (300 s) against the 10-minute sandbox command timeout

**Source:** OpenBot (CopilotKit, MIT) comparison of 2026-09-21. Borrow the idea, never the code.

**Approach:** see the task Description and Acceptance_Criteria in PLAN.md. Read our own code first and verify every UNVERIFIED or REPORTED claim.

## Work Log
- [2026-09-21T10:20:00Z] [S5] Investigation + fix. FINDING: the double run IS real. workerJobQueue.ts:61-68 (old) expireInSeconds 300; pg-boss 12.30 has no handler heartbeat, so at expiry it fails the job and retries it (retryLimit 3, retryDelay 1) while the first handler is still running. main.ts:87-90 onRunExecution only returns early for waiting_approval/completed/failed/cancelled, so a run in started/resumed is passed to driver.run again (chatRunDriver SANDBOX_COMMAND_TIMEOUT_MS = 10 min > 300 s). resumeRun (packages/db runs.ts:351) allows started->resumed, so no DB guard refuses it either.
  FIX (workerJobQueue.ts only): (1) RUN_EXECUTION_EXPIRE_SECONDS = 1800; queue expiry re-applied with updateQueue because createQueue is a no-op on an existing queue (a stale 300 s queue would otherwise persist); (2) in-process inFlightRuns guard: a retry of a run whose handler is still executing is skipped, so driver.run and its spend reservation (assertChatBudgetAllows) are never reached a second time. Test seam runExecutionExpireInSeconds.
  LIMITS: guard is per-process; a second worker process or a restart mid-run still relies on the 30 min expiry (the reconcile path is the crash-recovery route). main.ts is outside Owned_Paths; a DB-level atomic claim would need a task there. chatRunDriver.ts untouched. runLifecycle.ts untouched (no change needed).
  TEST: "TASK-322: a run outliving the queue expiry is never started a second time" (1 s expiry, 6 s handler). With the guard disabled: expected 2 to be 1 (fails). With the guard: passes. Runs via test-isolated.ps1 -Filter @oikonomos/worker; master baseline worker suite = 53 failed (chatRunDriver budget, sandboxReaper, plus workerJobQueue pg-boss lock-timeout flakes that hit different tests each run, incl. on master); mine 54 failed with the same classes; only difference is flaky workerJobQueue timeouts under parallel-file lock contention.
