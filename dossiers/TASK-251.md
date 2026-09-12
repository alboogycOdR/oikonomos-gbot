# TASK-251 — Two worker tests race the database on a cold isolated database — finalize phase-timing row (deterministic) and pg-boss routine lifecycle (flaky)

**Unit:** TBD · **Priority:** low · **Depends_On:** TASK-244, TASK-246

## Brief
Observed 2026-09-12 in three consecutive `scripts/test-isolated.ps1 -Filter @oikonomos/worker` runs against a freshly created `oikonomos_test` (live worker stopped, watchdog disabled). (1) `createChatRunDriver — Claude SDK spend + budget gate (TASK-163) > records real per-phase timing rows` failed identically all three times: `['model_execution','setup']` without `'finalize'` — `recordTimingSafe(runId, "finalize", ...)` at `chatRunDriver.ts:461` is fire-and-forget and the assertion at `:1613` reads `run_phase_timings` as soon as `.run()` resolves; on the warm production pool it usually wins the race, on a cold database it loses. Fix by awaiting the finalize write before `run()` resolves (it is the run's last write) or by exposing a settled-timings promise the test awaits; do not widen the assertion. (2) `WorkerJobQueue — pg-boss lifecycle against PostgreSQL` failed in two different tests across the runs (`lastFireStatus` `missed` instead of `queued` when `nextFireAt` landed exactly on a minute boundary; another run failed the sibling `runs a scheduled` test) — wall-clock minute alignment. Fix with an injected clock or a boundary-safe schedule. `chatRunDriver.ts` is owned by TASK-244 then TASK-246; sequence after both.

## Spec pointers
TASK-230 (phase timings); TASK-221/229 (pg-boss routine poll); TASK-162/199 (prior flake work); docs/runbooks/release-workspace-1.md Isolated tests

## Owned_Paths
services/worker/src/chatRunDriver.ts, services/worker/src/chatRunDriver.test.ts, services/worker/src/jobs/workerJobQueue.test.ts, services/worker/src/jobs/workerJobQueue.ts

## Work Log
