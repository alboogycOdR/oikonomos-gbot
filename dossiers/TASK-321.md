# TASK-321 — Durable manager project fan-out cap

## Work Log

- [2026-09-21T10:58:00Z] [CX9] Preflight completed from the main coordination checkout (the task worktree's historical PLAN.md predates TASK-321):
  ```text
  [preflight] TASK-321 Owned_Paths inspected in E:/DELL-PROJECTS/GROKBOT-CLONE
  [preflight] 9 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    FILE   services/worker/src/projectTools.ts  -> exists, 103 line(s), 9854 bytes
    FILE   services/worker/src/projectTools.test.ts  -> exists, 60 line(s), 5500 bytes
    FILE   services/worker/src/projectMcpServer.ts  -> exists, 44 line(s), 5015 bytes
    FILE   services/worker/src/projectMcpServer.test.ts  -> exists, 11 line(s), 758 bytes
    NEW    services/worker/src/projectFanout.ts  -> does not exist; parent services/worker/src/ exists
    NEW    services/worker/src/projectFanout.test.ts  -> does not exist; parent services/worker/src/ exists
    FILE   packages/db/src/auditEvents.ts  -> exists, 184 line(s), 5703 bytes
    NEW    packages/db/src/auditEvents.test.ts  -> does not exist; parent packages/db/src/ exists
    FILE   packages/db/src/index.ts  -> exists, 343 line(s), 7883 bytes
  ```
  Verified spec §6.4 and the live defect: `handleProjectMcpRequest` constructs fresh tools per call while `projectTools.ts` retains its cap only in a closure. No migration is needed: `audit_events` already persists `run_id` and event type; the repair will use a transaction-scoped advisory lock plus a durable admission audit insert.

- [2026-09-21T11:18:00Z] [CX9] Replaced the closure-local counter with `admitProjectFanout`: it obtains `pg_advisory_xact_lock(hashtextextended(runId, 0))`, counts durable `project.task_assigned` events for that run, and transactionally inserts either the assignment record or `project.fanout_capped`. The project tool uses this shared DB admission path in both lanes. Added direct concurrent DB liveness coverage and live MCP sequential/parallel fresh-instance coverage. `pnpm --filter @oikonomos/db build`, DB/worker typechecks pass. Isolated DB suite: new `auditEvents.test.ts` passes; suite has one pre-existing `projects.ts` teardown FK-order failure. Isolated worker suite: TASK-321 MCP and project fanout tests pass; unrelated pre-existing failures are budget platform-cap / email grant drift and timing-sensitive routine/role-message tests.

- [2026-09-21T11:20:00Z] [CX9] Stopping checkpoint: commit `2b68060` contains all TASK-321 changes and targeted verification. Next step is the required isolated recursive suite (`scripts/test-isolated.ps1`) plus a master-baseline run to classify any failures before requesting review.

- [2026-09-21T06:26:35Z] [CX9] Required full-suite comparison completed. On this branch, `powershell -ExecutionPolicy Bypass -File scripts\test-isolated.ps1` ran all 19 scoped projects: the new DB audit-event test passed (1/1), worker `projectMcpServer.test.ts` passed (2/2), and `projectFanout.test.ts` passed (2/2). The recursive command exits 1 only for pre-existing infrastructure/unrelated failures: DB TASK-276 thread-members cleanup FK ordering; evals TASK-141 platform budget; worker platform-budget/capability-drift, pg-boss timing, and sandbox-release failures; control-api TASK-121 three-bot routing. The identical isolated command on `E:\DELL-PROJECTS\GROKBOT-CLONE` baseline also exits 1 with the same DB, eval, worker, and control-api classes (and additionally lacks this branch's audit TRUNCATE guard, so its audit append-only suite fails). No TASK-321 regression was observed. `git diff --check` passes. Handoff is ready on commits `2b68060` (implementation) and the following dossier evidence commit.

- [2026-09-21T12:00:00Z] [CX9] Rebased TASK-321 onto current master (`39e1e1d`), integrating TASK-303. The advisory-locked admission now invokes the owner mutation before appending `project.task_assigned`, preserving TASK-303's audit-after-mutation ordering while keeping the lock through the count, mutation, and audit insert. `project.fanout_capped` remains a transactionally persisted refusal; its payload and the admitted payload contain only UUID identifiers and roster size, confirming Review Finding R2's redaction condition.

- [2026-09-21T13:40:00Z] [CX9] Post-integration verification: `pnpm --filter @oikonomos/db build` and `pnpm --filter @oikonomos/worker exec tsc --noEmit` pass. Fresh isolated initialization (`scripts/test-isolated.ps1 -Init`) completed. The isolated worker suite confirms `projectTools.test.ts` 4/4, `projectMcpServer.test.ts` 2/2 (the live fresh-MCP sequential/parallel, refusal-audit, per-run/per-manager coverage), and `projectFanout.test.ts` 2/2 pass. The isolated DB suite confirms `auditEvents.test.ts` 1/1; its overall result is 45 files / 289 tests passed, with only the known unrelated TASK-276 `projects.ts` cleanup FK-order failure. A full recursive isolated run was also launched against the fresh database; its dashboard package passed 25 files / 158 tests before the terminal relay detached. The targeted DB/worker classifications match the prior master-baseline classes: platform-budget/capability drift and the TASK-276 cleanup failure, with no TASK-321 regression observed.
