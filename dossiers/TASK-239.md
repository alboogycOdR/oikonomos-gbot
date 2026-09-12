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

- [2026-09-12T13:41:00Z] [S5] Preflight (paste of `python scripts/preflight_paths.py TASK-239`):
  ```
  [preflight] TASK-239 Owned_Paths inspected in E:/DELL-PROJECTS/wt-s5-GROKBOT-CLONE
  [preflight] 9 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    FILE   apps/dashboard/src/lib/AuthContext.tsx  -> exists, 50 line(s), 1836 bytes
    FILE   apps/dashboard/src/lib/api.ts  -> exists, 375 line(s), 12096 bytes
    FILE   apps/dashboard/src/pages/LoginPage.tsx  -> exists, 54 line(s), 1754 bytes
    NEW    apps/dashboard/src/pages/LoginPage.test.tsx  -> does not exist; parent apps/dashboard/src/pages/ exists
    FILE   apps/dashboard/src/pages/ChatPage.tsx  -> exists, 422 line(s), 15586 bytes
    FILE   apps/dashboard/src/pages/ChatPage.test.tsx  -> exists, 664 line(s), 29158 bytes
    GLOB   apps/dashboard/src/components/chat/**  -> 25 file(s) (ApprovalCard/Avatar/BotSidebar/ChatShell/ComposeBox/ConversationPane/CreateBotDialog/GroupThreadDialog/MessageBubble/RightPanel + tests, fixtures.ts, preview/, types.ts)
    FILE   apps/dashboard/src/lib/workspaceState.ts  -> exists, 150 line(s), 5993 bytes
    FILE   apps/dashboard/src/lib/workspaceState.test.ts  -> exists, 191 line(s), 7688 bytes
  ```
  Note: my worktree's checked-out branch was stale relative to `origin/master` (missing the TASK-239 claim commit) — `git fetch origin && git rebase origin/master` on the freshly-created `task/TASK-239-s5` branch before doing anything else, per the territory-firewall reading `PLAN.md` from disk.

  Implemented all six spec pointers:
  - §3.1/§3.2: `AuthContext` now calls `GET /auth/me` once on mount (`isBootstrapping`/`isAuthenticated`), and exposes `logout()` (`POST /auth/logout` + drop). Deliberately did NOT gate `AuthProvider`'s own render on the bootstrap promise — that would break the unowned `App.test.tsx`'s synchronous first-render assertion (verified by trying it: it broke, reverted). Instead `LoginPage` (owned) holds off rendering the form/redirects away once `isAuthenticated` flips true, covering "valid cookie -> no login screen shown" and "no cookie -> login shown" without touching `RequireAuth.tsx`/`App.tsx` (outside Owned_Paths).
  - §4.1/§4.2: `getWorkspaceSummary()` added to `api.ts`; `ChatPage` polls it every `VITE_WORKSPACE_SUMMARY_POLL_MS` (default 15000) and on `window focus`, paused via `visibilitychange` while `document.hidden`. Background threads (never the active one) get a sidebar badge (`working`/`waiting_approval`/`blocked`/`unread`) derived in `computeWorkspaceBadge` — `unread` only fires when the summary's `lastActivityAt` is newer than the newest message this client has actually loaded for that thread, so it's never invented.
  - §4.3: pending-approval background threads link via the existing sidebar `onSelectBot` navigation into the already-rendered inline `ApprovalCard` (no new card needed — the approval message is part of the thread's own history). A failed active thread's run fetches its terminal reason via the existing `getRunEvidence` client (walks the audit trail backwards for the last `payload.reason` string), falling back to `getRun(...).failureNote` (same underlying string server-side) if the trail doesn't surface one — rendered in a new `ChatShell` banner with a single Retry action that re-sends the thread's last user message body via the existing `handleSend`.
  - §6.2: `api.ts` now exports `BUILD_SHA` from the `__OIKONOMOS_BUILD_SHA__` global `vite.config.ts` (TASK-240) already defines but nothing referenced — declared ambient-locally inside `api.ts` rather than editing `vite-env.d.ts` (outside Owned_Paths). Shown in a new `ChatShell` footer alongside the logout button.
  - Logout button lives in the new `ChatShell` footer; clicking it dispatches `workspaceState`'s `reset` (drafts/pending/transcripts dropped immediately, belt-and-braces same as the existing 401 path) and calls `AuthContext.logout()`.

  Test evidence:
  - `pnpm --filter @oikonomos/dashboard typecheck` — clean.
  - `pnpm --filter @oikonomos/dashboard build` (tsc + vite) — clean; `dist/build.json` + `__OIKONOMOS_BUILD_SHA__` both present.
  - `pnpm --filter @oikonomos/dashboard test` — 20 files / 116 tests pass (107 pre-existing + 9 new: 2 bootstrap in `ChatPage.test.tsx`, 1 badge test, 1 logout test, 5 in new `LoginPage.test.tsx`). Zero regressions; had to add a `/workspace/summary -> []` branch to every pre-existing `ChatPage.test.tsx` fetch mock so the new background poll doesn't log a spurious "not found" — confirmed clean stderr after.
  - Full isolated-DB run per CLAUDE.md DEVDEPARTMENT amendment + orchestrator_notes: `powershell scripts/test-isolated.ps1 -Root <this worktree>`. `@oikonomos/dashboard` alone: 20/20 files, 116/116 tests, exit 0. Full `pnpm -r --workspace-concurrency=1 test`: 4 pre-existing failures, all in `packages/db`/`services/worker` — outside this task's Owned_Paths, zero source changes made there this session: `registerCapabilities.test.ts` idempotency timeout, `inboxTriage.e2e.test.ts` live-Gmail timeout, `workerJobQueue.test.ts` pg-boss lifecycle race (`lastFireStatus` queued vs missed), `chatRunDriver.ts` per-phase-timing liveness flake (`finalize` phase missing on one run). These match the class of flake orchestrator_notes already documents (TASK-250/251, "two worker test races") — not introduced by this session, flagging for ORCH triage rather than touching out-of-territory files.

  Status: all six acceptance criteria implemented and verified; handing to `needs_review`.
