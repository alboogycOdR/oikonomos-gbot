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
