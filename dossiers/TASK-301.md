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
