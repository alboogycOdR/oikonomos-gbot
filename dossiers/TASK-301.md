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
- [2026-09-19T15:38:00Z] [CX9] Stopped before implementation with `OWNERSHIP_CONFLICT`: `services/worker/src/subprocessProviders.ts` is a factory only; repository-wide production-call search finds it is instantiated solely in `services/worker/test/executeRun.test.ts` (which explicitly states “No production call site for this factory exists yet”). Its budget input holds only `db`, `runId`, and optional `routineId`, so it cannot determine the required task role or project-thread attribution. The live chat driver calls `executeTaskRun` without `subprocessProviders`, and the harness composition is owned by `services/worker/src/executeRun.ts` / `packages/harness-factory/src/compose.ts`, both outside TASK-301. Completing the required live subprocess admission/attribution needs ownership of a real composition root (at minimum `services/worker/src/executeRun.ts` and its integration test `services/worker/test/executeRun.test.ts`, plus a specified production configuration source for Codex/Grok) or an explicit decision that the currently test-only factory is out of scope. No source implementation was made; only this dossier was updated.
