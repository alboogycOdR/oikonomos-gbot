# TASK-330 dossier

**Brief:** Routine sweep liveness: prove the routine poller is alive

**Assigned:** CX9. **Depends on:** TASK-329.

**Source:** OpenBot (CopilotKit, MIT) comparison of 2026-09-21, five read-only passes; borrow the idea, never the code.

**Approach:** read the Description and Acceptance_Criteria in PLAN.md, then our own code; verify every REPORTED claim before changing anything.

## Work Log

- [2026-09-24T16:39:00Z] [CX9] Preflight completed: all five owned paths exist (routineJob.ts, routineJob.test.ts, auditEvents.ts, auditEvents.test.ts, index.ts). Read ADR-005 and live poller/audit implementations; implementing tenant-scoped persisted sweep liveness.
- [2026-09-24T16:43:00Z] [CX9] Preflight output: `services/worker/src/jobs/routineJob.ts` FILE (261 lines); `services/worker/src/jobs/routineJob.test.ts` FILE (320 lines); `packages/db/src/auditEvents.ts` FILE (265 lines); `packages/db/src/auditEvents.test.ts` FILE (34 lines); `packages/db/src/index.ts` FILE (359 lines). All owned paths existed before edits.
- [2026-09-24T16:45:00Z] [CX9] Implemented one durable, tenant-scoped `routine.sweep` audit event after each successful poll. Its payload is exactly due/fired/missed/failed counts. Added `getLatestAuditEvent` and `routineSweepIsStale`, plus liveness coverage that is stale before a poll, healthy after, and stale again after 15 minutes.
- [2026-09-24T16:48:00Z] [CX9] Verification: `pnpm --filter @oikonomos/db build` and `pnpm --filter @oikonomos/worker exec tsc --noEmit` passed. Isolated DB suite initially had 296 passed, 2 skipped, 1 unrelated `src/roles.test.ts` migration-backfill deadlock; TASK-330 audit tests passed. `scripts/test-isolated.ps1 -Filter @oikonomos/worker` passed (including routineJob 8/8 and TASK-330 liveness). Full `scripts/test-isolated.ps1` passed. `git diff --check` passed.
