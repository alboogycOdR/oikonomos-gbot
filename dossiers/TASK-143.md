# TASK-143 — OIK-110/111 per-routine budgets + platform spend ceiling (Codex/Grok subprocess path only)

## Preflight (c8b9872 filesystem check)

```
[preflight] TASK-143 Owned_Paths inspected in E:/DELL-PROJECTS/wt-s5-GROKBOT-CLONE
[preflight] 9 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  NEW    packages/db/src/spend.ts  -> does not exist; parent packages/db/src/ exists
  NEW    packages/db/src/spend.test.ts  -> does not exist; parent packages/db/src/ exists
  FILE   packages/db/src/index.ts  -> exists, 146 line(s), 3122 bytes
  GLOB   infra/postgres/migrations/**  -> 22 file(s) (…001 through 011…)
  GLOB   packages/broker/src/**  -> 20 file(s) (…builtinTools.ts, capabilityRegistry.ts, decision.ts, describe.ts,
           enforcementGate.ts, index.ts, …)
  FILE   services/worker/src/executeRun.ts  -> exists, 365 line(s), 12958 bytes
  NEW    services/worker/src/executeRun.test.ts  -> does not exist; parent services/worker/src/ exists
  FILE   services/worker/src/subprocessProviders.ts  -> exists, 30 line(s), 1170 bytes
  NEW    services/worker/src/subprocessProviders.test.ts  -> does not exist; parent services/worker/src/ exists
```

Note: my worktree's local `PLAN.md` was initially stale (still carried
`chatRunDriver.ts`/`chatRunDriver.test.ts` in Owned_Paths from before the
2026-09-05 re-scoping). Confirmed against the main checkout
(`E:/DELL-PROJECTS/GROKBOT-CLONE/PLAN.md`) that the current, authoritative
Owned_Paths is the 9-entry list above (no `chatRunDriver.ts`). Reset my
branch to `mainco/master` tip (`49c6cd7`) before starting so my worktree's
`PLAN.md` read matched main. Re-ran preflight after the reset — output
matches above.

## Session summary

Session-start housekeeping: found stray uncommitted changes in
`AUTOPILOT_LOG.md` / `apps/mobile/pubspec.lock` in the worktree from a prior
session (not in this task's Owned_Paths) — discarded with `git checkout --`
before branching. Created `task/TASK-143-s5` from `mainco/master` (49c6cd7,
which already carries the claim commit and the re-scoped PLAN.md).

Implemented the narrowed scope (ORCH's Option 2 of 3, 2026-09-05): budget
enforcement for the Codex/Grok subprocess-routing path only. The primary
Claude-SDK chat path (`chatRunDriver.ts`) remains completely unmetered by
this task — that gap is real, loud, and tracked as TASK-163.

### Design

- **`packages/db/src/spend.ts`** (+ migration `012_spend_records`): a new
  `spend_records` table and `recordSpend` / `getRoutineSpendUsd` /
  `getPlatformSpendUsd` functions. `run_id`/`routine_id` are plain `text`,
  not FKs — `L1RunIdentity.runId` is caller-supplied and not guaranteed to
  match a `runs` row, and `routine_id` is legitimately null for a run with
  no owning routine. `getPlatformSpendUsd` defaults its window to the start
  of the current UTC calendar month (CLAUDE.md's ceiling is monthly).
  Applied the migration directly to the shared dev Postgres
  (`oikonomos-postgres-local`), same convention as TASK-156's dossier.

- **`packages/broker/src/budgetGate.ts`**: a new pure decision function,
  `resolveBudgetGate`, mirroring `enforcementGate.ts`'s split between
  policy-only decision logic and the I/O that resolves its inputs. Checks
  the platform-wide ceiling before the per-routine ceiling (the harder
  constraint: a routine within its own budget must still be denied once the
  platform-wide ceiling is breached). No `@oikonomos/db` import added to
  this package — it stays pure, matching TASK-072/enforcementGate's
  existing shape.

- **`services/worker/src/subprocessProviders.ts`**: `createGatedSubprocessProviders`
  now accepts an optional `budget` option (`{db, runId, routineId?,
  usdToZarRate?, platformCeilingZar?}`). When supplied it composes two
  things at the real construction site TASK-072 documented:
  1. `wrapGateWithBudget` — wraps the `GateSubprocess` the caller passes in
     with a **live, per-decision** budget check (TASK-140's precedent: a
     real DB read on every decision, never cached). Every subprocess spawn
     is the "next tool call" unit for this path (the CLI is handed a whole
     turn, not a per-tool broker roundtrip), so gating spawn is the correct
     live-check point. **Fails closed**: any DB-read failure, an
     unreachable Postgres, or a non-numeric/non-positive `USD_TO_ZAR_RATE`
     denies the spawn (`budget.check_failed: …`) rather than falling
     through to the real gate.
  2. `withRecordedSpend` — wraps the constructed `CodexProvider`/
     `GrokProvider` with `withBudgetSink` (packages/agent-providers,
     TASK-072) so every completed turn persists a real `spend_records` row
     via `recordSpend`.
  A routine's configured budget ceiling is read from
  `role_routines.definition.budgetUsd` (investigated per the task
  description — no dedicated column exists) via the already-exported
  `getRoutine`; `routines.ts` itself was not modified (out of
  Owned_Paths). A missing/malformed `budgetUsd` means "no configured
  ceiling" (null), not zero — a routine with no budget set is not
  zero-spend-allowed.
  Both `wrapGateWithBudget` and `withRecordedSpend` are exported (not just
  used internally) so they're directly testable without needing to spawn a
  real Codex/Grok CLI process.

### Currency/ceiling

`USD_TO_ZAR_RATE` defaults to `18.5` (`DEFAULT_USD_TO_ZAR_RATE`, documented
placeholder, not authoritative — per ORCH's currency decision). Platform
ceiling defaults to `30_000` ZAR (`DEFAULT_PLATFORM_CEILING_ZAR`, CLAUDE.md's
"Hard ceiling R30,000/month"). Both are overridable per-call via
`GatedSubprocessBudgetOptions` so a caller can wire real env vars.
Raw `costUsd` is always stored unconverted in `spend_records`; the ZAR
conversion happens only at the ceiling-comparison point, per the task's
currency decision.

### Hosting-cost / SDK-path narrowing (documented per the task's requirement)

This task enforces the **Codex/Grok subprocess inference-cost portion only**.
Hosting costs are explicitly out of scope (no telemetry exists anywhere in
this codebase). The Claude-SDK chat path is not covered at all — see the
module-level comments in `spend.ts` and `subprocessProviders.ts`, and
PLAN.md's TASK-143 scope-narrowing note / TASK-163.

## Test evidence

- `pnpm --filter @oikonomos/db build` / `test`: clean; 30 files, 150 tests
  passed, 2 skipped (unrelated pre-existing DATABASE_URL-gated skips
  elsewhere in the package). `spend.ts` inline validation block (5 tests)
  and dedicated `spend.test.ts` live-Postgres suite (4 tests: persists a
  record, sums per-routine spend isolated across routines, returns 0 for an
  unknown routine, sums platform spend since a given instant) all green.
- `pnpm --filter @oikonomos/broker build` / `test`: clean; 12 files, 127
  tests passed. `budgetGate.ts` inline suite: 7 tests (allow within both
  ceilings, allow with no routine ceiling, allow with no owning routine,
  deny routine_exceeded, deny platform_exceeded even when routine is
  within budget, platform checked before routine, rejects a negative
  input rather than silently allowing).
- `pnpm --filter @oikonomos/worker build` / `test`: clean; 14 files, 80
  tests passed, 1 skipped (pre-existing). New `subprocessProviders.test.ts`:
  10 tests — gate passthrough with no budget option, rejects a
  non-object options argument, fails closed on DB-unreachable, fails
  closed on an invalid `USD_TO_ZAR_RATE`, live: allows within a configured
  routine budget, live: denies `budget.routine_exceeded` once spend exceeds
  `budgetUsd`, live: allows a routine with no configured `budgetUsd`
  regardless of spend, live: denies `budget.platform_exceeded` once
  platform spend exceeds the ZAR ceiling at the configured rate, live:
  `withRecordedSpend` persists a real spend row on a completed turn, and a
  defaults-exposure check. Existing `executeRun.test.ts`/`chatRunDriver.test.ts`
  suites (untouched — outside/at the edge of this task's territory) still
  pass byte-for-byte.
- `pnpm -r build`: clean across all 18 buildable workspaces (apps/mobile is
  Flutter, not part of this build graph).
- `pnpm lint`: clean (`eslint .` exit 0).
- `pnpm -r test` (full recursive suite, per CLAUDE.md's DEVDEPARTMENT
  amendment — never scope to just this task's package): clean on a repeat
  run. On the first run, two tests failed that are **not touched by this
  task's Owned_Paths** and reproduce independently of my changes:
  `evals/harness/test/can-03-banned-modes.test.ts` (a `spawnSync` scanner
  hit vitest's 5000ms default timeout under `-r`'s concurrent load; passes
  in isolation and in a repeat full run) and
  `services/worker/src/jobs/workerJobQueue.test.ts`'s pg-boss poll test
  (a timing-sensitive real-pg-boss test; passes in isolation and in a
  repeat full run). Verified both pass standalone (`vitest run
  <file>`) confirming shared-Postgres contention under full recursive
  concurrency, not a regression from this task's code.
- Applied migration `012_spend_records` to the shared dev Postgres
  (`oikonomos-postgres-local`); confirmed table+indexes created. All test
  fixtures (`task-143-*` role/routine/spend rows) cleaned up by their own
  `afterAll` hooks — verified `spend_records` count is 0 for those rows
  post-suite.

## Work Log

- [2026-09-05T15:10:00Z] [S5] Session start: read AGENTS.md, briefing,
  PLAN.md fresh. Deleted stale `.devteam/CHECKPOINT.md` (belonged to a
  finished TASK-158, not this session's task). Discarded stray uncommitted
  worktree changes unrelated to TASK-143. Reset branch to `mainco/master`
  tip after discovering the worktree's local PLAN.md was stale relative to
  main (still carried `chatRunDriver.ts` in Owned_Paths). Ran preflight,
  confirmed 9-entry Owned_Paths.
- [2026-09-05T15:40:00Z] [S5] Investigated `withBudgetSink`, `executeRun.ts`,
  `compose.ts`, `subprocessProviders.ts`, `enforcementGate.ts`, `routines.ts`
  schema, and the live `role_routines`/`runs` table shapes to ground the
  design against real code rather than guessing.
- [2026-09-05T16:10:00Z] [S5] Implemented `packages/db/src/spend.ts` +
  migration 012, applied it to the shared dev Postgres. Implemented
  `packages/broker/src/budgetGate.ts` (pure decision logic). Wired both
  into `services/worker/src/subprocessProviders.ts` (live pre-spawn budget
  gate + `withBudgetSink`-based spend recording).
  Fixed one `TProvider` cast issue and one pre-existing unrelated
  `@oikonomos/connectors` stale-dist build error (fixed by rebuilding
  `connectors` first — not part of my Owned_Paths, no source change made).
- [2026-09-05T16:40:00Z] [S5] Wrote `spend.test.ts` and
  `subprocessProviders.test.ts`. Fixed test-only type errors surfaced by
  `tsc` (stricter than vitest's transform) — missing `GrokProviderOptions
  .alwaysApprove`, missing `TurnCompleteEvent.sessionId`. All package
  builds/tests green; full `pnpm -r build`, `pnpm lint`, and `pnpm -r test`
  green (two unrelated flaky tests reproduced-then-cleared per Test
  Evidence above). Committed to `task/TASK-143-s5` (5be709a). Handing off
  `needs_review`.

## Handoff

Status: **needs_review**. All 7 acceptance criteria met and independently
tested against real Postgres where the criterion calls for it. The
documented partial-coverage caveat (Claude-SDK chat path unmetered) is
recorded in this dossier, in module-level comments at
`packages/db/src/spend.ts` and `services/worker/src/subprocessProviders.ts`,
and was already recorded in PLAN.md by ORCH's scope-narrowing decision.
