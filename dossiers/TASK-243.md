# TASK-243 — Workspace-1 — dashboard Results and Work views: receipt panel, routines with pause/resume/test-run and next fire (UTC)

**Unit:** S5 · **Priority:** medium · **Depends_On:** TASK-239, TASK-242

## Brief
Two views inside a workspace, switched by a segment in the URL (`/workspace/:threadId/results`, `/work`). Results: render TASK-242's receipt for the workspace's latest completed run, distinguishing completed action, prepared draft and proposed next action, with links to the existing run-detail and evidence pages. Work: list the workspace role's routines via the existing `GET /roles/:roleId/routines` (already partly in `RightPanel`), with pause / resume / test-run calling the existing routes (`POST /routines/:id/pause|resume|test-run`), the test-run warning surfaced verbatim, and next fire shown with an explicit "UTC" label (no time-zone support exists — TASK-247). Pausing must not imply cancelling a running run (§1); show the latest run state from the summary alongside.

## Spec pointers
specs/OIKONOMOS_WORKSPACE_WAVE_v1.0.md §7.2, §7.3, §1

Read `specs/OIKONOMOS_WORKSPACE_WAVE_v1.0.md` §1 first for the product shape and §10 for what must not be claimed. The independent review that produced this wave (verdict, disposition matrix, execution proposal) is at `E:\DELL-PROJECTS\GROKBOT-RESEARCH-DOCS\ORCH_REVIEW\` — read the rows cited in Spec_References; do not treat the advisory documents themselves as spec.

## Intended approach
Two views inside a workspace, switched by a segment in the URL (`/workspace/:threadId/results`, `/work`). Results: render TASK-242's receipt for the workspace's latest completed run, distinguishing completed action, prepared draft and proposed next action, with links to the existing run-detail and evidence pages. Work: list the workspace role's routines via the existing `GET /roles/:roleId/routines` (already partly in `RightPanel`), with pause / resume / test-run calling the existing routes (`POST /routines/:id/pause|resume|test-run`), the test-run warning surfaced verbatim, and next fire shown with an explicit "UTC" label (no time-zone support exists — TASK-247). Pausing must not imply cancelling a running run (§1); show the latest run state from the summary alongside.

## Owned_Paths
apps/dashboard/src/components/workspace/**, apps/dashboard/src/lib/api.ts, apps/dashboard/src/pages/ChatPage.tsx, apps/dashboard/src/pages/ChatPage.test.tsx, apps/dashboard/src/components/chat/RightPanel.tsx, apps/dashboard/src/components/chat/RightPanel.test.tsx, apps/dashboard/src/App.tsx, apps/dashboard/src/App.test.tsx

## Work Log
