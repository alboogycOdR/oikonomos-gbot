# TASK-299 -- Typed project handoff kinds: task.assigned / task.completed / task.blocked / status.requested (P-2)

## Brief
The handoff kind set is closed in THREE places today and all three must move together: the DB CHECK `role_messages_handoff_kind_check` (migration 007 line 11-12, only 'research.complete'/'draft.ready_for_review'), `handoffKinds` in packages/db/src/roleMessages.ts:6 (validated at :119), and the hard-coded JSON-schema enums on the send_to_role tool in BOTH lanes (services/worker/src/workspaceMcpServer.ts:251 and geminiToolExecutors.ts:650). Assigned to CX9, priority high. Depends on: —.

## Spec pointers
specs/OIKONOMOS_PROJECT_WORKSPACE_v1.0.md §5 (5.1 the four kinds and the locator payload {project_id, task_id, artifact_ids[]}, 5.2 task.completed must reference a registered artifact or run receipt, 5.3 no privilege carried); docs/decisions/ADR-019-project-entity-and-manager-role.md §3; docs/decisions/ADR-012 (locator-only handoffs, the CHECK forbidding a value key).

## Owned paths
infra/postgres/migrations/031_project_handoff_kinds.up.sql, infra/postgres/migrations/031_project_handoff_kinds.down.sql, packages/db/src/roleMessages.ts, packages/db/src/roleMessages.test.ts, services/workspace/src/mailbox.ts, services/workspace/src/mailbox.test.ts, services/worker/src/workspaceMcpServer.ts, services/worker/src/workspaceMcpServer.test.ts, services/worker/src/geminiToolExecutors.ts, services/worker/src/geminiToolExecutors.test.ts

## Intended approach
Keep one source of truth for the kind list in roleMessages.ts and have both tool schemas import it rather than re-listing literals, so the next extension cannot drift.

## Acceptance criteria
- Migration 031 widens the DB CHECK to the six kinds (two existing + four new); down restores the original two-kind CHECK; both apply cleanly. (spec §5.1)
- A handoff of any new kind whose fact_ref has a value key, or extra keys beyond project_id/task_id/artifact_ids, is rejected. (spec §5.1, ADR-012)
- task.completed with an empty artifact_ids list, or referencing an artifact id that does not exist or belongs to another project, is rejected; a valid one is accepted -- all proven against real Postgres. (spec §5.2)
- A specialist can send each new kind from BOTH lanes: the Claude-lane MCP tool schema and the Gemini-lane executor schema both accept the new kinds, proven by tests on each. (spec §5.3)
- Existing research.complete / draft.ready_for_review behaviour unchanged; existing tests pass unmodified.
- Full recursive suite via scripts/test-isolated.ps1 only.

## Work Log
