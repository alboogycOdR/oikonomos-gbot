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
