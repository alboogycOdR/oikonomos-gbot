# TASK-074 Dossier — packages/shared: named scheduling policies + digest fixture pin

## Work Log

### 2026-09-01T00:20:00Z — S5

Session start: resumed from PLAN.md `Status: claimed` (worktree PLAN.md was
initially stale at `pending`; rebased onto `mainrepo/master` to pick up the
claim commit `2838d3c`, then created `task/TASK-074-s5` off the rebased tip).
No prior dossier existed.

**Implemented:**
- `packages/shared/src/scheduling/index.ts` — five named, Clock-injected
  policies per the Description: `DeadlinePolicy`, `RetryPolicy`,
  `PollingPolicy`, `IdleWatchdogPolicy`, `DebouncePolicy`. Each: eager
  constructor validation (`RangeError`), mandatory non-empty `name`,
  `unref()`s every timer, zero runtime dependencies (`Clock`/`TimerHandle`
  interfaces + `SystemClock` using only `globalThis`/node built-ins).
  Named error classes (`DeadlineExceededError.policyName`,
  `RetryExhaustedError`, `PollingExhaustedError`) carry the policy name.
  File placed at `scheduling/index.ts` (not `scheduling.ts`) to match
  Owned_Paths `packages/shared/src/scheduling/**` — the firewall hook
  rejected a flat `scheduling.ts` write, confirming that constraint.
- `packages/shared/src/index.ts` — barrel-exports the new policies/types.
- `packages/shared/test/scheduling.test.ts` — a hand-rolled
  `RealFakeClock` (manual `advance()`, no Vitest global fake timers, per
  spec) plus per-policy behaviour and constructor-validation tests (20
  tests).
- `packages/shared/test/digestPin.test.ts` — literal-hex `canonicalJson`
  and `actionDigest` pins across the README edge-case fixtures (-0,
  unicode precomposed vs decomposed, nested, null-vs-absent, an
  intentionally-unsorted-keys fixture), plus a MUTATION-PROVEN test: a
  test-local `naiveNoSortJson()` (no `.sort()` on keys — the exact
  regression class this pin guards against) is shown to diverge from both
  the committed `canonicalJson` pin and the committed `actionDigest` pin.
  Pin values computed once via a standalone reimplementation matching
  `canonicalJson.ts`/`actionDigest.ts` exactly, run through `node -e`, and
  hardcoded as literals — not derived from the library at test-write time,
  per "computed once and committed".
- Did **not** touch `canonicalJson.ts` or `actionDigest.ts` — verified
  byte-identical to `mainrepo/master` via `git diff` (exit 0, no output).
  No SPEC_AMBIGUITY encountered — every pin matches the README's
  documented edge-case behaviour exactly.

**Test evidence:**
- `pnpm --filter @oikonomos/shared test` → 8 files, 82 tests passed.
- `pnpm -r test` (full recursive suite, all 17 workspace packages) → every
  package passed **except** `packages/harness-factory`, which fails with
  `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` due to a pnpm/corepack version
  mismatch (`packageManager: pnpm@10.23.0` vs corepack's resolved
  `v11.6.0`) — confirmed pre-existing and unrelated to this task via
  `git stash` + re-run on the clean tree (identical failure with none of
  this task's changes present).
- `pnpm typecheck` (root, `pnpm -r typecheck`) → clean, no errors.
- `pnpm lint` (root `eslint .`) → clean, no errors/warnings.
- `pnpm canaries` (`pnpm --filter @oikonomos/evals-harness test`) → fails
  identically to `harness-factory` when invoked via the nested `pnpm run`
  in the root script (corepack version-mismatch error, not a test
  failure) — but running the exact same target directly,
  `pnpm --filter @oikonomos/evals-harness test`, passes: 11 files, 15
  passed / 2 skipped. Reproduced the root-script failure on a clean
  `git stash`'d tree too — confirmed pre-existing tooling issue, not
  caused by this task's changes, and no file under this task's
  Owned_Paths can affect it.

**Status:** handing to `needs_review`. All five acceptance criteria for
the code/tests I own are met; the two `pnpm canaries`/`harness-factory`
tool-version failures are pre-existing and outside Owned_Paths — flagging
for ORCH rather than attempting a fix (would require touching
`package.json`/corepack config, outside territory).

Branch: `task/TASK-074-s5`, commit `6fb3c25`.
