# TASK-309 -- Dashboard: project board on the Work view, artifact register on the Results view, blocked items in the attention inbox (P-7c)

## Brief
Web parity for the same Project state. Assigned to TBD, priority low. Depends on: TASK-304.

## Spec pointers
specs/OIKONOMOS_PROJECT_WORKSPACE_v1.0.md §9.2 (Work view becomes the board for a project thread; Results view lists the register; attention inbox lists blocked items with reasons).

## Owned paths
apps/dashboard/src/components/workspace/project/**, apps/dashboard/src/components/workspace/WorkView.tsx, apps/dashboard/src/components/workspace/ResultsView.tsx, apps/dashboard/src/lib/api.ts, apps/dashboard/src/lib/api.test.ts

## Intended approach
Follow TemplatesPage.tsx / WorkView.tsx conventions.

## Acceptance criteria
- For a project's thread, the Work view shows the board and the Results view shows the artifact register. (spec §9.2)
- Blocked items appear in the attention inbox with their reasons. (spec §9.2)
- Dashboard typecheck, tests and build clean.

## Work Log

- [2026-09-24T00:31:59Z] [CX9] Preflight passed: the project component glob is new territory and the four explicitly listed dashboard files exist. TASK-309 cannot satisfy §9.2 within its Owned_Paths: `apps/dashboard/src/pages/ChatPage.tsx` is the only caller of `WorkView` and `ResultsView` (lines 691-701) and owns `activeThreadId` plus `activeSummary` (including TASK-304's `blockedTasks`). The views receive only routines/run IDs, so they cannot identify the selected project thread, call `/projects/:id/tasks` or `/projects/:id/artifacts`, or show the selected thread's blocked items. Need ownership expanded to `apps/dashboard/src/pages/ChatPage.tsx` (and its existing test if behavioral coverage is required) before implementation can proceed.
