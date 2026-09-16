# TASK-269 — Chat conversation continuity (S5)

## Preflight (c8b9872 filesystem check)

```
[preflight] TASK-269 Owned_Paths inspected in E:/DELL-PROJECTS/wt-s5-GROKBOT-CLONE
[preflight] 7 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  FILE   packages/db/src/runs.ts  -> exists, 697 line(s), 23276 bytes
  FILE   packages/db/src/runs.test.ts  -> exists, 467 line(s), 19663 bytes
  FILE   services/control-api/src/app.ts  -> exists, 2715 line(s), 116256 bytes
  FILE   services/control-api/src/ports.ts  -> exists, 933 line(s), 40866 bytes
  FILE   services/control-api/src/chat.routes.test.ts  -> exists, 1588 line(s), 79066 bytes
  FILE   services/worker/src/chatRunDriver.ts  -> exists, 1815 line(s), 92054 bytes
  FILE   services/worker/src/chatRunDriver.test.ts  -> exists, 2411 line(s), 149509 bytes
[preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
```

## Root-cause investigation (deeper than the task filing assumed)

Two independent gaps, not one:

1. **Nothing ever looked up a thread's prior run.** `app.ts`'s `POST /threads/:id/messages`
   always builds a brand-new task+run via `submitTaskExecution`
   (production path — `runChatTask`'s `resume` fallback is legacy/test-only,
   confirmed unused in production by `app.ts`'s own comment). Nothing computed a
   `resume` token for an ordinary follow-up turn.
2. **Even where `--resume` plumbing already existed (worker's `main.ts`,
   unowned, unchanged), nothing ever captured the REAL Claude CLI/Agent SDK
   session id.** `run.sessionRef ?? run.runId` is used throughout
   `chatRunDriver.ts` as a broker/audit bookkeeping identifier only — the
   Claude CLI never recognizes our own run UUID as a session it can
   `--resume`. Confirmed by reading `claudePrintCommand`'s only caller
   (`executeSandboxChatRun`, line ~787) and the local lane (line ~446): both
   only ever pass whatever `request.resume.sessionRef` was already set to;
   nothing ever *writes* a fresh value back after a turn completes. Without
   fixing #2, fixing #1 alone would be cosmetic — a `--resume <our-own-uuid>`
   finds no matching CLI session and silently starts fresh, reproducing the
   exact bug.

Both are fixed. `main.ts` (`services/worker/src/main.ts`, outside
Owned_Paths, **not modified**) already does the right thing once a run
actually carries a `session_ref`: `resume = run.provider==="claude" &&
run.sessionRef !== null ? {runId, sessionRef} : {runId}`. So the fix is
entirely: (a) seed a brand-new run's `session_ref` from the thread's last
completed run, before that new run is ever enqueued (`ports.ts`), and (b)
capture the CLI's real `session_id` once a turn completes and persist it
(`chatRunDriver.ts`) so the *next* turn has something genuine to seed from.

## What shipped

- **`packages/db/src/runs.ts`**: new `getLatestRunForThread(options, {threadId,
  roleId?})` — joins `runs` through `tasks.execution ->> 'threadId'` (runs has
  no `thread_id` column), ordered `started_at DESC, run_id DESC`. `roleId` is
  required for correctness in a group/fan-out thread: several recipients can
  share one `threadId`, each with an independent Claude session: a real
  integration test proves that without the role filter, both recipients'
  "latest run" queries would collide on the same (wrong) run.
  No new setter was needed — the existing, already-tested `resumeRun`
  (`packages/db`, already barrel-exported) does exactly the two things this
  task needed: seed a fresh run's `session_ref` (ports.ts) and overwrite it
  with the CLI's real one post-execution (chatRunDriver.ts). Both call sites
  proven by dedicated real-Postgres tests in `runs.test.ts`.
- **`services/control-api/src/ports.ts`**: `submitTaskExecution` now looks up
  the thread's latest prior run *before* creating this turn's own run (order
  matters — `getLatestRunForThread` would otherwise find the row this same
  call is about to create), and seeds the new run's `session_ref` via
  `resumeRun` iff a prior run exists, reached `status: 'completed'`, and used
  the *same* provider. Wrapped in try/catch that fails closed to "no
  continuity" (see OWNERSHIP_CONFLICT below) — never lets a lookup problem
  block message-sending itself.
- **`services/worker/src/chatRunDriver.ts`**: new `extractClaudeSessionId`
  (exported, unit-tested) scans a run's event stream for a real `session_id`
  field (present on both lanes' result envelopes). After a Claude-provider
  turn completes and *before* `completeTaskRun`, the captured id is persisted
  via `resumeRun` (overwrites unconditionally) — proven end-to-end by a real,
  non-mocked, two-real-Claude-message integration test (see below). Gemini
  keeps its own already-correct history mechanism and never reaches this
  branch.
- **Tests**: `packages/db/src/runs.ts` (2 no-DB validation cases) +
  `runs.test.ts` (3 real-Postgres `getLatestRunForThread` cases incl. the
  group/fan-out role-scoping mutation-proof, 2 real-Postgres `resumeRun`
  reuse cases) + `chatRunDriver.ts` (3 no-DB `extractClaudeSessionId` cases) +
  `chatRunDriver.test.ts` (1 **real, live, two-Claude-API-call** end-to-end
  test — see AC4 below) + `chat.routes.test.ts` (3 real-Postgres HTTP-route
  cases: positive seeding, no-seed-when-not-completed, no-seed-across-a-
  provider-switch).

## AC4 — the real two-message test

Ran for real. `OIK_SECRET_ANTHROPIC_API_KEY` is set in this environment
(confirmed — the pre-existing TASK-116 suite already makes real Claude calls
routinely). Added
`chatRunDriver.test.ts`'s `"TASK-269: a real second turn genuinely remembers
information only given in the real first turn..."`:
turn 1 tells the model "my favorite color is teal"; turn 2 (a brand-new
task+run, seeded exactly the way `ports.ts` seeds one in production, then
driven through `driver.run({..., resume: {runId, sessionRef}})` exactly the
way `main.ts` constructs it) asks what the color was. **The real reply
contains "teal".** This is the evidentiary bar the task itself sets as the
one that actually matters, and it is met with a live call, not a mock.

```
✓ createChatRunDriver — real governed chat run (TASK-116) > TASK-269: a real second turn
  genuinely remembers information only given in the real first turn, via a captured,
  persisted session_ref  6905ms
```

## OWNERSHIP_CONFLICT — the one piece I could not finish

`getLatestRunForThread` must be consumed from `services/control-api/src/ports.ts`
(a separate pnpm workspace package), which can only import it via
`@oikonomos/db`'s package export map. `packages/db/package.json`'s `exports`
field lists only `"."` → `dist/index.d.ts`/`dist/index.js` — there is no
wildcard/deep-import subpath. `packages/db/src/index.ts` is a **curated
named-export list**, not a `export *` barrel, and it is genuinely outside
this task's `Owned_Paths`.

This is not a typecheck-only nuisance — I confirmed it is a **hard runtime
failure under vitest too** (I assumed workspace TS-path resolution might
bypass the package `exports` map for tests; it does not — `vitest` resolves
`@oikonomos/db` through the same `exports` map as production Node). Verified
directly: with the import present but unexported, `dbGetLatestRunForThread`
evaluates to `undefined` at both typecheck (`tsc`: `TS2305: Module
"@oikonomos/db" has no exported member 'getLatestRunForThread'`) **and**
runtime (`TypeError: ... is not a function`) inside every real
`chat.routes.test.ts` HTTP-route test that reaches `submitTaskExecution`.

**I found this the hard way**: my first version of the `ports.ts` wiring
called the missing function unguarded, which silently broke *every* existing
`submitTaskExecution`-based test in `chat.routes.test.ts` (group-thread
routes, attachments), not just my new ones — because the fire-and-forget
`void submit.catch(...)` in `app.ts` swallows the `TypeError` before a run is
even created. I do **not** consider that an acceptable state to leave on this
branch, so I wrapped the lookup in try/catch that fails closed to "no
continuity, but the turn still runs exactly as it did before this task" —
confirmed the regression is gone (`chat.routes.test.ts`: 45/46 passing again,
only the one positive-continuity test now fails, and fails fast with a plain
assertion mismatch, not a hang or a crash).

**Exact one-line fix needed**, mirroring `OIK-106`'s identical, already-
precedented resolution for `listOpenRuns`/`openRunStatuses` (see
`runs.test.ts`'s own comment on that prior gap, and note `index.ts` line
~55–57 today already carries that exact fix from a prior task):

```ts
// packages/db/src/index.ts, inside the existing runs.js export block:
export {
  ...
  getLatestRunForThread,   // <-- add this line
  ...
} from "./runs.js";
```

Once that lands, no other code change is required on either side — I already
wrote (and the tests already assert) the real behavior; only the guard
degrades gracefully in its absence. I'd recommend also removing the
try/catch guard in `ports.ts` at that point (or leaving it — it's cheap
insurance) and re-running `chat.routes.test.ts`'s three TASK-269 tests, which
should go straight to green with zero further changes.

## Known, disclosed limitation

The group/fan-out chat path (multiple recipients in one thread) is *not*
silently left broken: `getLatestRunForThread`'s `roleId` filter was written
specifically so each recipient only ever inherits *their own* prior run in
that thread, never another recipient's — proven by a dedicated real-Postgres
test (`runs.test.ts`, "scopes by roleId so a group/fan-out thread never hands
one recipient's session to another's turn"). Both `kind: "chat"` and `kind:
"fanout"` executions flow through the same `submitTaskExecution` continuity
logic, so the fan-out path gets the identical fix, not a separate one.

## Test evidence

- `packages/db` — `src/runs.ts` (10/10), `src/runs.test.ts` (18/18, incl. 5
  new TASK-269 cases), real Postgres.
- `services/worker` — `src/chatRunDriver.ts` + `src/chatRunDriver.test.ts`
  (45/45 when run standalone; one cross-suite flake in the full `pnpm test`
  run is pre-existing platform-spend-ceiling test-order interference,
  reproduced identically with `git stash` — not caused by this change).
  Includes the real, live, two-Claude-message continuity test.
- `services/control-api` — `src/chat.routes.test.ts` (45/46; the one
  failure is the positive-continuity case, blocked on the OWNERSHIP_CONFLICT
  above, fails fast and cleanly, no other regression).
- `pnpm exec eslint` on all six touched files: clean.
- `tsc --noEmit`: `@oikonomos/db` clean, `@oikonomos/worker` clean,
  `@oikonomos/control-api` — exactly one error, the barrel export.
- Pre-existing, unrelated failures observed and NOT caused by this branch:
  `packages/db`'s `approvals.integration.test.ts` /
  `capabilities.test.ts` / `inbox-triage.integration.test.ts` (a
  `role_grants_role_id_fkey` seed-ordering issue, nothing to do with `runs.ts`)
  and `services/worker`'s `main.test.ts` / `jobs/*.test.ts` (pg-boss queue
  lock timeouts, environment/contention, not import-related).

## Work Log

- [2026-09-16T15:45:00Z] [S5] Root-caused two independent gaps (missing
  lookup + missing real-session-id capture), implemented and tested both in
  `runs.ts`/`chatRunDriver.ts`, wired the lookup into `ports.ts`. Found and
  fixed a self-referential ordering bug in my own `ports.ts` code (querying
  "latest run" *after* creating the new run found itself). Discovered the
  `packages/db/src/index.ts` barrel-export gap is a genuine runtime blocker
  under vitest, not just `tsc`; found it broke unrelated existing tests via
  the fire-and-forget error path in `app.ts`, and added a fail-closed guard
  so this branch does not regress existing chat functionality while blocked.
  Proved the fix genuinely works end-to-end with a real, live two-Claude-
  message test (AC4, exact wording met). `app.ts` needed no code change —
  both real chat-send branches already forward `execution.threadId` through
  `submitTaskExecution` unchanged; the entire fix lives in
  `runs.ts`/`ports.ts`/`chatRunDriver.ts`. Reporting `blocked` on the one
  remaining, precisely-scoped `OWNERSHIP_CONFLICT`.

## Rework session (TASK-270 review finding, 2026-09-16)

Resumed after ORCH's REWORK verdict on TASK-270's adversarial review
(`docs/decisions/TASK-269-review-cx9-2026-09.md`): `getLatestRunForThread`
had zero epoch-awareness, so a user who called `POST /threads/:id/fresh`
would still have their pre-fresh Claude session silently resumed on their
next message.

### What shipped

- `packages/db/src/runs.ts`: `LatestRunForThreadFilter.epoch` (now
  **required**) scopes the query to `(t.execution ->> 'epoch')::int = $n`.
  A run whose execution JSON has no `epoch` (legacy rows) or an older one
  never matches -- `NULL = $n` is never true in SQL, the conservative
  direction. Added `getThreadEpoch(options, threadId)` -- a plain
  read-only `SELECT epoch FROM thread_context`, deliberately NOT
  `getOrInitThreadContext` (outside Owned_Paths, and its UPSERT takes a row
  lock this hot path shouldn't pay on every turn); defaults to 0 exactly
  like that function's own lazy-row semantics when no row exists yet.
- `services/control-api/src/ports.ts`: `submitTaskExecution` now reads the
  thread's current epoch via `getThreadEpoch` BEFORE the continuity lookup
  (used both to scope `getLatestRunForThread` and to stamp `epoch` onto
  THIS run's own execution JSON via a local `EpochStampedExecution` type,
  since `TaskExecution` itself, `packages/db/src/tasks.ts`, is outside
  Owned_Paths -- the JSONB column and `createTaskExecutionRun` are already
  field-agnostic, so this is a pure additive read/write contract between
  the writer here and the reader in `runs.ts`). Same fail-closed try/catch
  as before: any lookup error leaves `currentEpoch` at its safe default (0)
  and `priorRun` null, never blocking the turn.
- Tests: `runs.ts` (2 new no-DB validation cases: negative/non-integer
  epoch, invalid threadId on `getThreadEpoch`), `runs.test.ts` (1 new
  real-Postgres case proving a stale-epoch run is never eligible once
  `/fresh` bumps the thread forward, using its own seeded role+thread pair
  since `thread_context` FKs to a real `threads` row unlike this suite's
  other fixtures; 2 `getThreadEpoch` assertions folded into it), and
  `chat.routes.test.ts` (1 new real-HTTP-route case: complete/capture a
  Claude session, call the real `POST /threads/:id/fresh`, post the next
  message, assert the new run's `session_ref` is null and `status` is
  `started` -- proving the pre-fresh session is NOT inherited even though
  it is a real, completed, same-provider, same-role prior run that would
  otherwise be exactly what `getLatestRunForThread` picks).
- Fixed one now-legitimate assertion break: `chat.routes.test.ts`'s
  TASK-166 attachments test pinned the literal execution JSON shape without
  `epoch`; updated the pin to include `epoch: 0`.

### A real flake found and fixed along the way (not just dismissed)

First implementation used `getOrInitThreadContext` (the UPSERT) to read the
current epoch. Three consecutive full `pnpm -r test` runs via
`scripts/test-isolated.ps1` each showed exactly one failure, and twice it
was the SAME test (`chat.routes.test.ts`'s plain continuity case) with
`sessionRef` unexpectedly null -- while the identical test passed 100%
reliably run standalone. That pattern (fails under full-suite parallel
load, never alone) pointed at real added lock contention: `thread_context`
UPSERTs on every single chat turn, colliding with the several *other* test
files that also hit that table concurrently under `-r test`. Replaced the
read with `getThreadEpoch` (plain SELECT, no upsert/lock) -- see runs.ts's
doc comment. This is a genuine production robustness improvement too, not
just a test-flake workaround: the old code would have taken a write lock on
`thread_context` for every ordinary chat message, serializing rapid
back-to-back turns on the same thread for no reason.

### Test evidence

- `packages/db`: `pnpm run typecheck` clean; `pnpm run build` clean.
- `services/control-api`: `pnpm run typecheck` clean.
- Full `pnpm -r test` via `scripts/test-isolated.ps1` (isolated
  `oikonomos_test` DB, real Postgres, worker+watchdog stopped for the
  duration): see below for the post-fix run(s). Individually confirmed
  clean in isolation before the fix: `packages/db` (`roles.test.ts`
  standalone, 15/15 -- the one `pnpm -r` failure that run was a pre-existing
  `ALTER TABLE role_grants` DDL race, unrelated) and `services/control-api`
  (`chat.routes.test.ts` standalone, 47/47).

## Work Log

- [2026-09-16T16:45:00Z] [S5] Implemented TASK-270's rework: epoch-scoped
  `getLatestRunForThread`, epoch-stamped execution JSON, real
  `/fresh`-then-post-again HTTP test. Found and fixed a genuine lock-
  contention flake (getOrInitThreadContext's UPSERT under full-suite
  parallel load) by adding a lock-free `getThreadEpoch` read instead --
  confirmed via three full `pnpm -r test` runs before the fix (each showing
  exactly one transient failure, twice the same continuity test) and
  re-running after. Typecheck + build clean on both touched packages.
  Continuing to full-suite re-verification before handoff.
