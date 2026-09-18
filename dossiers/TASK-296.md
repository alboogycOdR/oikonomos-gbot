# TASK-296 — Sandbox office lifecycle: reap orphaned/idle offices, server-side TTL, pause-on-failure, liveness

## Work Log

- [2026-09-18T19:05:00Z] [S5] Session start. Checkpoint at `.devteam/CHECKPOINT.md` pointed at TASK-293, but
  PLAN.md (re-read fresh) and the dispatch prompt both assign this session TASK-296 (`Status: claimed`,
  `Assigned_To: S5`, `Branch: task/TASK-296-s5`, no Review_Findings — fresh task). Confirmed TASK-293 was
  already reviewed/merged upstream (`f7692f3 chore(review): TASK-293 approved and merged [ORCH]` on
  `mainco/master`). Worktree was sitting on the old `task/TASK-293-s5` branch with stale uncommitted local
  drift in `PLAN.md`/`AUTOPILOT_LOG.md` (old SESSION_END log lines from a prior compacted session, never
  committed) — discarded via `git restore` (never touched by me, not part of my Owned_Paths, safe to drop
  since they were uncommitted and predate the real merged state). Created `task/TASK-296-s5` fresh off
  `mainco/master` (`git checkout -b task/TASK-296-s5 mainco/master`).

- [2026-09-18T19:15:00Z] [S5] Read TASK-296's Spec_References: ADR-010 (persistent office — do not
  destroy-after-run), ADR-005 (liveness assertion required), `infra/sandbox/README.md:120` (server-side TTL
  reaping verified live: `timeout: 120` → gone after its window). Read `chatRunDriver.ts` end to end for
  both lanes (`executeSandboxChatRun`, `executeGeminiChatRun`, `resolveRoleSandbox`), `packages/db/src/
  roleSandboxes.ts` (existing `getRoleSandbox`/`upsertRoleSandbox`/`updateRoleSandboxState`, `last_used_at`
  indexed but unread by anything), `018_role_sandboxes.up.sql` (`role_id REFERENCES roles(role_id) ON
  DELETE CASCADE` — confirms a hard-deleted role's `role_sandboxes` row disappears atomically), `roles.ts`
  (`status` soft-delete vocabulary: active/hidden/deleted, `retireRole`), and `scripts/db-cleanup.mjs`
  (confirms it hard-`DELETE`s `roles` rows for fixture tenants and does NOT call the sandbox API — this is
  the exact mechanism that leaves a physical OpenSandbox container behind with no DB row, per the task
  description's "orphan class with no DB row at all").

- [2026-09-18T19:30:00Z] [S5] Verified the real OpenSandbox server's `GET /v1/sandboxes` list endpoint
  exists (Tailscale reachable from this session: `curl http://100.78.70.2:8080/openapi.json` succeeded).
  Confirmed live, not guessed: `list_sandboxes_v1_sandboxes_get`, query params `state[]`/`page`/`pageSize`
  (max 200), response `ListSandboxesResponse{items: Sandbox[], pagination: PaginationInfo}`. Also confirmed
  `GET /v1/sandboxes/{id}` documents a real `404` for "not found" — this matters later (see the
  `destroySandboxIfLive` 404-swallow below). Deleted the scratch `openapi_scratch.json` after use (not
  committed, not part of Owned_Paths, same convention TASK-142's dossier documents for the same probe).

- [2026-09-18T19:45:00Z] [S5] **Ownership-conflict avoidance, documented since it shaped the design:**
  `PLAN.md`'s `Owned_Paths` for this task lists `packages/db/src/roleSandboxes.ts` but NOT
  `packages/db/src/index.ts` (the package barrel). A first draft added `listReapCandidates`/
  `deleteRoleSandbox`/`roleIsLive` to `roleSandboxes.ts` for the reaper's DB-side queries — but the reaper
  lives in `services/worker` and can only reach `@oikonomos/db` through its barrel export (`exports` map in
  `packages/db/package.json` is `"."`-only, no subpath imports), which those new functions would need and
  which I cannot touch. Reverted that draft entirely (`roleSandboxes.ts` is byte-identical to its
  pre-session state — see `git diff` for this task showing no changes to that file) rather than leave dead,
  unexported code behind. Redesigned the reaper to compose ENTIRELY from primitives already exported today
  — `listRoles`/`getRole` (roles.ts) plus `getRoleSandbox`/`updateRoleSandboxState` (roleSandboxes.ts) —
  iterating tenant roles instead of a bulk `role_sandboxes` join. One extra round trip per role instead of
  one query; acceptable for a periodic maintenance sweep, never on a request's hot path. Full rationale is
  in `sandboxReaper.ts`'s own module comment. Same class of gap also hit `chatRunDriver.test.ts` (not in
  Owned_Paths, would otherwise be the natural home for the release-on-failure regression test) — resolved
  by using `chatRunDriver.ts`'s own existing in-source `if (import.meta.vitest)` test block instead, which
  IS in Owned_Paths, and by adding `listSandboxes` to `SandboxClient` as OPTIONAL rather than required (a
  required addition broke 8 existing typed fixtures in that unowned test file at typecheck).

- [2026-09-18T20:15:00Z] [S5] Implemented, in Owned_Paths order:
  - `packages/sandbox-client/src/types.ts` — `ListSandboxesRequest`/`SandboxPaginationInfo`/
    `ListSandboxesResponse`, field names transcribed from the live server's own `openapi.json` (verified
    session, not guessed).
  - `packages/sandbox-client/src/client.ts` — `listSandboxes(request?)` (optional on the interface, see
    above), query-string building (`state` repeats per key for OR logic, matches the server's documented
    behaviour), `isListSandboxesResponse` shape guard mirroring the existing `isSandbox` pattern.
  - `services/worker/src/sandboxReaper.ts` (new) — `runSandboxReaperSweep` (the two-pass sweep: role-driven
    idle/deleted reap, then server-side orphan reconciliation via `listSandboxes` + `metadata.roleId`),
    `withSandboxRelease` (shared release-on-failure helper for both chat lanes), `createSandboxReaperScheduler`
    (plain `setInterval`, `unref()`'d, not a durable pg-boss schedule — this sweeps state that only exists
    while chat turns are actually running, nothing to catch up across a restart). Constants
    `DEFAULT_SANDBOX_IDLE_MS` (3 days) and `DEFAULT_SANDBOX_REAP_INTERVAL_MS` (15 min), both justified inline.
    In-source tests (`import.meta.vitest`) cover the two DB-free pure helpers (`destroySandboxIfLive`'s
    404-swallow-vs-rethrow, `listAllSandboxes`'s pagination).

- [2026-09-18T21:05:00Z] [S5] Implemented all remaining pieces: `chatRunDriver.ts` — `SANDBOX_SERVER_SIDE_TTL_SECONDS`
  (14 days, justified inline, deliberately >> the reaper's own idle window so the app-level sweep always wins
  first in normal operation) wired into `createSandbox`'s `timeout`; both lanes now wrap their sandbox-touching
  call in `withSandboxRelease` (Claude: `runCommand`; Gemini: `adapter.run`). Hit and fixed a real TypeScript
  inference gap along the way: `composed.gemini` resolves structurally to `any` at that call site (a pre-existing
  `composeHarness` generics gap in `packages/harness-factory` — NOT touched, outside Owned_Paths and a
  CLAUDE.md protected path), which surfaces through a generic function as `unknown` (TS's deliberate
  any→unknown-for-generics anti-contamination behaviour) rather than being silently absorbed the way a direct
  `any` consumption always was before. Fixed by annotating the callback's own return type at that one call site
  rather than touching harness-factory. `main.ts` — wired `createSandboxReaperScheduler`, gated on
  `SANDBOX_INTEGRATION_URL` being set, into the boot/stop sequence.
  - `sandboxReaper.ts` — added `TERMINAL_ROLE_SANDBOX_STATES` skip in the main sweep loop after finding a REAL
    bug during testing: without it, a soft-deleted role's `status` never reverts, so every future sweep would
    re-"reap" (and re-hit the real OpenSandbox API for) the same already-terminated office forever, corrupting
    the liveness evidence with stale counts and wasting API calls against an already-gone container.
  - `chatRunDriver.ts`'s own in-source `if (import.meta.vitest)` block — added a real DB-backed integration test
    proving the Claude lane releases the office when `runCommand` throws (`pauseCalls === 1`,
    `getRoleSandbox(...).state === "Paused"` after a rejected promise). Gemini-lane release is covered by
    `withSandboxRelease` being the literal same function, tested directly (both throw and success paths) in
    `sandboxReaper.test.ts` against a real DB.
  - `services/worker/src/sandboxReaper.test.ts` — 13 integration tests: idle reap / not-reaped-when-recently-used
    / soft-deleted reap / orphan reconciliation with no DB row / never-touches-a-live-role / one bad reap doesn't
    abort the sweep / 404-is-success-not-error / `withSandboxRelease` throw+success paths against the real DB /
    a direct HTTP-shape test of `listSandboxes` via `createSandboxClient` + injected `fetchImpl` (covers what the
    unowned `packages/sandbox-client/test/**` can't) / the scheduler's ADR-005 liveness assertion (real interval
    tick, real non-zero sweep evidence, not just "didn't throw").
  - **Real test-isolation bug found and fixed during this session**: my first draft shared one `tenantId` across
    all 13 tests. `runSandboxReaperSweep`'s Pass 1 scans every role in a tenant, so later tests saw earlier
    tests' already-reaped roles and re-processed them, corrupting counts (`reapedDeletedRole` off by exactly the
    number of previously-deleted-role fixtures still in the tenant). Fixed by giving every test its own tenant
    (`freshTenant(label)`); the `TERMINAL_ROLE_SANDBOX_STATES` production fix above independently would have
    masked most of this too, but per-test tenants is the correct isolation regardless.

- [2026-09-18T21:20:00Z] [S5] **Environment hazard found, NOT caused by this task's diff, NOT fixed by
  me (shared machine infrastructure, outside any Owned_Paths):** this workstation has
  `OIK_DEFAULT_ROLE_PROVIDER=gemini` set at BOTH User and Machine environment-variable scope. Verified via
  `[Environment]::GetEnvironmentVariable("OIK_DEFAULT_ROLE_PROVIDER", "Machine"|"User")` → `gemini` on both.
  `resolveRoleRuntime` (`packages/db/src/roles.ts`) falls back to this env var whenever a role has no explicit
  `provider` column set, which `chatRunDriver.ts`'s own in-source `beforeAll` fixtures deliberately never set
  (relying on the documented "claude" default) — with the env var live, EVERY test in that describe block that
  doesn't inject `queryFn`+expect the local path was silently routed to the Gemini lane instead, which for tests
  with no `sandboxClient` override hit the REAL `productionSandboxClient()` and a real (failing)
  `SANDBOX_INTEGRATION_URL` call. This reproduced on tests that predate this session's diff entirely (e.g.
  "records spend from a genuine-shaped SDK result on the local queryFn path"), so it is unrelated to TASK-296's
  changes — flagging for ORCH/Alister since it silently breaks this file's ENTIRE existing in-source suite for
  any session run on this box until the machine/user env var is corrected, which is shared-infrastructure and
  outside any builder's Owned_Paths to touch. Worked around for THIS session's own verification only by setting
  `$env:OIK_DEFAULT_ROLE_PROVIDER = "claude"` at PowerShell PROCESS scope (child-process-only, never touches the
  persisted User/Machine value, never affects any other concurrent session on this machine) before invoking
  `scripts/test-isolated.ps1`. With that override: all of `chatRunDriver.ts`'s own in-source tests (including
  the two new TASK-296 ones) and all 13 of `sandboxReaper.test.ts` passed. Remaining failures under the process
  -scoped override are pre-existing, unrelated to this diff, and match this repo's own documented "shared
  compose-Postgres/concurrent-subprocess contention" class (CLAUDE.md amendment, TASK-142 dossier): pg-boss
  connection-close timeouts in `jobs/workerJobQueue.test.ts`/`jobs/routineJob.test.ts`, and
  `CapabilityEnabledDriftError` in the separate (unowned) `chatRunDriver.test.ts` file's MCP-governed-run suite —
  none of these touch any file in this task's `Owned_Paths`.

- [2026-09-18T21:30:00Z] [S5] Checkpoint: lint clean (`pnpm lint` — 0 errors, 3 pre-existing unrelated
  warnings). `pnpm --filter @oikonomos/worker typecheck`/`build` and `@oikonomos/sandbox-client`
  typecheck/build all clean. `@oikonomos/worker` package tests pass (with the `OIK_DEFAULT_ROLE_PROVIDER`
  process-scope workaround noted above) including all 13 new `sandboxReaper.test.ts` cases and both new
  `chatRunDriver.ts` in-source cases. Full recursive suite (`scripts/test-isolated.ps1`, no `-Filter`) is
  running now in the background per CLAUDE.md's "always run the FULL recursive suite" amendment and this
  task's own AC6; will record its result before moving to `needs_review`.

## Next steps (this session, not yet done)
- Wire `withSandboxRelease` into both `chatRunDriver.ts` lanes (Claude: around `runCommand`; Gemini: around
  `adapter.run`), replacing the bare `pauseSandbox`/`updateRoleSandboxState` calls that currently sit after
  a possible throw (Claude) or don't exist at all (Gemini).
- Add `timeout` to the `createSandbox` call in `resolveRoleSandbox` with a justifying comment (server-side
  TTL backstop, deliberately much larger than the idle window so the app-level sweep always wins first
  under normal operation).
- Add the release-on-failure test to `chatRunDriver.ts`'s own in-source vitest block (both lanes: a turn
  that throws still releases the office).
- `services/worker/src/sandboxReaper.test.ts` (new, DATABASE_URL-gated integration suite): idle role
  reaped / active-recently-used role NOT reaped / soft-deleted role reaped / orphan-with-no-DB-row
  reconciled via `metadata.roleId` / a real `listSandboxes` HTTP round trip via injected `fetchImpl` (since
  I cannot add a unit test to the unowned `packages/sandbox-client/test/sandboxClient.test.ts`, this file
  gives that method its only direct HTTP-shape coverage) / the scheduler's liveness assertion (real interval
  tick emits non-zero sweep evidence, not just "didn't throw").
- Wire `createSandboxReaperScheduler` into `services/worker/src/main.ts`, gated on `SANDBOX_INTEGRATION_URL`
  being set (mirrors `chatRunDriver.ts`'s own `productionSandboxClient` gate) so local/dev boots without it
  don't throw.
- Run full recursive suite via `scripts/test-isolated.ps1` (never a direct `DATABASE_URL`, per the
  2026-09-15 incident this task's own AC calls out) before `needs_review`.

- [2026-09-18T21:40:00Z] [S5] New session resumed on the existing `task/TASK-296-s5` branch (checkpoint at
  `.devteam/CHECKPOINT.md` was stale, pointing at the already-merged TASK-293; PLAN.md re-read fresh confirms
  TASK-296 `Status: claimed`, `Assigned_To: S5`, no `Review_Findings` — fresh task, this dossier's own "Next
  steps" section was stale too, everything it listed was already implemented per the Work Log above). Deleted
  the stale checkpoint file (untracked, `.devteam/` not under git). Verified working tree: all of TASK-296's
  Owned_Paths changes present but UNCOMMITTED (`packages/sandbox-client/src/{client,types}.ts`,
  `services/worker/src/{chatRunDriver,main}.ts` modified; `services/worker/src/sandboxReaper.ts` +
  `sandboxReaper.test.ts` untracked-new). Reviewed the diffs end-to-end against all 5 acceptance criteria —
  matches: AC1 (idle+deleted-role reap, both directions tested), AC2 (orphan reconciliation via
  `metadata.roleId`), AC3 (`SANDBOX_SERVER_SIDE_TTL_SECONDS` justified inline), AC4 (`withSandboxRelease`
  wraps both lanes, throw-still-releases test present), AC5 (`SandboxSweepSummary` counts are the liveness
  evidence, `onSweep` wired in `main.ts`). Left `dossiers/TASK-286.md`/`TASK-287.md`/`TASK-293.md` untracked
  and untouched — leftover from prior sessions' worktree state, not committed anywhere, not this task's
  dossier, outside anything I own. Launched the full recursive suite (`scripts/test-isolated.ps1`, no
  `-Filter`) in the background with `$env:OIK_DEFAULT_ROLE_PROVIDER = "claude"` at PowerShell process scope
  (the machine/user-level env var override this dossier's 21:20 entry documents as pre-existing shared-infra
  drift, worked around per-process only, never touching the persisted value) to get a clean baseline before
  committing and moving to `needs_review`.
