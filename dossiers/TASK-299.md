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

- [2026-09-19T06:05:00Z] [CX9] Preflight complete before implementation:
  ```text
  [preflight] TASK-299 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex9-GROKBOT-CLONE
  [preflight] 10 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    NEW    infra/postgres/migrations/031_project_handoff_kinds.up.sql  -> does not exist; parent infra/postgres/migrations/ exists
    NEW    infra/postgres/migrations/031_project_handoff_kinds.down.sql  -> does not exist; parent infra/postgres/migrations/ exists
    FILE   packages/db/src/roleMessages.ts  -> exists, 337 line(s), 12304 bytes
    FILE   packages/db/src/roleMessages.test.ts  -> exists, 135 line(s), 4897 bytes
    FILE   services/workspace/src/mailbox.ts  -> exists, 289 line(s), 11443 bytes
    FILE   services/workspace/src/mailbox.test.ts  -> exists, 127 line(s), 5379 bytes
    FILE   services/worker/src/workspaceMcpServer.ts  -> exists, 298 line(s), 15921 bytes
    FILE   services/worker/src/workspaceMcpServer.test.ts  -> exists, 175 line(s), 9422 bytes
    FILE   services/worker/src/geminiToolExecutors.ts  -> exists, 866 line(s), 42375 bytes
    FILE   services/worker/src/geminiToolExecutors.test.ts  -> exists, 423 line(s), 21990 bytes
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```

- [2026-09-19T08:15:00Z] [CX9] Implemented the closed six-kind handoff set and migration 031. Project handoffs now require the exact locator `{project_id, task_id, artifact_ids}`; `task.completed` rejects empty, missing, or cross-project artifacts against real Postgres. Both Claude MCP and Gemini schemas consume the single exported kind list. Evidence: `pnpm --filter @oikonomos/db build`, `pnpm --filter @oikonomos/workspace build`, and `pnpm --filter @oikonomos/worker build` passed; the TASK-299 real-Postgres cases passed in `scripts/test-isolated.ps1 -Init -Filter @oikonomos/db` (7 `roleMessages.test.ts` integration tests), and both updated lane-schema suites passed inside `scripts/test-isolated.ps1 -Filter @oikonomos/worker` (`workspaceMcpServer.test.ts`, `geminiToolExecutors.test.ts`). The aggregate filtered suites still report pre-existing unrelated failures: `projects.ts` cleanup deletes group threads before `thread_members`; worker `chatRunDriver.ts` fixture FK failures and one `routineJob.test.ts` timeout. Migration 031 down then up applied cleanly to `oikonomos_test`; the restored check listed all six kinds. A full recursive isolated-suite run was also invoked after `-Init`; its streamed console output was truncated by the runner after dashboard tests, so its aggregate exit summary was not available to record.
