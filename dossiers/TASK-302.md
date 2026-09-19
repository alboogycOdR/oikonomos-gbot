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

- [2026-09-19T13:40:00Z] [CX9] Resumed on task/TASK-302-cx9 after TASK-314 merged; merged current integration base. Preflight: six owned entries inspected -- builtinTools.ts and builtinTools.test.ts exist; the four project tool/server implementation and test files are new territory. Implemented seven broker declarations (six enabled, request_grant disabled), dependency-injected project handlers, and the isolated stdio project MCP server. Worker isolated suite passed after database initialization; broker isolated suite is queued behind the shared test DB lock. IMPORTANT OPERATIONS: after merge, run register-capabilities against production and the test DB before starting control-api, or TASK-277's capability enabled-state drift guard will refuse startup.
- [2026-09-19T13:52:00Z] [CX9] BLOCKED: isolated broker suite reaches packages/broker/src/index.test.ts's "registers a describer for every BUILTIN_TOOLS name" invariant and fails because each new mcp__project__* declaration has no entry in packages/broker/src/describe.ts (expect(...).toBeDefined()). That file is outside TASK-302 Owned_Paths; do not bypass the invariant. Territory must be widened to include packages/broker/src/describe.ts (and its test if needed), then add safe project-tool descriptions and rerun isolated broker + full recursive tests. Worker and broker typechecks pass; the earlier isolated worker suite passed before this broker-only ownership finding.

- [2026-09-19T10:58:00Z] [CX9] Preflight completed before implementation:
  ```text
  [preflight] TASK-302 Owned_Paths inspected in E:/DELL-PROJECTS/wt-codex9-GROKBOT-CLONE
  [preflight] 6 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    FILE   packages/broker/src/builtinTools.ts  -> exists, 84 line(s), 3855 bytes
    FILE   packages/broker/src/builtinTools.test.ts  -> exists, 149 line(s), 9450 bytes
    NEW    services/worker/src/projectTools.ts  -> does not exist; parent services/worker/src/ exists
    NEW    services/worker/src/projectTools.test.ts  -> does not exist; parent services/worker/src/ exists
    NEW    services/worker/src/projectMcpServer.ts  -> does not exist; parent services/worker/src/ exists
    NEW    services/worker/src/projectMcpServer.test.ts  -> does not exist; parent services/worker/src/ exists
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```
- [2026-09-19T10:58:00Z] [CX9] BLOCKED — MISSING_DEPENDENCY: `packages/db/src/projects.ts` exports `createProjectTask` (which can set `ownerRoleId` only at creation) and `updateProjectTaskState`, but no project-layer operation exists to assign/reassign `project_tasks.owner_role_id` for an existing task. TASK-302 must implement `assign_task` while maintaining Invariant B (worker handlers call project DB functions only), but `packages/db/src/projects.ts` is outside TASK-302 Owned_Paths. Please add/assign a DB-owned API such as `assignProjectTaskOwner(options, { taskId, ownerRoleId })` (ideally also constrained to the task's project), export it from `packages/db/src/index.ts`, then re-dispatch TASK-302. Direct worker SQL would violate §7.3 Invariant B and expanding this builder's territory would violate the ownership firewall. No code changes were made.

- [2026-09-19T14:08:00Z] [CX9] Resumed after the description-path expansion. Added whitelist descriptions for all seven project capability declarations (including declared-disabled `request_grant`) and strengthened project-tool state/manager-denial coverage. Commit: `5cbc5f4 fix(project): describe broker tools and strengthen guard tests [TASK-302]`. `pnpm --filter @oikonomos/broker typecheck` and `pnpm --filter @oikonomos/worker typecheck` pass.
- [2026-09-19T14:08:00Z] [CX9] Test evidence: rebuilt broker and worker; `scripts/test-isolated.ps1 -Init -Root .` completed and direct disposable-DB verification returned `PROJECT_READ_CAPABILITY_COUNT=1`. Isolated broker: 15 files / 188 tests passed, including `describe.test.ts` 28/28 and `builtinTools.test.ts` 4/4. Isolated worker: TASK-302 `projectTools.test.ts` 3/3 and `projectMcpServer.test.ts` 1/1 passed. Full recursive isolated run completed with existing unrelated failures (DB TASK-084 migration-backfill deadlock, control-api FreeLLMAPI route 400 vs 201, eval harness failures, and sandbox/provider timeout/denial failures). The focused worker run also exposes a task-caused ownership gap: `services/worker/src/registerCapabilities.test.ts:33` expects six registrations but correctly receives a seventh `project` registration after this task's `mcp:project` declarations; that file is outside TASK-302 Owned_Paths. BLOCKED — OWNERSHIP_CONFLICT: widen TASK-302 to include `services/worker/src/registerCapabilities.test.ts` (or assign its expected-registration update), then rerun isolated worker and recursive suites. Operational handoff: re-run worker `register-capabilities` against production and test DB after merge; control-api fails closed on declaration/persistence enabled-state drift.

- [2026-09-19T13:22:58Z] [CX9] Resumed after ORCH widened ownership to `services/worker/src/registerCapabilities.test.ts`; TASK-302 has no `REWORK` finding. Preflight output: six original owned files and the widened registration test all exist (the current preflight reports the task's six original project/broker paths, each as FILE). Updated the exact connector registration assertion from six to seven entries and added the `mcp:project` capability inventory assertion, including `project.request_grant` as `enabled: false`; PostgreSQL idempotency coverage now includes `mcp:project` and checks both `project.read` and the disabled grant. Commit: `2169054 test(project): register project capability declarations [TASK-302]`. `pnpm --filter @oikonomos/worker typecheck` passed and `git diff --check` was clean. An isolated worker suite was started with `scripts/test-isolated.ps1 -Init -Root . -Filter @oikonomos/worker`; at this stopping point its Vitest process remains active in the provider/integration tail (PID 12632), so no outcome is claimed. Next: collect and classify that run, then run the required full recursive isolated suite before submitting for review. Operational handoff remains: after merge, re-run worker `register-capabilities` against production and the test DB before control-api startup.
