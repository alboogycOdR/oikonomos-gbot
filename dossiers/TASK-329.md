# TASK-329 dossier

**Brief:** Routine fatigue rule: tell the owner on first failure, pause after ten

**Assigned:** CX9. **Depends on:** TASK-328.

**Source:** OpenBot (CopilotKit, MIT) comparison of 2026-09-21, five read-only passes; borrow the idea, never the code.

**Approach:** read the Description and Acceptance_Criteria in PLAN.md, then our own code; verify every REPORTED claim before changing anything.

## Work Log

- [2026-09-24T16:03:00Z] [CX9] Preflight completed: all five owned paths exist (packages/db/src/routines.ts 415 lines, routines.test.ts 228 lines, index.ts 357 lines; services/worker/src/jobs/routineJob.ts 205 lines, routineJob.test.ts 259 lines). Read the live routine persistence and worker message path before implementation.
- [2026-09-24T16:15:00Z] [CX9] Implemented `listRecentRoutineOutcomes` (bounded newest-first history) and fatigue handling via the existing role thread + `insertMessage` system-message path. `stopped` records count as failures; `missed` and intentional `changes_only:` skips do not count or reset; `queued` resets. Added a liveness assertion on the persisted tenth-failure pause.
- [2026-09-24T16:29:00Z] [CX9] Committed 610ac02 (`feat(routines): pause repeated failures [TASK-329]`). Verification: `pnpm --filter @oikonomos/db build` and `pnpm --filter @oikonomos/worker exec tsc --noEmit` passed. `powershell -ExecutionPolicy Bypass -File scripts\\test-isolated.ps1 -Filter @oikonomos/db`: 45 files/295 tests passed, 2 skipped; only failure was master-baseline/out-of-territory `packages/db/src/projects.ts:1588` cleanup deleting threads before `thread_members` (`thread_members_thread_id_fkey`). `powershell -ExecutionPolicy Bypass -File scripts\\test-isolated.ps1 -Filter @oikonomos/worker`: TASK-329 test passed; one unrelated intermittent existing pg-boss race in `routineJob.test.ts` TASK-247 (`Queue worker.run-execution does not exist`) failed while a concurrent queue purge ran. Full `scripts\\test-isolated.ps1` was run and stopped at the same `packages/db/src/projects.ts:1588` baseline cleanup failure. `git diff --check` passed.
- [2026-09-24T16:26:19Z] [CX9] Rework F1/F2 fixed in f3ec6e5: all routine-job cases that enqueue or purge the shared pg-boss queue now use `withPgBossQueueLock` and a 20s Vitest timeout; tenant-scoped messages are deleted before their runs and role threads. `git diff --check` and `pnpm --filter @oikonomos/worker exec tsc --noEmit` pass. Worker harness attempts were launched with `-Init` only on the first pass, but this session's runner detached their child Vitest processes before returning final summaries; required three foreground summaries still need collection.
