# TASK-301 -- Wire atomic admission into both chat lanes and the subprocess path; attribute spend to project and role (P-3b)

## Brief
PROTECTED PATH (packages/broker/**): adversarial review by a model different from the author is mandatory. Assigned to CX9, priority high. Depends on: TASK-300, TASK-299.

## Spec pointers
specs/OIKONOMOS_PROJECT_WORKSPACE_v1.0.md §6.1 (every run started from a project thread or a task.assigned handoff is attributed to the project), §6.2 (deny before spawn; release on failure), §6.3 (manager budget covers only its own turns), §11; docs/decisions/ADR-019-project-entity-and-manager-role.md §5.

## Owned paths
packages/broker/src/budgetGate.ts, packages/broker/src/budgetGate.test.ts, services/worker/src/chatRunDriver.ts, services/worker/src/chatRunDriver.test.ts, services/worker/src/subprocessProviders.ts, services/worker/src/roleMessageDelivery.ts

## Intended approach
Admission belongs next to assertChatBudgetAllows so ordering is obvious: pure gate first, reservation second, spawn third.

## Acceptance criteria
- No provider is invoked when either axis would be exceeded: two simultaneous near-limit runs on the same project produce at most one provider invocation, the other denied budget.project_exceeded before spawn -- proven through the real run path with a counting fake provider. (spec §11)
- Same proof on the role axis with budget.role_exceeded. (spec §11)
- A run from a project thread, and a run delivered from a task.assigned handoff, both write spend_records.project_id; a manager's own turns are charged to the manager role, a specialist's to the specialist and the project, never to the manager. (spec §6.1, §6.3)
- A run that fails before spend releases its reservation exactly once. (spec §6.2)
- Platform, provider and routine gate behaviour unchanged; existing budget tests pass unmodified. (spec §6.2)
- Adversarial review by a different model than the author recorded in REVIEW.md.
- Full recursive suite via scripts/test-isolated.ps1 only.

## Work Log

- [2026-09-19T15:30:00Z] [CX9] Resumed on `task/TASK-301-cx9`, fast-forwarded it from the dependency-block checkpoint to integration head `73b145b`, and repeated the required territory preflight:
  ```text
  [preflight] TASK-301 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex9-GROKBOT-CLONE
  [preflight] 6 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    FILE   packages/broker/src/budgetGate.ts  -> exists, 400 line(s), 17124 bytes
    NEW    packages/broker/src/budgetGate.test.ts  -> does not exist; parent packages/broker/src/ exists
    FILE   services/worker/src/chatRunDriver.ts  -> exists, 2134 line(s), 109854 bytes
    FILE   services/worker/src/chatRunDriver.test.ts  -> exists, 2566 line(s), 159196 bytes
    FILE   services/worker/src/subprocessProviders.ts  -> exists, 254 line(s), 11673 bytes
    FILE   services/worker/src/roleMessageDelivery.ts  -> exists, 553 line(s), 27706 bytes
  ```

- [2026-09-19T09:52:00Z] [CX9] Preflight completed before implementation:
  ```text
  [preflight] TASK-301 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex9-GROKBOT-CLONE
  [preflight] 6 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    FILE   packages/broker/src/budgetGate.ts  -> exists, 400 line(s), 17124 bytes
    NEW    packages/broker/src/budgetGate.test.ts  -> does not exist; parent packages/broker/src/ exists
    FILE   services/worker/src/chatRunDriver.ts  -> exists, 2085 line(s), 107125 bytes
    FILE   services/worker/src/chatRunDriver.test.ts  -> exists, 2474 line(s), 152744 bytes
    FILE   services/worker/src/subprocessProviders.ts  -> exists, 254 line(s), 11673 bytes
    FILE   services/worker/src/roleMessageDelivery.ts  -> exists, 553 line(s), 27706 bytes
  ```
- [2026-09-19T09:52:00Z] [CX9] Blocked before code changes: live PLAN.md lists TASK-315 as `pending`, while TASK-301 depends on it. The current merged `packages/db/src/spendReservations.ts` still derives role spend from `spend_records.routine_id = roleId`; real chat spend uses the routine id (or null), so wiring the role reservation axis now would leave `budget.role_exceeded` inert. Resume after TASK-315 is reviewed and merged, then rebase/refresh this branch from the integration head and implement the reservation/admission wiring.
- [2026-09-19T18:10:00Z] [CX9] Resumed on `task/TASK-301-cx9` after merging the live integration head. Implemented the first wiring slice: chat lanes now run the existing pure gate, then atomically admit a project/role reservation before provider execution; spend writes receive a resolved project id; failed, admitted runs release once through the existing unrecorded-spend failure callback. Project-thread attribution uses `getProjectByThreadId`; task.assigned delivery writes a project locator only after verifying sender-manager and recipient-roster membership. `pnpm --filter @oikonomos/broker run build` and `pnpm --filter @oikonomos/worker run build` pass. `scripts/test-isolated.ps1 -Root . -Filter @oikonomos/worker` passed (existing expected sandbox-reaper stderr only). Remaining before review: add real-driver project/role concurrency, failure-release, and forged-handoff tests; complete the task-specific Codex/Grok admission/fail-closed behavior in `subprocessProviders.ts` and its allowed test territory.
- [2026-09-19T15:38:00Z] [CX9] Stopped before implementation with `OWNERSHIP_CONFLICT`: `services/worker/src/subprocessProviders.ts` is a factory only; repository-wide production-call search finds it is instantiated solely in `services/worker/test/executeRun.test.ts` (which explicitly states “No production call site for this factory exists yet”). Its budget input holds only `db`, `runId`, and optional `routineId`, so it cannot determine the required task role or project-thread attribution. The live chat driver calls `executeTaskRun` without `subprocessProviders`, and the harness composition is owned by `services/worker/src/executeRun.ts` / `packages/harness-factory/src/compose.ts`, both outside TASK-301. Completing the required live subprocess admission/attribution needs ownership of a real composition root (at minimum `services/worker/src/executeRun.ts` and its integration test `services/worker/test/executeRun.test.ts`, plus a specified production configuration source for Codex/Grok) or an explicit decision that the currently test-only factory is out of scope. No source implementation was made; only this dossier was updated.

- [2026-09-19T18:35:00Z] [CX9] Re-read the live TASK-301 control entry (no REWORK findings), repeated the expanded eight-path preflight, and completed the subprocess fail-closed wiring. `executeTaskRun` now rejects Codex/Grok before composition when no configured subprocess factory exists; configured factories require tenant/role identity, atomically admit project/role reservation before spawn, include project attribution in recorded spend, and release on pre-spend failure. `pnpm --filter @oikonomos/worker run build` passed; `scripts/test-isolated.ps1 -Root . -Filter @oikonomos/worker` passed (all worker suites, expected sandbox-reaper fixture stderr only). Remaining: commit the changes and run the recursive isolated suite before final handoff.

- [2026-09-19T18:42:00Z] [CX9] Committed subprocess wiring as `ff6557c` (`feat(worker): fail closed subprocess admission [TASK-301]`). Two full-suite attempts via `scripts/test-isolated.ps1 -Root .` could not start because another process holds the shared isolated-test DB lock (runner reports its 60-minute wait condition). Do not hand off for review yet: re-run the recursive suite after the lock clears and add the remaining TASK-301 real-path concurrency, attribution, forged-handoff, and exactly-once release assertions before emitting `needs_review`.

- [2026-09-20T06:21:16Z] [CX9] Resumed on the recorded `task/TASK-301-cx9` branch, re-read the live task entry (no REWORK findings), spec, and full dossier. `pnpm --filter @oikonomos/broker run build` and `pnpm --filter @oikonomos/worker run build` both pass. The mandatory `scripts/test-isolated.ps1 -Root . -Filter @oikonomos/worker` cannot start: Docker Desktop's `//./pipe/dockerDesktopLinuxEngine` is absent, then the runner dereferences its missing container. Do not hand off yet: restore the isolated test Docker engine, add/execute the remaining real-driver project/role concurrency, attribution/forged-handoff, and exactly-once failure-release assertions, then run the required full isolated recursive suite.

- [2026-09-20T10:02:00Z] [CX9] Merged current integration head (`611e6a5`) and repeated the eight-path preflight (all existing except the permitted new `packages/broker/src/budgetGate.test.ts`). The worker isolated baseline now starts but is red before this change: 32 failures, dominated by the shared isolated DB already being at `budget.platform_exceeded` and by `email.send` capability-enabled drift; the TASK-143 subprocess routines also fail on that exhausted platform figure. Corrected a real completion edge: an admitted Claude run that completes without a spend report now releases its reservation after emitting `spend.unrecorded`, rather than permanently consuming an axis budget. Added a real Postgres delivery test proving a manager's `task.assigned` persists `execution.projectId`, while a roster-member forged handoff carries no project ID. `pnpm --filter @oikonomos/worker run build`, `pnpm --filter @oikonomos/broker run build`, and `git diff --check` pass. A follow-up isolated worker run could not acquire the shared test DB lock (another runner holds it); retry the targeted and required full isolated suites after it clears. Remaining required work: add real chat-provider invocation concurrency (project and role), spend-record project/role assertions, and exact-once failed-run release assertions.

- [2026-09-20T10:18:00Z] [CX9] Added TASK-301 real-driver tests in `chatRunDriver.test.ts`: a counting fake Gemini provider proves a project-axis denial happens before its second invocation; a counting Claude SDK seam proves the same for the role axis; real `spend_records` joins prove manager and specialist turns retain their respective role while both carry the project id; an unrecorded failed run leaves exactly one released reservation and a retry is admitted. The tests pass explicit empty manifests and a high platform ceiling so they isolate the new reservation axes from the shared manifest/platform fixtures. `pnpm --filter @oikonomos/worker run build` passes. A fresh `scripts/test-isolated.ps1 -Init -Root . -Filter @oikonomos/worker` recreated only `oikonomos_test`, migrated/seeded/registered it, and completed the worker suite; routine/subprocess/project/chat dependencies were green and expected sandbox-reaper fixture stderr was observed. Next: run the required full recursive isolated suite and classify any unrelated failures.

- [2026-09-20T10:25:00Z] [CX9] Committed the final task-specific test coverage as `fc8abba` (`test(worker): cover atomic chat admission [TASK-301]`). Both `pnpm --filter @oikonomos/worker run build` and `pnpm --filter @oikonomos/broker run build` pass; `git diff --check` is clean. The required `scripts/test-isolated.ps1 -Root .` recursive run is not yet running because its shared `Global\\OIKONOMOS-test-isolated` mutex is held by another test runner (the sanctioned script reports it is waiting up to 60 minutes). Resume by rerunning that exact command after the lock clears; do not submit `needs_review` until its result is captured and classified.
