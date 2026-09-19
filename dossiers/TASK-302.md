# TASK-302 -- Project broker tools and the separate project MCP server, with create_role / request_grant declared disabled (P-4a)

## Brief
PROTECTED PATH (packages/broker/builtinTools.ts): adversarial review by a different model is mandatory. Assigned to CX9, priority high. Depends on: TASK-298, TASK-299.

## Spec pointers
specs/OIKONOMOS_PROJECT_WORKSPACE_v1.0.md §7.2 (the exact eight-row tool table), §7.3 (Invariant A already shipped as TASK-277; Invariant B: handlers reach only packages/db project functions), §3.1 (state machine + audited transitions), §3.2 (owner must be on the roster; assign sends task.assigned), §4.1 (workspace_file under /oikonomos/workspace/projects/<project_id>/ via resolveWorkspacePath), §6.4 (fan-out cap = roster size, audited project.fanout_capped); docs/decisions/ADR-019-project-entity-and-manager-role.md §4.

## Owned paths
packages/broker/src/builtinTools.ts, packages/broker/src/builtinTools.test.ts, services/worker/src/projectTools.ts, services/worker/src/projectTools.test.ts, services/worker/src/projectMcpServer.ts, services/worker/src/projectMcpServer.test.ts

## Intended approach
Keep projectTools.ts pure-ish (deps injected) so TASK-303's real-composition test and this task's unit tests share the handlers.

## Acceptance criteria
- BUILTIN_TOOLS contains exactly the eight §7.2 rows with the stated capability ids, tiers and enabled flags. (spec §7.2)
- project MCP server's tools/list returns exactly the six enabled tools and no role or grant verb. (spec §7.3 B)
- update_task enforces todo->doing->review->done, blocked only from doing with a mandatory reason, cancelled from any non-done; every transition emits project.task_transition {task_id, from, to, actor}. (spec §3.1)
- assign_task rejects a non-roster owner and sends a task.assigned handoff; one manager turn cannot emit more task.assigned handoffs than roster members, the excess refused and audited project.fanout_capped. (spec §3.2, §6.4)
- register_artifact rejects a workspace_file ref outside /oikonomos/workspace/projects/<project_id>/ (and D3/traversal) and never stores bytes. (spec §4.1, §11)
- Non-manager callers of write tools are denied.
- Adversarial review by a different model than the author recorded in REVIEW.md.
- Full recursive suite via scripts/test-isolated.ps1 -Init (capabilities re-registered) only.

## Work Log
