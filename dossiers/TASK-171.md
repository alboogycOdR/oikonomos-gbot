# TASK-171 — Mobile live-agent/monitor view

Unit: S5. Branch: `task/TASK-171-s5`. control.mode=strict (no PLAN.md writes by me; supervisor applies state from the `devteam-control` block).

## Preflight (Owned_Paths check, pasted verbatim)

```
[preflight] TASK-171 Owned_Paths inspected in E:/DELL-PROJECTS/GROKBOT-CLONE
[preflight] 7 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  NEW    apps/mobile/lib/screens/live_agent_screen.dart  -> does not exist; parent apps/mobile/lib/screens/ exists
  NEW    apps/mobile/lib/widgets/live_agent_button.dart  -> does not exist; parent apps/mobile/lib/widgets/ exists
  NEW    apps/mobile/lib/api/live_agent_client.dart  -> does not exist; parent apps/mobile/lib/api/ exists
  NEW    apps/mobile/test/screens/live_agent_screen_test.dart  -> does not exist; parent apps/mobile/test/screens/ exists
  NEW    services/control-api/src/liveAgent.routes.ts  -> does not exist; parent services/control-api/src/ exists
  NEW    services/control-api/src/liveAgent.routes.test.ts  -> does not exist; parent services/control-api/src/ exists
  FILE   services/control-api/src/app.ts  -> exists, 2165 line(s), 89221 bytes
```

Dependencies TASK-170, TASK-183 confirmed `done` before starting.

## Substrate research

Read `docs/research/opensandbox-exec-api-gap-2026-09-05.md` §Resolution in full: execd's `/pty/{id}/ws?mode=viewer&since=0` on port 44772 inside every sandbox, reached via the lifecycle server's `endpoints/{port}?use_server_proxy=true` (never the sandbox's directly-published port). ORCH's design note says the live view is "proxied through control-api with the user's session auth" — this was taken as the fixed design, not something to re-litigate (avoided a false SPEC_AMBIGUITY block on a decision that was already made).

I do not have live access to the real execd server or its upstream `docs/components/execd.md`, so the exact `/pty/{id}/ws` message framing (plain UTF-8 text frames vs. a structured JSON envelope) is an assumption, documented here rather than guessed silently: `LiveAgentClient.watch()` treats every WS text/binary frame as raw terminal output and appends it verbatim. If execd's real wire format wraps output in JSON events (similar to `/command`'s SSE `{type, text}` shape), a follow-up task adjusts `watch()`'s frame handling — this does not change the routing/security architecture built here.

## Investigation (background agent) — key findings used

- Per-role sandbox tracking: `packages/db/src/roleSandboxes.ts`'s `getRoleSandbox`/`role_sandboxes` table, re-exported via `@oikonomos/db`. **Outside Owned_Paths** (would need `ports.ts`/`index.ts` edits) — handled the same way TASK-179 handled `ThreadContextPort`: a plain optional port on `BuildAppOptions`, real wiring deferred.
- `services/control-api/src/app.ts` is Fastify 5, all routes inlined in one `buildApp()`, no existing route-file split, no existing WebSocket precedent anywhere in the repo, and `services/control-api/package.json` has **no** `ws`/`@fastify/websocket` dependency.
- `apps/mobile/lib/screens/chat_screen.dart`'s `AppBar.actions` (lines ~443-468) has **no slot or placeholder for a live-agent button** — TASK-183 (done, merged) added the context meter and overflow menu but not this. ORCH's task note ("depends on TASK-183 only for chat_screen.dart's header slot") assumed a slot existed; it does not. **This is a real, surviving gap — see "Known gap" below.**
- Mobile conventions: plain `StatefulWidget`+`setState`, `package:http` via `ApiClient`, hand-rolled SSE reader in `realtime/sse_client.dart` as the closest live-stream precedent. No `web_socket_channel` pub dependency — but `dart:io`'s `WebSocket` class is part of the core SDK (this is a native/non-web Flutter app; `pubspec.yaml` has no web-only constraint), so **no pubspec.yaml change was needed**.

## Design decisions made in-territory to avoid three separate ownership conflicts

1. **No new npm dependency for the WS proxy.** `services/control-api/package.json` is not in `Owned_Paths`. Hand-rolled RFC 6455 framing (`FrameReader`/`encodeFrame` in `liveAgent.routes.ts`) against `node:crypto`/`node:net` only. The outbound dial to execd (`defaultDialUpstream`) uses `node:http`'s native `'upgrade'` client event — no library needed there either.
2. **No `ports.ts`/`index.ts` edit for production DB/sandbox-client wiring.** `LiveAgentPort` is defined in `liveAgent.routes.ts` and threaded through as an optional field on `BuildAppOptions` (in `app.ts`, which **is** owned) — exact precedent: TASK-179's `ThreadContextPort`. Both routes answer `501`/refuse the upgrade when the port is `undefined`, matching that precedent's interim-state contract. Real wiring (querying `role_sandboxes` via `@oikonomos/db`, resolving the execd endpoint via `@oikonomos/sandbox-client`) is real follow-up work for a task whose `Owned_Paths` includes `ports.ts`+`index.ts`, same as TASK-193 did for `ThreadContextPort`.
3. **No pubspec.yaml edit for a mobile WebSocket package.** `dart:io`'s `WebSocket` is already available; `LiveAgentClient` wraps it behind an injectable `WebSocketConnector`/`WebSocketLike` so tests never open a real socket.

## AC1 — "viewer mode cannot inject input" — enforced mechanically, not trusted

`relay()` in `liveAgent.routes.ts` decodes every downstream (mobile-viewer) WS frame and, for anything that is not a control frame (ping/pong/close), calls `onInputDiscarded` and drops the payload — it is never written to the upstream execd socket. This is independent of whatever execd's own `mode=viewer` does server-side (the task explicitly asked me to be skeptical of a claimed view-only mode, not take it on faith) — genuine defense in depth.

`onInputDiscarded` is the CLAUDE.md-mandated liveness assertion (a control that never fires is indistinguishable from one that was never wired). `liveAgent.routes.test.ts`'s third `describe` block proves this over a **real loopback TCP round trip**: a hand-rolled fake execd server, the real `defaultDialUpstream`, a real Fastify app with `registerLiveAgentRoutes`, and a hand-rolled test "mobile viewer" client — the test asserts both that the fake execd server receives zero bytes after the handshake AND that `onInputDiscarded` actually fired.

Also unit-tested directly against fake sockets (`relay()` called with fakes, no network) for fast, precise coverage of the same property plus the "still forwards real output" and "close propagates" cases.

## Debugging note kept for future maintainers

`http.Server.prototype.closeAllConnections()` does **not** reach a socket that has been handed off via the `'upgrade'` event — confirmed empirically against Node 22 with a minimal repro. `relay()`'s `teardown()` therefore calls `.destroy()` (not `.end()`) on both sockets itself; the test file also tracks accepted sockets directly (`app.server.on('connection', ...)`) and destroys them in `afterEach`, rather than relying on `closeAllConnections()`, to avoid a real ~10s test hang.

## Known gap — chat_screen.dart integration (surfaced, not worked around)

`LiveAgentButton` (`apps/mobile/lib/widgets/live_agent_button.dart`) is a complete, self-contained `IconButton` that pushes `LiveAgentScreen` — the *only* remaining step to make it "reachable from the chat header icon" per the task's own description is adding one line to `chat_screen.dart`'s existing `AppBar.actions` array (next to its `bot-settings-button` `IconButton`). **`chat_screen.dart` is not in this task's `Owned_Paths`.** ORCH's task note assumed TASK-183 had already added a slot for this; investigation confirmed it had not. I did not reach into `chat_screen.dart` to add it — that is exactly the "not one line, not just an import" rule. This is flagged for ORCH to either widen `Owned_Paths` for a one-line follow-up or fold into the next task that legitimately owns `chat_screen.dart`.

All other acceptance criteria are met and independently testable without touching that file.

## Acceptance criteria status

- [x] AC1 — PTY viewer cannot inject input, proven by test (`liveAgent.routes.test.ts`, both the direct `relay()` unit tests and the real-loopback-TCP end-to-end test).
- [x] AC2 — the mobile view shows real, live output — `live_agent_screen_test.dart`'s second test proves a real (fake-transport, not mocked-content) WS message renders in the terminal view; the real `defaultDialUpstream`/`relay()` path is proven server-side.
- [x] AC3 — traffic routes through the lifecycle proxy, never the sandbox's direct port — `LiveAgentPort.getPtyViewerEndpoint`'s contract requires the caller (the eventual production `ports.ts` wiring) to resolve via `sandbox-client`'s `getEndpoint(..., useServerProxy=true)`, exactly mirroring TASK-169/170's `use_server_proxy=true` convention; documented in the port's doc comment.
- [x] AC4 — empty state — `live_agent_screen_test.dart`'s first and fourth tests prove a clean, non-error, non-spinner empty state for both `available:false` and an unconfigured (`501`) backend.
- [x] AC5 — `pnpm -r test`/`pnpm -r build`/`pnpm lint` all exit 0 for every file I touched; `flutter analyze`/`flutter test` exit 0. See Test_Evidence below for the two pre-existing, unrelated flakes found while running the full recursive suite (reported, not hidden).

## Test evidence

- `cd services/control-api && pnpm exec vitest run src/liveAgent.routes.test.ts` — **13/13 pass** (frame codec round-trip, `relay()` input-discard/forward/close unit tests, status route 501/empty/live/401, and the real-loopback-TCP end-to-end upgrade+relay+AC1 test).
- `cd apps/mobile && flutter test test/screens/live_agent_screen_test.dart` — **4/4 pass** (empty state, live output rendering, no-write-path-exists, 501-as-empty-state).
- `cd apps/mobile && flutter analyze` — clean (0 issues), whole package.
- `cd apps/mobile && flutter test` — **116/116 pass**, whole package (my 4 + all 112 pre-existing).
- `pnpm --filter @oikonomos/control-api build` / `pnpm -r build` — all packages build clean after my change.
- `pnpm lint` (root `eslint .`) — clean.
- `cd services/control-api && pnpm exec vitest run` (whole package, no DB filter) — 217/219 pass. The 2 failures (`chat.routes.test.ts`'s group-thread test — `"sorry, too many clients already"`, and `edit.route.integration.test.ts`'s "omitting expiresAt" test) are **pre-existing Postgres-pool-exhaustion flakes**, not caused by this change: (a) I have zero diff in either test file or anything they exercise (`packages/approvals`, group-thread routes), (b) re-running `edit.route.integration.test.ts` alone passes 14/14 cleanly, (c) this matches the already-documented, already-filed flaky-real-Postgres-tests issue (PLAN.md orchestrator_notes: TASK-162 blocked/low-priority, root cause filed as TASK-199 — `packages/db`'s per-call ad-hoc pool pattern under concurrent load).
- `pnpm -r test` (full monorepo) — surfaces the same class of pre-existing flake in **packages I never touched**: `packages/db/src/messages.test.ts` (FK-violation on cleanup, reproduces in isolation, zero diff from me in `packages/db`) and `services/worker/src/jobs/workerJobQueue.test.ts` (a pg-boss scheduling-timing flake, zero diff from me in `services/worker`). Confirmed via `git diff --stat packages/db/ services/worker/` — both empty.

## Work Log

- [2026-09-06T21:55:00Z] [S5] Session start. Read AGENTS.md, briefing, PLAN.md TASK-171 block (fresh claim, no Review_Findings, no prior dossier). Ran preflight (above). Confirmed TASK-170/TASK-183 both `done`. Resynced worktree to `origin/master` (fast-forward, no own commits yet) after territory-firewall correctly rejected a write against a stale local PLAN.md copy.
- [2026-09-06T22:10:00Z] [S5] Dispatched a background investigation agent (sandbox tracking, control-api conventions, mobile conventions, chat_screen.dart header slot) rather than guessing; read `docs/research/opensandbox-exec-api-gap-2026-09-05.md` myself in full while waiting.
- [2026-09-06T22:40:00Z] [S5] Investigation returned. Identified three latent ownership conflicts (new npm dep for WS, `ports.ts`/`index.ts` for DB wiring, mobile pubspec for a WS package) and designed around all three within Owned_Paths (see "Design decisions" above) rather than reaching outside territory or blocking prematurely — each had a legitimate in-territory answer. Identified a fourth, genuine one (`chat_screen.dart`'s missing header slot) that has no in-territory answer and is reported, not worked around.
- [2026-09-06T23:10:00Z] [S5] Implemented `liveAgent.routes.ts` (hand-rolled WS framing, status route, upgrade handler, `relay()`). Wired `BuildAppOptions.liveAgent`/`dialLiveAgentUpstream`/`onLiveAgentInputDiscarded` and the `registerLiveAgentRoutes` call into `app.ts`.
- [2026-09-06T23:40:00Z] [S5] Wrote `liveAgent.routes.test.ts`. Debugged and fixed a real `~10s` test hang: `http.Server.closeAllConnections()` does not reach WS-upgraded sockets (confirmed via a throwaway repro against plain Node, deleted before committing) — fixed by having `relay()`'s teardown `.destroy()` both sockets and having the test track+destroy accepted sockets directly. All 13 tests green; full package build/typecheck/lint clean.
- [2026-09-07T00:10:00Z] [S5] Implemented mobile side: `live_agent_client.dart` (status GET + injectable-WS-transport `watch()`, no pubspec change — `dart:io`'s `WebSocket`), `live_agent_button.dart` (self-contained header button), `live_agent_screen.dart` (loading/empty/live/error states). Wrote `live_agent_screen_test.dart` (4 tests). `flutter analyze` clean, `flutter test` 116/116 (whole package).
- [2026-09-07T00:25:00Z] [S5] Ran full recursive verification: `pnpm -r build`, `pnpm lint`, `pnpm exec vitest run` in control-api (217/219 — 2 pre-existing unrelated flakes, verified via isolation re-run + zero-diff check), `pnpm -r test` (surfaces the same flake class in `packages/db`/`services/worker`, zero diff from me in either, confirmed via `git diff --stat`). Committed all Owned_Paths artifacts to `task/TASK-171-s5`. Writing this dossier and handing to `needs_review`.
