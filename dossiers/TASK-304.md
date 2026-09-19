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
