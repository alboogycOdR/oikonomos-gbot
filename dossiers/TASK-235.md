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
