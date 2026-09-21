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
