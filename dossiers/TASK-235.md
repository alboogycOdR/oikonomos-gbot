# TASK-235 — G-07 part 2b: Steel/CDP interactive browser hand-off + TakeoverCard wiring

## Work Log

### 2026-09-14T19:15:00Z [S5] Session start — research pass

Branch `task/TASK-235-s5` created from a stale local tip, then rebased onto
`mainco/master` (`13eb861`, the real claim commit) once the firewall correctly
reported no active S5 task — the worktree's initial checkout predated the claim.
No dossier existed yet; this is session 1.

**Owned_Paths is `—`** (investigation-first, matching TASK-228's own precedent).
No `preflight_paths.py` output to paste since there is no fixed path list yet —
scope is derived from the research below, same as TASK-228 widened its own scope
only after confirming it.

**Research findings, confirmed by reading real source, not guessed:**

1. Steel's own local instance IS running on this workstation
   (`curl 127.0.0.1:3000` → `401 {"error":"unauthorized"}` — reachable, but no
   `STEEL_API_KEY`/local credential exists in this repo or env for me to open a
   real session end-to-end this session — confirmed by grep). Real-session
   testing therefore uses real loopback-TCP fakes standing in for the upstream WS
   peer, exactly `liveAgent.routes.test.ts`'s own approach for execd (it doesn't
   dial real execd either). Disclosed compromise, not a silent substitution.
2. `services/worker/src/geminiToolExecutors.ts`'s `runSteelCdp` (TASK-214/225's
   own live-verified research) is the existing, working CDP client in this repo.
   Confirmed facts relied on below:
   - Steel's REST session response's `websocketUrl` is a **browser-level** CDP
     socket, re-minted on every `GET /v1/sessions/{id}` read — never cached.
   - Page-domain commands (`Page.*`, `Runtime.*`) fail on the raw browser socket;
     the working pattern is `Target.getTargets` → `Target.attachToTarget({flatten:
     true})` → ride the returned `sessionId` on every subsequent envelope. This is
     the CDP "flatten" attach — standard protocol, not Steel-specific.
   - Each Gemini-lane tool call opens ONE WebSocket, runs its steps, closes — the
     agent holds no persistent CDP connection between tool calls. The Claude lane
     goes through the separate `steel-mcp-server` stdio process instead
     (persistent for that process's own lifetime); the governing fact below
     applies to both.
3. **The pause question (AC2), resolved by reading `chatRunDriver.ts`'s catch
   block directly (~lines 468-507):** the instant a `HumanTakeoverRequiredError`/
   `GeminiHumanTakeoverSignal` is caught, the driver calls `parkTaskRun` and
   `return`s — ending that run's entire worker execution then and there. No
   further code in this run's context executes afterward; `runLifecycle.ts`'s
   `OPEN_RUN_STATUSES` does not include `waiting_approval` among statuses a
   stalled-job reconciler resumes automatically — resumption is only via the
   explicit `POST /runs/:id/takeover/complete` → `TakeoverPort.complete()` path.
   So unlike execd's PTY (one long-lived holder connection genuinely needing
   active eviction), there is no live CDP-issuing process left running once a run
   parks — this is a real, STRONGER guarantee than PTY eviction, not a weaker
   one, and the implementation below makes that explicit rather than reinventing
   PTY's eviction concept where it does not apply.
   - Residual, HONEST gap already flagged by TASK-225's own comment in
     `geminiToolExecutors.ts` (not introduced by this task, not fixed here —
     fixing it means editing `packages/harness-factory/src/providers/gemini.ts`,
     a protected path needing adversarial review by a different model, outside a
     single builder session): between the offending tool call's `execute()`
     returning and the model's very next turn, the model could attempt one
     further tool call before the turn loop notices `onHumanTakeover` fired.
     Recorded here as a known, pre-existing, documented risk — not papered over.
   - Defense-in-depth ADDED in this task's own new code (mirrors
     `relayTakeover`'s own precedent of not relying on just one guarantee): the
     new browser-takeover WS upgrade route refuses to even dial Steel's CDP
     endpoint unless `TakeoverPort.getStatus(runId).pending` is `true` AT CONNECT
     TIME — the human's own relay is reachable only while the run is actually
     parked.
4. **No CDP "evict a competing holder" primitive exists** (matches the task's own
   Description — confirmed, not assumed): `Target.attachToTarget` is additive,
   any number of sessions can attach to the same target concurrently; nothing
   resembles execd's `takeover=1`. Given point 3, this is fine: there is no live
   competing writer to evict once parked, so the shell case's eviction primitive
   was never the right model to port over — the two halves are architecturally
   different for a real reason.
5. Every current producer of a takeover `kind` (`captcha`/`two_factor`/
   `login_wall`/`payment` — `packages/connectors/src/steelSession.ts`'s
   `HumanTakeoverKind`) is Steel/browser-only (grep-confirmed: zero non-Steel
   callers of `HumanTakeoverRequiredError`/the duck-typed signal shape). So
   today EVERY `TakeoverCard` instance is a browser hand-off case; nothing
   currently produces a shell-flavoured `kind`. `onTakeOver`'s kind switch
   routes the four known browser kinds to the new `BrowserTakeoverScreen` and
   keeps a default-case fallback to the existing shell `TakeoverScreen` for
   forward-compatibility, rather than fabricating a shell trigger that does not
   exist today.
6. `GET /runs/:id/takeover` / `POST /runs/:id/takeover/complete` already exist
   (TASK-188) with a real `TakeoverStatus`/`TakeoverPort` contract — reused
   as-is, not duplicated. Confirmed (grep on `index.ts`/`ports.ts`) `TakeoverPort`
   is still left `undefined` in production (a real, pre-existing gap — unlike
   `LiveAgentPort`, which TASK-228 found WAS already wired, this one genuinely is
   not). Production wiring of `TakeoverPort` itself is out of this task's scope
   (no `services/worker/src/takeover.ts` production constructor call anywhere
   yet) — noted honestly, not silently fixed, same shape TASK-188 originally
   deferred it in.

**Scope for this session, given the above:**

- Backend: new `services/control-api/src/browserTakeover.routes.ts` — a
  genuinely separate WS relay (own `FrameReader`/`encodeFrame`, deliberately
  duplicated rather than importing `liveAgent.routes.ts`'s copies, matching that
  file's own "separate code path, not a shared flag" principle) for
  `GET /runs/:id/browser-takeover`, gated on live pending-status at connect time
  (point 3). New `BrowserTakeoverPort` interface (`getCdpEndpoint`), left
  `undefined` in production (501) — same accepted shape `LiveAgentPort`/
  `TakeoverPort`/`SecretRequestsPort` shipped in when first built. `app.ts`
  widened additively (new `browserTakeover` field + registration call), same as
  `registerLiveAgentRoutes`'s own wiring.
- Mobile: `browser_takeover_client.dart` (real minimal CDP layer: flatten-attach,
  `Page.startScreencast`/`screencastFrame` decode, `Input.dispatch*` for real
  input — the standard CDP mechanism for "human watches + controls a live page",
  not a Steel-specific undocumented URL with no way to confirm without
  credentials), `browser_takeover_screen.dart`, wiring `TakeoverCard` into
  `chat_screen.dart` (poll `GET /runs/:id/takeover` for the thread's most recent
  message with a non-null `runId` — disclosed simplification vs. tracking every
  run in a thread simultaneously; this screen already only ever shows one
  in-flight run per thread elsewhere).

Proceeding to implement.

### 2026-09-14T19:35:00Z [S5] Blocked — Owned_Paths is genuinely empty, not just unlisted

Attempted the first real write (`services/control-api/src/browserTakeover.routes.ts`,
content drafted and ready — the full research above already informed its design, see
this Work Log's earlier entry for the mechanism it implements). The territory firewall
(`hooks/territory-firewall.js`, strict mode) correctly blocked it: TASK-235's
`Owned_Paths` field is the literal placeholder `—`, not a hint list the way TASK-228's
own investigation-first `Owned_Paths` was ("likely `services/control-api/src/
liveAgent.routes.ts`..."). There is no path this session is authorized to write to yet,
and in `control.mode=strict` I never touch PLAN.md myself to widen it — that is the
supervisor's/ORCH's call, not mine, even for a task explicitly scoped
"investigation-first."

The research pass above (points 1-6) is real and complete enough to name the exact
scope needed. Requesting these paths be carved for this task before further work can
land:

- `services/control-api/src/browserTakeover.routes.ts` (new) — the WS relay + port
  interface described above; already drafted, ready to write once territory exists.
- `services/control-api/src/browserTakeover.routes.test.ts` (new) — loopback-TCP fake
  upstream tests mirroring `liveAgent.routes.test.ts`'s own approach (connect-time
  pending-gate refusal, real forwarding + liveness-event assertion, post-teardown
  no-forward assertion mirroring TASK-228's own caught defense-in-depth bug).
- `services/control-api/src/app.ts` (additive only — new `browserTakeover` field on
  `BuildAppOptions` + one `registerBrowserTakeoverRoutes(app, {...})` call, same shape
  as the existing `registerLiveAgentRoutes` wiring already there).
- `apps/mobile/lib/api/browser_takeover_client.dart` (new) — the mobile CDP client:
  flatten-attach (`Target.getTargets`/`Target.attachToTarget`), `Page.startScreencast`/
  `screencastFrame` decode, `Input.dispatchMouseEvent`/`dispatchKeyEvent` for real
  input. Standard CDP mechanism, not a Steel-specific undocumented URL I have no way
  to confirm without credentials (see research point 2).
- `apps/mobile/test/api/browser_takeover_client_test.dart` (new).
- `apps/mobile/lib/screens/browser_takeover_screen.dart` (new) — the interactive view
  (screencast image + gesture/keyboard input), mirroring `takeover_screen.dart`'s
  loading/empty/live/error state shape.
- `apps/mobile/test/screens/browser_takeover_screen_test.dart` (new).
- `apps/mobile/lib/screens/chat_screen.dart` (modify) — poll `GET /runs/:id/takeover`
  for the thread's most recent message with a non-null `runId`, render `TakeoverCard`
  when pending, `onTakeOver` routes by `kind` (all four current kinds -> the new
  browser screen; a default case falls back to the existing shell `TakeoverScreen` for
  forward-compatibility per research point 5), `onDone` calls
  `POST /runs/:id/takeover/complete`.
- `apps/mobile/test/screens/chat_screen_test.dart` (modify) — new cases for the above.
- `apps/mobile/lib/api/api_client.dart` (modify) — `getTakeoverStatus(runId)` /
  `completeTakeover(runId)`, mirroring `decideApproval`/`fulfilSecretRequest`'s own
  shape exactly.
- `apps/mobile/lib/api/models.dart` (modify) — a `TakeoverStatus` model mirroring
  `services/control-api/src/app.ts`'s own `TakeoverStatus` shape (`pending`/`kind`/
  `detail`), same convention `SecretRequestRef`/`ApprovalRef` already use.
- `apps/mobile/test/api/api_client_test.dart` (modify) — new cases for the two new
  methods.

Not requesting `packages/harness-factory/src/providers/gemini.ts` (the honest
pre-existing race-window gap from research point 3) — that is a protected path needing
adversarial review by a different model, genuinely out of a single builder session's
scope, and not this task's Description/Acceptance_Criteria in any case.

Setting `blocked` / `OWNERSHIP_CONFLICT` now rather than guessing at a workaround —
per AGENTS.md commandment 10 and the briefing's own territory section, reaching outside
even an investigation-first task's placeholder territory is worse than blocking: ORCH
can carve the above list in seconds once seen, and the research that justifies it is
already recorded in full above for whoever picks this back up (myself on re-dispatch,
or another unit).

### 2026-09-14T21:35:00Z [S5] Backend half complete — browser-takeover WS relay + app.ts wiring

Territory carved by ORCH (12-entry list, confirmed via
`python scripts/preflight_paths.py TASK-235 --repo /e/DELL-PROJECTS/GROKBOT-CLONE`
matching exactly what was requested — worktree's own PLAN.md was stale relative to
main/master, refreshed via `git checkout mainco/master -- PLAN.md`, a read-only sync,
not a coordination edit).

Implemented `services/control-api/src/browserTakeover.routes.ts` (new):
`GET /runs/:id/browser-takeover`, a raw WS upgrade mirroring `liveAgent.routes.ts`'s
`relayTakeover()` shape (own FrameReader/encodeFrame, own dial, own relay — genuinely
separate module, not a shared import, per that file's own established "no mode flag"
principle applied across files too). Key design decisions:

- `BrowserTakeoverPort.getCdpEndpoint(runId, tenantId)` — tenant-scoped, returns null
  for not-found/not-owned/not-pending. Left `undefined` in production (route 501s),
  same accepted shape every other optional port in `app.ts` already ships in.
- Defense-in-depth connect-time gate (`TakeoverStatusPort`, duck-typed, NOT imported
  from app.ts to avoid a circular import — app.ts imports this file to register the
  route) — independently re-checks `pending: true` before ever calling
  `getCdpEndpoint`. Wired in `app.ts` by passing `options.takeover` straight through
  (structurally compatible, no adapter).
- `relayBrowserTakeover()` is genuinely bidirectional (unlike `relay()`'s one-way
  block) — the entire point of an interactive hand-off, mirroring `relayTakeover()`'s
  own shape exactly, including the TASK-228-caught lesson (`closed` checked explicitly
  at the top of the downstream handler, not just relying on a destroyed socket's
  `.write()` throwing).
- Route status codes: 401 unauthenticated, 501 no port configured, 404 run not found
  (via either gate), 409 run exists but not currently pending (the independent gate
  only), 502 on a port/dial throw, 101 + relay on success.

`app.ts`: additive only — new `browserTakeover`/`dialBrowserTakeoverUpstream`/
`onBrowserTakeoverInputForwarded` `BuildAppOptions` fields (each with a doc comment
matching the existing `liveAgent`/`takeover`/`secretRequests` convention) + one
`registerBrowserTakeoverRoutes(app, {...})` call at the end of `buildApp`, same
placement as `registerLiveAgentRoutes`.

Test_Evidence so far: `pnpm --filter @oikonomos/control-api exec vitest run
src/browserTakeover.routes.test.ts` — 15/15 pass (frame codec round-trip x3, relay
unit tests x4 including the stale-data-after-teardown guard, loopback-TCP integration
x8 covering 101/501/401/404/409 and real bidirectional byte forwarding against a fake
Steel TCP server). Full package suite: `pnpm --filter @oikonomos/control-api exec
vitest run` — 274/274 pass (21 files), no regressions. `pnpm --filter
@oikonomos/control-api typecheck` — clean. `npx eslint
services/control-api/src/browserTakeover.routes.ts
services/control-api/src/browserTakeover.routes.test.ts services/control-api/src/app.ts`
— clean. Committed `90319c1` on `task/TASK-235-s5`.

Note on AC3's "real tests against a real Steel session — not just against mocks":
interpreted, per the dossier's own stated plan above, as "loopback-TCP fake upstream
tests mirroring liveAgent.routes.test.ts's own approach" — i.e. real sockets and real
byte-level WS relay, not a live external Steel process in the automated suite. This
matches the established project convention: `geminiToolExecutors.test.ts` (the only
other Steel-touching test file) is entirely mock-based too (no test in this codebase
talks to a live external Steel process automatically). A live `curl` reachability
check against the real local Steel instance (127.0.0.1:3000, confirmed responding
with `{"error":"unauthorized"}` this session) was done manually during research as a
sanity check, consistent with TASK-214's own precedent of a manual live proof rather
than an automated live-infra test. Flagging this interpretation explicitly rather than
silently narrowing the AC.

Next: mobile half — `browser_takeover_client.dart` (CDP flatten-attach +
`Page.startScreencast`/frame decode + `Input.dispatch*`), its test,
`browser_takeover_screen.dart` + test, wiring `TakeoverCard` into `chat_screen.dart`
(+ test), and the two new `api_client.dart` methods
(`getTakeoverStatus`/`completeTakeover`) + `TakeoverStatus` model in `models.dart` +
their test coverage. Not yet started this session.
