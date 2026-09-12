# TASK-239 — Workspace-1 — dashboard session bootstrap, logout, summary poll, blocked-reason surfacing

**Unit:** S5 · **Priority:** high · **Depends_On:** TASK-236, TASK-237

## Brief
Consume TASK-237's routes from the controller TASK-236 built. `AuthContext` calls `GET /auth/me` on load and is authenticated only on a 200 (today `isAuthenticated` starts `false` on every load, `AuthContext.tsx:6-15,25`); a logout button calls `POST /auth/logout` and drops all in-memory workspace state including drafts. Add `getWorkspaceSummary()` to `lib/api.ts` and poll it on an interval (default 15 s, configurable) and on window focus; the active thread keeps its SSE stream, background threads get badges (working / waiting approval / blocked / unread) from the summary. Render the blocked reason for a workspace whose latest run is `waiting_approval` or `failed`: for approvals link to the existing inline card; for a failed run show the deterministic reason string from the run's terminal audit event (fetch via the existing run-detail/evidence client) and offer only retry (re-send) — never invented text. Show the dashboard build SHA in the footer. Same owner as TASK-236; sequential.

## Spec pointers
specs/OIKONOMOS_WORKSPACE_WAVE_v1.0.md §3.1, §3.2, §4.2, §4.3, §1

Read `specs/OIKONOMOS_WORKSPACE_WAVE_v1.0.md` §1 first for the product shape and §10 for what must not be claimed. The independent review that produced this wave (verdict, disposition matrix, execution proposal) is at `E:\DELL-PROJECTS\GROKBOT-RESEARCH-DOCS\ORCH_REVIEW\` — read the rows cited in Spec_References; do not treat the advisory documents themselves as spec.

## Intended approach
Consume TASK-237's routes from the controller TASK-236 built. `AuthContext` calls `GET /auth/me` on load and is authenticated only on a 200 (today `isAuthenticated` starts `false` on every load, `AuthContext.tsx:6-15,25`); a logout button calls `POST /auth/logout` and drops all in-memory workspace state including drafts. Add `getWorkspaceSummary()` to `lib/api.ts` and poll it on an interval (default 15 s, configurable) and on window focus; the active thread keeps its SSE stream, background threads get badges (working / waiting approval / blocked / unread) from the summary. Render the blocked reason for a workspace whose latest run is `waiting_approval` or `failed`: for approvals link to the existing inline card; for a failed run show the deterministic reason string from the run's terminal audit event (fetch via the existing run-detail/evidence client) and offer only retry (re-send) — never invented text. Show the dashboard build SHA in the footer. Same owner as TASK-236; sequential.

## Owned_Paths
apps/dashboard/src/lib/AuthContext.tsx, apps/dashboard/src/lib/api.ts, apps/dashboard/src/pages/LoginPage.tsx, apps/dashboard/src/pages/LoginPage.test.tsx, apps/dashboard/src/pages/ChatPage.tsx, apps/dashboard/src/pages/ChatPage.test.tsx, apps/dashboard/src/components/chat/**, apps/dashboard/src/lib/workspaceState.ts, apps/dashboard/src/lib/workspaceState.test.ts

## Work Log
