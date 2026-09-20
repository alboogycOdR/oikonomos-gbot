# TASK-303 -- Mount the project MCP server for manager roles in both lanes, with the no-role/no-grant liveness test (P-4b, Invariant B)

## Brief
Mount TASK-302's project MCP server for a run whose role is a project manager: Claude lane via connectorResolution.ts (resolveGrantedWorkspaceConnector at :24 / combineConnectorContexts at :60 -- steel-mcp alongside workspace is the precedent for a second server) and the --mcp-config assembly in chatRunDriver.ts (~:1192); Gemini lane via inline executors in geminiToolExecutors.ts added to the tool list at chatRunDriver.ts ~:781. Assigned to CX9, priority high. Depends on: TASK-302, TASK-301.

## Spec pointers
specs/OIKONOMOS_PROJECT_WORKSPACE_v1.0.md §7.3 B (liveness through the REAL broker->MCP composition, before/after row counts on roles and role_grants, keyed on each tool's audit event), §11; docs/decisions/ADR-019-project-entity-and-manager-role.md §4 Invariant B.

## Owned paths
services/worker/src/connectorResolution.ts, services/worker/src/chatRunDriver.ts, services/worker/src/geminiToolExecutors.ts, services/worker/src/projectManagerInvariant.test.ts

## Intended approach
Follow the steel-mcp second-server precedent exactly rather than inventing a new composition seam.

## Acceptance criteria
- A manager role's run has the six enabled project tools available in both lanes; a non-manager member's run does not. (spec §7.2)
- The declared-disabled create_role / request_grant tools are absent from every mount. (spec §7.3 A, §11)
- Liveness test through the real broker->MCP composition invokes every mounted manager tool and proves roles and role_grants row counts unchanged, keyed on each tool's audit event. (spec §7.3 B, §11)
- Existing workspace and steel mounts unchanged; existing tests pass unmodified.
- Adversarial review by a different model than the author recorded in REVIEW.md.
- Full recursive suite via scripts/test-isolated.ps1 only.

## Work Log

- [2026-09-20T15:55:00Z] [CX9] Preflight inspected the four assigned paths (three existing worker modules; new projectManagerInvariant.test.ts). Added grant-derived project MCP mounting in both lanes and focused mounting tests; next: execute the isolated worker suite and add the real broker→MCP liveness fixture if the current test seam does not cover audit persistence.
- [2026-09-20T16:40:00Z] [CX9] Added the project-manager mount wiring, project destinations for broker L1, an isolated real Gemini broker-composition liveness fixture, and the manager create_bot approval-path fixture. `pnpm --filter @oikonomos/worker run typecheck` passes. The isolated worker suite confirms create_bot and five project tool audit events, but `assign_task` never emits `project.task_assigned`: its existing, unowned `services/worker/src/projectTools.ts` handler's `sendToRole` path fails before its audit. TASK-303 cannot meet its required every-tool/audit liveness criterion without an Owned_Paths expansion for that file (or a TASK-302 repair).
- [2026-09-20T16:20:00Z] [CX9] Committed adc2992. `pnpm --filter @oikonomos/worker run typecheck` passes. `scripts/test-isolated.ps1 -Root . -Filter @oikonomos/worker` executes the new projectManagerInvariant tests successfully, but the package suite remains red on pre-existing shared-DB state: two subprocess budget tests hit `budget.platform_exceeded`, and downstream chat-run tests hit the same platform ceiling or `email.send` enabled-state drift. The new test verifies both mounted surfaces/no-grant absence/disabled exclusions; the required real broker→MCP audit liveness fixture is still outstanding.
