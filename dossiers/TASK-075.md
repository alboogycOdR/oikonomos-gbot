# TASK-075 — packages/db intake idempotency ledger (S5)

## Work Log

- [2026-09-01T00:46:00Z] [S5] Session start. Checkpoint at `.devteam/CHECKPOINT.md` was
  stale (referenced TASK-074, already merged) — deleted after confirming this session's
  actual assignment is TASK-075 via the dispatch prompt and PLAN.md. Worktree's own
  `PLAN.md` was behind main (still showed TASK-075 `Status: pending`); fast-forward merged
  `local-main/master` (fetched from `E:/DELL-PROJECTS/GROKBOT-CLONE`) to pick up the
  already-landed claim commit (`Status: claimed`, `Branch: task/TASK-075-s5`) — no manual
  PLAN.md edit, pure git sync, so the territory-firewall hook would recognize the claim.
  Created `task/TASK-075-s5` branch.

  Read `approvals.ts` (atomic single-statement consume pattern via
  `UPDATE ... RETURNING` + rowCount check) and `runs.test.ts` (DB-gated
  `describe.skip`-when-no-`DATABASE_URL` convention, plus the unconditional
  source-level pin pattern for assertions that must run in default CI) as the
  reference implementations. Mirrored both.

  **Design decision on the digest requirement:** the task description says
  "Digest via `packages/shared` actionDigest/canonicalJson ONLY (N10 — no
  local hashing)" and acceptance criteria require asserting no crypto import
  in `intakeNonces.ts`. `packages/db/package.json` does NOT declare a
  `@oikonomos/shared` dependency (unlike `packages/audit`/`packages/approvals`,
  which do) and `package.json` is outside this task's `Owned_Paths`. Rather
  than block on `OWNERSHIP_CONFLICT` for a one-line dependency addition, I
  designed `admitIntake(options, {tenantId, clientNonce, inputDigest})` to
  accept `inputDigest` as an already-computed value — the CALLER (a future
  gateway/control-api wiring task, which will have `@oikonomos/shared`
  available) computes it via `actionDigest`/`canonicalJson`; `intakeNonces.ts`
  itself only stores/compares the resulting string and imports no hashing
  module at all. This is consistent with "db primitive only" scope and
  keeps `packages/db/package.json` untouched. Test fixtures use
  `node:crypto`'s `createHash` directly in the TEST FILE ONLY (not
  production code) purely to generate distinct opaque digest strings for
  the ledger-mechanics tests — this is not the N10 digest binding, just
  fixture data, and is called out in a comment in the test file.

  Migration `003_intake_nonces` creates `intake_nonces(intake_id, tenant_id,
  client_nonce, input_digest, status, task_id, created_at)` with
  `UNIQUE(tenant_id, client_nonce)`. `admitIntake` is one atomic
  `INSERT ... ON CONFLICT (tenant_id, client_nonce) DO NOTHING RETURNING`
  statement; a conflict falls through to a SELECT that either confirms a
  matching digest (`duplicate`, includes original `taskId`/`status` so a
  caller can replay whatever outcome — including a rejection — the original
  attempt had) or raises `IntakeDigestMismatchError` (typed, never a silent
  dedupe) on a differing digest. `lookupIntake` is a plain nullable
  found/not-found (v1 keeps every row — no eviction policy — so the study's
  three-way "unknown-durability" outcome doesn't apply; noted in both the
  module doc comment and PLAN.md's own description already flagged this).

  Typechecked clean (`pnpm --filter @oikonomos/db typecheck`). Ran
  `pnpm --filter @oikonomos/db test` with no `DATABASE_URL` first — new file's
  unconditional pins execute, DB-gated legs correctly skip, 29 passed / 33
  skipped, 0 failed.

  **DB-gated legs, run against a REAL Postgres** (TASK-061 precedent):
  reused the existing, already-running shared local dev container
  `oikonomos-postgres-local` (`infra/compose/docker-compose.local.yml`,
  pgvector/pg16, port 5432) rather than spinning up a throwaway one — it was
  already up and migration 001 already applied. Applied
  `003_intake_nonces.up.sql` via `docker exec -i ... psql < file` (had to use
  `MSYS_NO_PATHCONV=1` to work around git-bash mangling `docker cp`'s path on
  Windows). Manually verified the UNIQUE constraint fires
  (`duplicate key value violates unique constraint
  "intake_nonces_tenant_id_client_nonce_key"`) with a raw SQL probe, cleaned
  the probe row, then verified `003_intake_nonces.down.sql` drops the table
  cleanly and `003_intake_nonces.up.sql` re-applies cleanly — migration is
  additive + reversible, confirmed both directions against live pg16. No
  destructive action touched any pre-existing table or row; only my own
  `intake_nonces` rows (scoped by a fixture `tenant_id`) were written/deleted.

  **Full test evidence** (`DATABASE_URL=postgresql://oikonomos:***@localhost:5432/oikonomos`
  against the shared local container):
  - `pnpm --filter @oikonomos/db test`: **14 files / 62 tests passed, 0 failed**
    (previously 33 skipped when unset — all now run, including the 7 new
    `intakeNonces.test.ts` tests: basic admit+duplicate, an 8-way
    `Promise.all` concurrent-same-nonce race yielding exactly 1 dispatch / 7
    duplicate all resolving to the same row, digest-mismatch raises the typed
    error and leaves the original row untouched, cross-tenant nonce reuse is
    independent, and unknown-nonce lookup returns `null`).
  - `pnpm -r --no-bail test` (full recursive suite per the CLAUDE.md
    amendment — never scope to just this task's package): every package/service
    green, 0 failures anywhere in the run (`packages/db`, `packages/connectors`,
    `packages/harness-factory`, `packages/broker`, `services/control-api`,
    `services/worker`, `evals/golden`, `evals/harness`, and the rest) — grepped
    the full log for `ERR_PNPM`/`fail`, zero hits.
  - `pnpm lint` (root): clean, 0 errors/warnings.
  - `pnpm canaries`: **17/17 passed**, 0 skipped, 0 failed.

  Left `003_intake_nonces` applied on the shared local container (additive,
  harmless, matches what CI's `apply.sh`/canaries job would do with the new
  migration file present) rather than tearing it down — it holds no data
  outside my own cleaned-up test fixtures.

  **Status: needs_review.** All acceptance criteria met: migration
  additive+reversible with UNIQUE enforced (tested live), `admitIntake` is
  one atomic statement with concurrent-race coverage, digest-mismatch is a
  typed error never a silent duplicate, no crypto import in the module
  (source-pinned), DB-gated legs run green and recorded above, and
  `pnpm -r test` / `pnpm lint` / `pnpm canaries` all exit 0.
