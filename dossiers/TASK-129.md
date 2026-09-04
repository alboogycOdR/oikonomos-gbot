# TASK-129 — RT-01: real-time push for chat messages and approvals

Unit: S5. Branch: `task/TASK-129-s5`.

## Work Log

- [2026-09-04T15:52:00Z] [S5] Resumed after ORCH's redispatch note (previous
  session never created the branch). Read PLAN.md TASK-129 block fresh,
  created `task/TASK-129-s5` off the current worktree tip (post
  TASK-127/others merges).

  **Server (`services/control-api/src/app.ts`)**: added
  `GET /threads/:id/stream`, an SSE route. There is no cross-route
  pub/sub bus in `ControlApiDeps` (OIK-084's port boundary — adding one
  would mean touching files outside this task's `Owned_Paths`), so
  "push" is implemented as a short server-side poll loop
  (`BuildAppOptions.sseIntervalMs`, default 300ms) fanned out over one
  held-open connection per subscribed client, replacing the *client's*
  2s poll loop entirely (that's the actual behavior change the spec
  calls for — the client no longer polls at all). Extracted the message
  shaping logic (`senderName`/`approval` join) out of the existing
  `GET /threads/:id/messages` handler into `shapeMessage`/
  `loadMessageShapingContext` so both routes share one wire shape
  without duplicating it — pure refactor, existing route's behavior is
  byte-for-byte unchanged (verified: `chat.routes.test.ts`,
  `test/app.test.ts` still pass unmodified).

  Resume semantics: each frame is `id: <message id>\ndata: <json>\n\n`;
  a reconnecting client sends `Last-Event-ID` and the poll loop resumes
  from that cursor via `listMessages`'s existing exclusive `after`
  option (`packages/db/src/messages.ts`) — no message is ever resent or
  skipped across a reconnect.

  New test file `services/control-api/src/sse.test.ts` (4 tests, real
  `app.listen()` + `fetch()` round trips, no real DB — fake
  `ControlApiDeps`): 401 without a session, 404 for an unknown thread, a
  pushed message arrives well under 2000ms, and a reconnect with
  `Last-Event-ID` resumes past the already-seen message with no dupe.
  Gave the file a 15s per-test timeout — the first test in the file
  occasionally needs more than vitest's 5s default while the module
  graph is still warming up in a full `pnpm -r test` run (not seen in
  isolation).

  **Client (`apps/dashboard/src/lib/realtime.ts`, new file)**:
  `subscribeToThreadMessages(threadId, onMessage, onError?, options?)`.
  Deliberately built on `fetch` + a manual `ReadableStream` reader
  rather than `EventSource` — jsdom (this repo's test environment) has
  no native `EventSource`, and a hand-rolled reader is directly testable
  by mocking `fetch` to return a `ReadableStream` body with zero real
  network/timers. Reconnects on any stream end/error with
  `Last-Event-ID` set to the last message id seen, except on a 401
  (reuses `lib/api.ts`'s `UnauthorizedError` so `ChatPage`'s existing
  `handleAuthError` path keeps working unmodified) — an unauthenticated
  stream cannot recover on its own, so it stops rather than hammering
  the endpoint. `close()` aborts the in-flight fetch/reader and clears
  any pending reconnect timer; idempotent.

  New test file `apps/dashboard/src/lib/realtime.test.ts` (6 tests, fake
  timers + a mocked `fetchImpl`): delivers a message frame, ignores
  heartbeat/comment frames, reconnects with `Last-Event-ID` and delivers
  no dupes, `close()` stops further reconnects, a non-ok response
  surfaces via `onError` and still reconnects, a 401 surfaces via
  `onError` as `UnauthorizedError` and does **not** reconnect.

  **`apps/dashboard/src/pages/ChatPage.tsx`**: removed the
  `POLL_INTERVAL_MS` `setInterval` effect and `pollThreadIdRef`
  entirely; added a `useEffect` keyed on `activeBotId` that opens
  `subscribeToThreadMessages` for the active thread and closes it on
  thread switch/unmount (the effect's cleanup — mirrors the old
  `clearIntervalSpy` cleanup discipline this codebase already held
  itself to, now against `AbortController.prototype.abort`). Pushed
  messages upsert into `messagesByBotId` by id (so a message that
  arrives via both the initial `GET` and a slightly-overlapping push
  is not duplicated), and still flip `isBotResponding` off the same way
  the old poll did — off the first *pushed* bot message newer than
  `pendingSinceRef`. `GET /threads/:id/messages` itself is completely
  untouched — still the only thing driving the initial transcript load
  on thread switch (AC4).

  Updated `apps/dashboard/src/pages/ChatPage.test.tsx`: replaced the old
  "sends a message, polls, stops polling" test with one that pushes the
  bot's reply over a mocked SSE stream and asserts zero extra
  `GET /threads/:id/messages` calls happen after the push (no
  polling survived). Added a new "closes the stream's connection on
  unmount" test using an `AbortController.prototype.abort` spy (AC2).
  Gave the other three existing tests (thread load, approval-grant flow,
  RightPanel roleId threading) a stub `/threads/thread-1/stream` handler
  returning a never-closing empty stream, since `ChatPage` now always
  opens one for the active thread — without it those tests were
  triggering unhandled 404s → onError → reconnect churn in the
  background (harmless to assertions but noisy/wasteful).

## Test Evidence

- `services/control-api`: `pnpm exec vitest run` → **130 passed** (8
  files), including the new `src/sse.test.ts` (4/4).
- `apps/dashboard`: `pnpm exec vitest run` → **83 passed** (18 files),
  including `src/lib/realtime.test.ts` (6/6) and the updated
  `src/pages/ChatPage.test.tsx` (5/5).
- `pnpm -r build` (whole repo): all 17 buildable packages/services,
  exit 0. (One pre-existing stale-`dist/` issue in `services/worker` —
  `deliverBotToBotMessage` missing from its compiled `dist/index.d.ts`
  — was fixed by rebuilding that package; not a code change, and outside
  this task's `Owned_Paths`.)
- `pnpm -r test` (whole repo, per the CLAUDE.md amendment requiring the
  full recursive suite): run twice. Every run showed 100% green in
  every package/service this task touches
  (`services/control-api`, `apps/dashboard`). Two *different*,
  unrelated real-Postgres tests flaked across the two full runs —
  `evals/harness`'s `CAN-03` (5s `spawnSync` timeout) and
  `services/worker`'s `registerCapabilities` idempotency test on the
  first run; `packages/approvals`'s `editApproval.test.ts` "refuses
  granted/rejected/..." on a second full run — each passing cleanly
  both in isolation and on the other full run. This is resource
  contention from many workspaces hitting the same compose Postgres in
  parallel, not a regression from this task: none of those three files
  are anywhere near this task's `Owned_Paths`, and this branch never
  touches `packages/approvals`, `services/worker`, or `evals/harness`.
- `pnpm exec tsc --noEmit` clean in both `services/control-api` and
  `apps/dashboard`.

## Status

Handing to `needs_review`. Artifacts: `services/control-api/src/app.ts`,
`services/control-api/src/sse.test.ts` (new),
`apps/dashboard/src/lib/realtime.ts` (new),
`apps/dashboard/src/lib/realtime.test.ts` (new),
`apps/dashboard/src/pages/ChatPage.tsx`,
`apps/dashboard/src/pages/ChatPage.test.tsx`.
