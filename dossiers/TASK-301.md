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
