# TASK-236 — Workspace-1 — dashboard workspace controller: single selection owner, per-thread pending/draft state, message merge, members roster, /workspace/:threadId route

**Unit:** S5 · **Priority:** high · **Depends_On:** —

## Brief
Fix the four confirmed dashboard defects and the page-boundary gap with one controlled state module. Today `ChatPage.tsx:116` and `ChatShell.tsx:54-64` each own `activeBotId`; the parent's `handleSelectBot` (`ChatPage.tsx:177-191`) never calls its own setter, so the SSE effect (`ChatPage.tsx:219-253`) and the routines lookup stay on the first thread while the child renders another. `isBotResponding`/`pendingSinceRef` are one value for all threads (`ChatPage.tsx:119,125,179-181`). `ComposeBox` holds one draft, never remounts on switch, and clears before the void `handleSend` resolves (`ComposeBox.tsx:18-25`, `ChatPage.tsx:297`), so a failed POST loses the text. `ChatPage.tsx:292` passes `members={[]}` and the Members tab is the right panel's default, so it is permanently empty; the sidebar's create-bot dialog works but the thread list is never refreshed after creation.

## Spec pointers
specs/OIKONOMOS_WORKSPACE_WAVE_v1.0.md §2.1–§2.7; specs/OIKONOMOS_WORKSPACE_WAVE_v1.0.md §1

Read `specs/OIKONOMOS_WORKSPACE_WAVE_v1.0.md` §1 first for the product shape and §10 for what must not be claimed. The independent review that produced this wave (verdict, disposition matrix, execution proposal) is at `E:\DELL-PROJECTS\GROKBOT-RESEARCH-DOCS\ORCH_REVIEW\` — read the rows cited in Spec_References; do not treat the advisory documents themselves as spec.

## Intended approach
Fix the four confirmed dashboard defects and the page-boundary gap with one controlled state module. Today `ChatPage.tsx:116` and `ChatShell.tsx:54-64` each own `activeBotId`; the parent's `handleSelectBot` (`ChatPage.tsx:177-191`) never calls its own setter, so the SSE effect (`ChatPage.tsx:219-253`) and the routines lookup stay on the first thread while the child renders another. `isBotResponding`/`pendingSinceRef` are one value for all threads (`ChatPage.tsx:119,125,179-181`). `ComposeBox` holds one draft, never remounts on switch, and clears before the void `handleSend` resolves (`ComposeBox.tsx:18-25`, `ChatPage.tsx:297`), so a failed POST loses the text. `ChatPage.tsx:292` passes `members={[]}` and the Members tab is the right panel's default, so it is permanently empty; the sidebar's create-bot dialog works but the thread list is never refreshed after creation.

  Approach: introduce `apps/dashboard/src/lib/workspaceState.ts` (a reducer/hook keyed by threadId holding `messages`, `pending`, `draft`, `lastSeenMessageId`) owned by `ChatPage`; make `ChatShell`/`ComposeBox` fully controlled (`activeThreadId`, `draft`, `onDraftChange` props; no internal `useState` copies). Merge messages by id and never let a slower history fetch overwrite streamed messages. Add `/workspace/:threadId` in `App.tsx`; `/` redirects to the most recent thread. Fetch the roster (`listRoles()` already returns it — `ChatPage.tsx:153` discards it) and refresh threads after create. Keep tab close, run cancel, routine pause and mark-read as distinct actions (§1). Do NOT touch `lib/api.ts`, `AuthContext.tsx` or `LoginPage.tsx` — those belong to TASK-239/241, which follow this task with the same owner.

## Owned_Paths
apps/dashboard/src/pages/ChatPage.tsx, apps/dashboard/src/pages/ChatPage.test.tsx, apps/dashboard/src/components/chat/**, apps/dashboard/src/lib/realtime.ts, apps/dashboard/src/lib/realtime.test.ts, apps/dashboard/src/lib/workspaceState.ts, apps/dashboard/src/lib/workspaceState.test.ts, apps/dashboard/src/App.tsx, apps/dashboard/src/App.test.tsx

## Work Log
