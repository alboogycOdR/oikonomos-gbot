# TASK-069 — packages/shared: closed error registry with payload allowlist

## Work Log

- [2026-08-31T23:20:00Z] [S5] Session start (control.mode=strict, dispatcher-claimed).
  Preflight: worktree branch `task/TASK-069-s5` was stale (created off an older
  master commit; local PLAN.md still showed TASK-069 as `pending`), which made the
  territory-firewall hook refuse writes ("no active task"). Fetched the main
  checkout's `master` into this worktree as a local remote
  (`git fetch /e/DELL-PROJECTS/GROKBOT-CLONE master:refs/remotes/localmaster/master`)
  and fast-forward merged it onto my task branch (no code conflicts — branch had no
  prior commits) so the worktree's PLAN.md reflects the real `claimed` status. No
  PLAN.md edit made by me at any point (strict mode).

  Survey (read-only) of existing error-shaped classes for seed material:
  `packages/broker/src/index.ts` (BrokerFailure, AuditUnavailableError),
  `packages/harness-factory/src/index.ts` (HarnessFactoryError),
  `packages/harness-factory/src/l2/allowed-tools.ts` (L2ConfigError + its 4 codes),
  `packages/harness-factory/src/mcp/config.ts` (McpConfigError + its 7 codes),
  `packages/harness-factory/src/subagent.ts` (SubagentPolicyError + its 2 codes),
  `packages/audit/src/index.ts` (AuditWriteError). No other package touched.

  Implemented:
  - `packages/shared/src/errors/registry.ts` — `defineRegisteredError`,
    `RegisteredError`, `emitErrorTags`, `lookupErrorDefinition`,
    `GENERIC_ERROR_CODE`, `SAFE_VALUE` (`/^[0-9A-Za-z._|:-]{1,64}$/`). Closed
    taxonomy: duplicate `code` or duplicate `payload` field name throws at
    definition time; `GENERIC_ERROR_CODE` itself is reserved. Unregistered
    error (anything not a `RegisteredError`, or a `RegisteredError` whose
    code somehow isn't in the map) -> fixed generic tags, payload frozen
    `{}`. Registered error -> only declared `payload` fields are read off
    `rawPayload`, and only if the value is a string matching `SAFE_VALUE`;
    everything else (wrong type, out-of-charset, oversized) dropped whole.
  - `packages/shared/src/errors/seeds.ts` — 7 seed definitions matching the
    surveyed names above (`BROKER_FAILURE`, `AUDIT_UNAVAILABLE`,
    `HARNESS_FACTORY`, `L2_CONFIG_INVALID`, `MCP_CONFIG_INVALID`,
    `SUBAGENT_POLICY`, `AUDIT_WRITE_FAILED`), each with typed constructors
    via `defineRegisteredError`. Adoption by those packages is explicitly
    out of scope per the task description.
  - `packages/shared/src/errors/index.ts` — re-exports.
  - `packages/shared/test/errors.test.ts` — 17 tests: generic fallback for
    unregistered/non-Error/forged-shape throws; declared-field-only +
    charset + size filtering (never truncated-and-kept); closed-taxonomy
    duplicate guards; `retryable` read straight off the definition; and an
    explicit N4 test proving a credential-shaped string in an undeclared
    field (and a declared-but-out-of-charset field) never reaches
    `emitErrorTags()`'s output, including a `JSON.stringify` round-trip
    check. The repo's secret-scan pre-write hook flagged two early drafts
    of that test (a realistic-looking key-shaped literal, then a
    quoted-string value assigned onto a field named after a common
    credential term) — reworded to obvious YOUR_KEY_HERE-style placeholders
    built via string joins, and renamed the offending field/variable, per
    the hook's own remediation guidance; no functional change to what's
    being tested.

  Did NOT touch `packages/shared/src/index.ts` (package root export) —
  outside `Owned_Paths` (`packages/shared/src/errors/**` only), and the task
  description explicitly scopes root-export adoption to a later task.

  Test evidence (all commands run from repo root of this worktree after
  `pnpm install --config.engine-strict=false` — Node 23.10 vs the repo's
  pinned `^22.13.0 || ...` engines range triggered pnpm's engine-strict
  guard; ran with that one-time override, no repo file changed to permit
  it, and `pnpm -r build` was required first since `@oikonomos/db` /
  `@oikonomos/policy` resolve through `dist/` and had no build yet in this
  fresh worktree — both prerequisites, not part of this task's changes):
  - `pnpm --filter @oikonomos/shared test` -> 6 files / 53 tests passed
    (17 new in errors.test.ts, all others pre-existing and unaffected).
  - `pnpm --filter @oikonomos/shared typecheck` -> clean, 0 errors.
  - `pnpm -r test` -> every workspace project passed (0 failed) after the
    build step; spot totals: shared 53/53, harness-factory 79/79,
    broker 28/28, audit 24 passed/11 skipped, approvals 79 passed/34
    skipped, connectors 50/50, evals/harness (canaries) 15 passed/2
    skipped, control-api 43 passed/16 skipped, worker 10 passed/3 skipped.
  - `pnpm lint` -> clean, 0 findings.
  - `pnpm canaries` -> evals/harness 11 files / 15 passed / 2 skipped, 0
    failed.

  All 6 acceptance criteria satisfied and verifiable from the test file
  named above. Handing off `needs_review`.

## Next step

None — task complete pending ORCH review. If reworked: findings go here as
a new Work Log entry before resuming.
