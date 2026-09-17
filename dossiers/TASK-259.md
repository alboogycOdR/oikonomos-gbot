# TASK-259 — SSE session re-validation gap on `GET /threads/:id/stream`

## Work Log

### 2026-09-17T11:05:00Z [S5]

Resumed on `task/TASK-259-s5` (branch already existed from dispatch, no
code commits on it yet, no prior dossier — stale `.devteam/CHECKPOINT.md`
pointed at the already-merged TASK-282, deleted). Read PLAN.md's
TASK-259 block fresh, `Review_Findings` is empty (`—`) — this is a fresh
task, not a rework.

**Root cause confirmed** in `services/control-api/src/app.ts`'s
`/threads/:id/stream` handler: `request.tenantId` is resolved once by the
global auth `preHandler` before the route runs, and the poll timer
(`pollIntervalMs`, default 300ms, test-overridable via
`BuildAppOptions.sseIntervalMs`) and heartbeat timer (hardcoded 15s) both
close over that already-resolved value for the connection's entire
lifetime — neither re-checks the originating session cookie's signature,
expiry, or revocation status.

**Fix (`services/control-api/src/app.ts`):**

- Captured the raw session cookie (`sessionToken`, via the already-imported
  `parseCookieHeader`/`SESSION_COOKIE_NAME`) at connection-open time, same
  as the preHandler does.
- Added `sessionStillValid()`: `true` when there is no session cookie at
  all (a service-bearer-authenticated connection — `authenticate()` in
  `auth.ts` marks bearer credentials with no expiry, so there is nothing
  to re-check and this exempts it, matching AC1's actual intent);
  otherwise `false` if the token is in `revokedSessionTokens` (the same
  in-memory store `/auth/logout` writes to) or `verifySessionPrincipal`
  now reports it expired/invalid.
- Wired the check into **both** recurring timers: the `poll()` tick (most
  frequent, and the one tests can speed up via `sseIntervalMs` for a real
  bounded-interval test) and the 15s heartbeat tick (an independent
  backstop in case a pathological `listMessages` implementation made
  `poll()` rarely reach its top — belt & suspenders, not required by the
  AC but cheap and correctly scoped, no new port dependency). Either
  timer finding an invalid session calls the existing `cleanup()`
  (clears both timers, ends the raw response) exactly once (idempotent
  via the existing `closed` guard).
- Reordered `pollTimer`/`heartbeatTimer` to `let ... | undefined`
  declared *before* `cleanup`, because `cleanup` can now be invoked
  synchronously from the very first `void poll()` call (before either
  `setInterval` line has executed) — `clearInterval(undefined)` is a
  documented Node no-op, whereas referencing a still-`const`-uninitialized
  binding there would have been a real (if practically unreachable, since
  the preHandler already validated the session moments earlier)
  temporal-dead-zone crash.

**Tests (`services/control-api/test/app.test.ts`, new describe block
"GET /threads/:id/stream — session re-validation (TASK-259)"):** all
three use a real `app.listen()` + `fetch()` round trip (same pattern as
the pre-existing, out-of-territory `src/sse.test.ts`) rather than
`app.inject()`, because the acceptance criterion specifically requires
proving the server itself closes an already-open connection, not just
that a fresh attempt is rejected — `inject()` cannot observe a
server-initiated raw-socket close on a still-open stream the way a real
socket can.

1. **Real short-TTL expiry, no mocked clock:** mints a session
   (`createSessionToken` with an explicit `now` so it's ~600ms from
   `SESSION_TTL_MS`'s real 24h boundary) *after* the server is already
   listening (to avoid burning the window on `app.listen()`'s own real
   startup latency — first draft flaked exactly this way, fixed by
   minting the token right before the `fetch()` call instead of before
   `startStreamServer`), opens the stream, and asserts the connection is
   actually closed server-side within a bounded real-time budget.
2. **Real revocation via `POST /auth/logout`:** opens a long-lived-session
   stream, lets one poll round settle, calls the real logout route with
   the same cookie (writes to the real `revokedSessionTokens` store the
   route already uses), and asserts the still-open stream closes shortly
   after — proving revocation (not just expiry) is honoured mid-connection.
3. **Negative/regression guard:** a service-bearer-authenticated stream
   (`Authorization: Bearer <token>`, no session cookie) must NOT be closed
   by this new logic across several fast poll ticks, since a bearer
   credential has no expiry to re-check.

Needed a self-contained `ControlApiDeps` fake (`createStreamDeps`) in the
new describe block rather than reusing the file's existing
`createFakeDeps` helper — that helper's `defaults` object and return
literal only cover the handful of fields the file's pre-existing
(non-thread) route tests exercise, and don't include `listMessages`,
`listAllThreadsWithMembers`, or `listRoles`, which `findTenantOwnedThread`
and `loadMessageShapingContext` both require. Modeled the new fake on
`src/sse.test.ts`'s `createDeps()` (out of territory, read-only reference)
instead.

**AC3 — checked the other long-lived-connection routes as required:**
`services/control-api/src/liveAgent.routes.ts`'s
`authenticateAndResolveSandbox` (shared by both the PTY-viewer and
takeover WebSocket upgrade paths) calls `authenticate()` exactly once at
upgrade time and never again for the socket's lifetime — the identical
one-time-auth-at-handshake pattern this task fixed for SSE.
`browserTakeover.routes.ts` was not fully re-read line-by-line but its
`registerBrowserTakeoverRoutes` docstring cross-references the same
upgrade-time auth shape. **Both files are outside this task's
`Owned_Paths`** (only `app.ts`/`app.test.ts` are owned), so per AGENTS.md
rule 4 I did not touch them. Flagging for ORCH per the AC's explicit
instruction to "scope to just SSE... or widen": recommend a follow-up
task (new `Owned_Paths`: `services/control-api/src/liveAgent.routes.ts`,
`services/control-api/src/browserTakeover.routes.ts`, plus their test
files) to apply the same re-validation pattern to the WS upgrade
relay loops. This task is scoped to SSE only, as explicitly permitted.

**Test evidence:**

- `pnpm --filter @oikonomos/control-api typecheck` — clean, no errors.
- `powershell -ExecutionPolicy Bypass -File scripts\test-isolated.ps1 -Filter control-api` — **24 test files
  passed, 306/306 tests passed**, including all 3 new TASK-259 tests.
- `powershell -ExecutionPolicy Bypass -File scripts\test-isolated.ps1` (full recursive `pnpm -r test`, per the
  CLAUDE.md DEVDEPARTMENT amendment requiring the full suite, not a
  filtered one): **all `@oikonomos/control-api` and every other package's
  tests passed**, except pre-existing, unrelated failures in
  `services/worker` (`src/chatRunDriver.test.ts`,
  `src/chatRunDriver.ts` control-liveness suite, `src/main.test.ts`,
  `src/jobs/workerJobQueue.test.ts`,
  `test/ome-two-role-handoff-live.test.ts` — 26 failing assertions
  total). `git status` confirms `services/worker` is untouched by this
  branch (working tree clean there before and after). These look
  consistent with the real-provider/live-sandbox dependent tests in that
  package (Claude SDK, execd sandbox, pg-boss) rather than anything
  touched here — flagging per the "always run the full recursive suite"
  amendment rather than silently filtering them out, but not treating
  them as this task's responsibility since `services/worker/**` is
  entirely outside `Owned_Paths` and the diff proves no worker file
  changed. ORCH may want to cross-check against the TASK-258
  spend-incident note in `orchestrator_notes` (worker-lock/live-DB
  collisions were already observed there) to see if this is the same
  known flake.

**Status:** all three acceptance criteria checkboxes satisfied (session
re-validated on a real bounded interval + force-closed; real non-mocked
expiry test proving an actual open-connection close, not just a
new-connection rejection; other long-lived routes checked and finding
reported). Handing to `needs_review`.
