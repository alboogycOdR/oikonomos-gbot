# TASK-298 -- Project manager schema: project_roles, project_task_runs, role and project budget columns, reservation tables (P-1 remainder)

## Brief
TASK-276 already shipped migration 027 with only four ADR-019 tables (projects, project_tasks, project_artifacts, project_decisions) and packages/db/src/projects.ts accessors for them; its own header deliberately left out the rest. Assigned to S5, priority high. Depends on: —.

## Spec pointers
specs/OIKONOMOS_PROJECT_WORKSPACE_v1.0.md §2 (project_roles, 2.1 one manager per project via partial unique index, 2.3), §3 (project_task_runs), §6.1 (spend_records.project_id), §6.2 (roles.budget_usd, spend_reservations, budget_ledgers); docs/decisions/ADR-019-project-entity-and-manager-role.md §2, §5.

## Owned paths
infra/postgres/migrations/030_project_manager.up.sql, infra/postgres/migrations/030_project_manager.down.sql, packages/db/src/projects.ts, packages/db/src/projects.test.ts, packages/db/src/roles.ts, packages/db/src/roles.test.ts, packages/db/src/spend.ts, packages/db/src/spend.test.ts, packages/db/src/index.ts

## Intended approach
Mirror 027's style and 028/029's comment density. Extend projects.ts rather than creating a new module so index.ts needs only additive exports.

## Acceptance criteria
- Migration 030 up creates project_roles, project_task_runs, spend_reservations, budget_ledgers and adds spend_records.project_id and roles.budget_usd; down reverses exactly; both applied cleanly against the isolated test DB. (spec §2, §3, §6.1, §6.2)
- Inserting a second is_manager=true row for the same project fails at the database, proven by a real Postgres test. (spec §2.1)
- Adding and removing a roster member updates thread_members and project_roles in one transaction; a real test proves a failure mid-way leaves neither changed. (spec §2.2)
- A group roster may not exceed GROUP_MEMBER_CAP (6) through the new accessor, proven by test. (spec §1.1)
- Spend records can carry a project_id and roles can carry a budget_usd; both read back correctly in real Postgres tests. (spec §6.1, §6.2)
- Full recursive suite via scripts/test-isolated.ps1 only, never a direct DATABASE_URL; any failures named as pre-existing with evidence.

## Work Log

### 2026-09-19 S5 session
- Branch task/TASK-298-s5 created; had to `git merge --ff-only master` first because the worktree PLAN.md was stale (firewall saw no claim).
- Migration 030 up/down written. Verified against oikonomos_test: down drops all 4 tables + 2 columns (to_regclass all NULL, 0 columns), re-up schema dump identical to the original up.
- projects.ts: PROJECT_ROSTER_CAP=6 (mirrors worker GROUP_MEMBER_CAP, cannot import), addProjectRoleMember/removeProjectRoleMember (one txn with thread_members, project row FOR UPDATE, cap check), listProjectRoleMembers, setProjectManager, linkProjectTaskRun, listProjectTaskRunIds. roles.ts: getRoleBudgetUsd/setRoleBudgetUsd (kept off Role shape). spend.ts: optional projectId on recordSpend + SpendRecord.projectId. index.ts additive exports.
- Tests: new projects.test.ts (7), appended roles.test.ts + spend.test.ts. `test-isolated.ps1 -Init` then `-Filter @oikonomos/db`: 261 passed, 2 skipped, 0 failed. tsc --noEmit clean.
- Full recursive run: failures in db suites were the shared oikonomos_test DB being re-Init'd by another session without 030 (relation project_roles does not exist); chatRunDriver/worker failures are OpenSandbox 500 SANDBOX_START_FAILED (docker env). database.test.ts "flips every registered capability" (35 vs 36) fails on master too. Not caused by this task.
- Note for reviewer: rerun `-Init -Root <this worktree>` immediately before the db suite; concurrent -Init from other worktrees wipes 030.
