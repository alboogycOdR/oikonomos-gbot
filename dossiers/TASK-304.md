# TASK-304 -- Project API: create/list/get/patch projects, board, artifacts, decisions, approvals mirror, blockedTasks in the workspace summary (P-5)

## Brief
Mirror templates.ts: a registerProjectRoutes(app, deps) registrar in projects.ts called once from app.ts (the templates call is at app.ts:1103), ports added to ControlApiDeps in ports.ts. Assigned to S5, priority high. Depends on: TASK-298, TASK-302.

## Spec pointers
specs/OIKONOMOS_PROJECT_WORKSPACE_v1.0.md §9.1 (the exact route list, tenant-scoped via thread ownership), §2.2 (create via the existing group-thread path, roster in one transaction, 404-never-403), §1.2 (charter stored as project-scope profile-tier facts), §3.3 (summary blockedTasks), §8.1 (approvals mirrored by reference), §11 (first bullet).

## Owned paths
services/control-api/src/projects.ts, services/control-api/src/projects.test.ts, services/control-api/src/app.ts, services/control-api/src/ports.ts, services/control-api/src/openapi.ts, packages/db/src/workspaceSummary.ts, packages/db/src/workspaceSummary.test.ts

## Intended approach
Read templates.ts first; it is the closest shape. No raw SQL in routes (test/no-raw-sql.test.ts enforces it) -- go through packages/db.

## Acceptance criteria
- All §9.1 routes exist, tenant-scoped, returning 404 (never 403) for another tenant's project. (spec §9.1, §2.2)
- POST /projects creates exactly one group thread, a roster of at most 6, at most one manager, and the charter as project-scope profile facts; a real Postgres test proves each and proves the transaction rolls back as a unit. (spec §11, §1.2)
- The manager is granted exactly the enabled project.* capabilities and never project.create_role / project.request_grant. (spec §7.2)
- A work item cannot be created blocked without a reason or owned by a non-member via the API. (spec §11)
- An approval decided on a project-attributed run appears in GET /projects/:id/decisions by approval_id. (spec §8.1)
- GET /workspace/summary reports blockedTasks for a project thread. (spec §3.3, §11)
- openapi.ts documents the new routes; full recursive suite via scripts/test-isolated.ps1 -Init only.

## Work Log

- [2026-09-19T17:10:00Z] [S5] BLOCKED: OWNERSHIP_CONFLICT. Branch task/TASK-304-s5 created from 15dde74; no code written. Read packages/db/src/projects.ts, templates.ts, app.ts (/threads/group, decide, grants), ports.ts, packages/approvals invalidatePending.
  Owned_Paths only reach packages/db/src/workspaceSummary.*; control-api may not hold a Pool or SQL (test/no-raw-sql.test.ts). Three ACs need multi-table transactions or queries that exist nowhere:
  1. POST /projects "one transaction / rolls back as a unit": createGroupThread, createProject, addProjectRoleMember (each its own tx) cannot compose atomically from control-api. Needs a new db function e.g. `createProjectWithRoster` (thread + thread_members + projects + project_roles + charter facts + manager grants, one tx). Path: packages/db/src/projects.ts (or new packages/db/src/projectCreate.ts) + test + index.ts export.
  2. Demotion "revoke grants AND invalidate pending workspace.create_bot approvals in one tx": needs a db function (e.g. `demoteProjectManager`) that deletes role_grants and marks that role's pending create_bot approvals invalidated in one statement-set. packages/approvals is protected and invalidatePendingApproval is per-nonce/own-store, not composable into a caller tx. Paths: packages/db/src/projects.ts (or new file) and/or a new function in packages/approvals/src/invalidatePending.ts (protected, adversarial review).
  3. Decisions mirror "approval decided on a project-attributed run": runs have NO project attribution column/lookup (grep: project_id only in projects, roleMessages, spend*, memory). Needs a db function resolving approval->run->project (spend_records.project_id or project_task_runs join) and a mirror insert. Path: packages/db/src/projects.ts or new file.
  Also needed by ports.ts: db/src/index.ts export for all of the above.
  Recommended re-carve: widen 304 Owned_Paths with packages/db/src/projects.ts, packages/db/src/projects.test.ts, packages/db/src/index.ts (or split a P-5a db-layer task before 304). Approvals piece: ORCH decide whether a protected-path task supplies a tx-composable invalidate-by-role primitive.

- [2026-09-19T17:55:00Z] [S5] RESUMED after ORCH widened Owned_Paths (packages/db/src/projects.ts, projects.test.ts, index.ts). Merged master into the branch so the territory hook saw the claim. Implemented and committed (16c1a88 db, next commit control-api):
  - db: createProjectWithRoster (thread+members+project+roles+charter facts+manager grants, ONE tx), updateProjectWithRoster (status/budget/roster/manager; demotion revokes project.*+create_bot grants and invalidates that role's pending AND granted-unconsumed workspace.create_bot approvals in the same tx; a role still managing another project keeps grants), getProjectOverview, mirrorApprovalDecisionToProjects (by approval_id via project_task_runs or spend_records.project_id, idempotent), createProjectTask now takes state/blockedReason, workspaceSummary.blockedTasks. Manager grant denylist in db (request_grant, create_role, retire_bot, anything not project.* / create_bot).
  - control-api: projects.ts registrar (all §9.1 routes, 404-never-403 via injected findTenantOwnedThread, state machine, audit project.task_transition, workspace_file path check), optional ProjectPorts on ControlApiDeps, decideApproval port mirrors after a successful decision (mirror failure swallowed: the decision is already committed and single-use), openapi paths.
  - Deviations to flag: (1) charter facts written by a same-shape INSERT inside the create tx rather than @oikonomos/memory writeMemoryFact (db cannot import memory; writeMemoryFact uses its own pool so cannot join the tx); visible_to = roster, kept in step on roster patch. (2) group thread created by same INSERTs as createGroupThread inside the tx (cannot compose separate txs). (3) demotion also invalidates granted-unconsumed create_bot approvals (same hole as pending). (4) task.assigned handoff on assign (spec 3.2) NOT sent by the API: not in this task's ACs, left to TASK-299 wiring/manager tools.
  - Tests: db real-Postgres (create/rollback/shape/demotion+consume fail/keep-grants/patch/mirror/blocked-create) + summary blockedTasks; control-api route tests (17). Ran via scripts/test-isolated.ps1 only (NOTE: a stray direct vitest run against DATABASE_URL happened once for control-api before I noticed it points at the live db; tests use own fixture tenants, no failures attributable).
  - Suite: db 284+ pass; control-api 349/349 pass on fresh isolated DB. Full recursive run has unrelated failures: services/worker chatRunDriver/tierZeroProvider (live Gemini 429 spend cap + platform budget from env GEMINI_API_KEY), evals-harness OME handoff (budget.platform_exceeded). No files of mine involved.

- [2026-09-20T10:10:00Z] [S5] REWORK session (R1-R4). Merged master into branch, `pnpm -r build`, then ran the FULL suite via scripts/test-isolated.ps1 (-Init then run) on BOTH branch and master (same fresh-Init DB, same box).
  - R2 (registerCapabilities 4 vs 5 manifests): STALE BUILD. After merging master the built connectors dist lacked the `project` manifest; `pnpm -r build` fixes it; worker registerCapabilities now passes. No source change.
  - R1 (chat.routes 400): body is `{"error":"budget.platform_exceeded"}` from the Tier-0 router's budget gate. Root cause: packages/db/src/spendReservations.test.ts:246-248 (TASK-300, not mine) leaks a $100 `codex` spend_records row into the shared test DB; getPlatformSpendUsd then exceeds the R350 (~$19) ceiling for every later package. `-Init` does not clear spend_records. MASTER (checkout 5fd3126) fails the identical control-api test after a fresh -Init, so it is not a TASK-304 regression. My branch adds no spend_records writes (control-api projects.test.ts uses a stubbed port; db tests insert none).
  - R3 (OME handoff signature change): same $100 leak -> budget.platform_exceeded; master shows the same failure. Handoff/spend-attribution code untouched by this task (diff touches only projects.ts, workspaceSummary.ts, index exports, control-api projects/app/ports/openapi).
  - R4 classification vs master baseline (fresh -Init): master = control-api 1 fail, worker 42 fail, evals OME 1 fail. branch = control-api 1, worker 34-39 (varies with flaky pg-boss timing), OME 1. All are budget.platform_exceeded cascade or the NOT-CHARGED set; own-package (db 284 pass, control-api 348 pass + the one leak-affected test) green. One transient db roles.test deadlock in run 1 did not recur.
  - Recommend ORCH: file a task on packages/db/src/spendReservations.test.ts cleanup of its $100 rows (not my territory).
