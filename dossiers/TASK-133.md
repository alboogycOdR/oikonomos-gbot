# TASK-133 — OIK-106: wire durable resume into worker startup (kill worker mid-run)

Unit: S5. Branch: `task/TASK-133-s5` (created off `mainco/master` tip
`21a0c3b`, post TASK-129 merge — this session's worktree had been left on
the now-merged `task/TASK-129-s5` branch from a prior session; re-branched
cleanly rather than resuming on top of merged work).

## Work Log

- [2026-09-04T16:30:00Z] [S5] Read PLAN.md TASK-133 block fresh. No prior
  dossier existed — first session on this task.

  **`packages/db/src/runs.ts`**: exported the previously-private
  `OPEN_STATUSES` array as `openRunStatuses` (read-only alias, per the
  task's own instruction not to hand-duplicate the literal). Added
  `listOpenRuns(options, filter?)` — a real accessor returning every run
  currently in an open, non-terminal status (`started`/`waiting_approval`/
  `resumed`), filterable by `tenantId`/`taskId`, capped at 2000 rows (not
  paginated like `listRuns`: boot-time reconciliation needs the whole open
  set in one pass). Query uses `status = ANY($1::run_status[])` — needed
  the explicit `::run_status[]` cast since `status` is a real Postgres enum
  column, not text (first attempt with `::text[]` failed against real
  Postgres with "operator does not exist: run_status = text").

  **Ownership boundary hit and resolved without crossing it**: the task
  description says to "export [`OPEN_STATUSES`], or add an equivalent
  query" — but consuming any *new* export from `packages/db` in the worker
  package requires it to also be added to `packages/db/src/index.ts`'s
  named export list (the package's `exports` field in `package.json` only
  publishes `.` → `dist/index.js`; there is no subpath export, so a deep
  import like `@oikonomos/db/src/runs.js` cannot resolve at all — confirmed
  by trying it and getting a Node `ERR_PACKAGE_PATH_NOT_EXPORTED`-equivalent
  resolution failure). `packages/db/src/index.ts` is **not** in this task's
  `Owned_Paths`. Rather than edit it (an OWNERSHIP_CONFLICT) or duplicate
  raw SQL in the worker package (violating this repo's own N-rule — the
  file's header comment: "there is no raw SQL here"), I kept
  `listOpenRuns`/`openRunStatuses` real and tested inside `packages/db` (so
  the task's literal ask is satisfied and available to any consumer once
  the barrel is updated), and had the worker's reconciliation step use the
  **already barrel-exported** `listRuns`, looped once per open status with
  full cursor pagination and merged — functionally identical to calling
  `listOpenRuns`, but through an export that already crosses the package
  boundary today. Noted here explicitly rather than silently choosing one
  approach: if `packages/db/src/index.ts` is ever updated (by whoever owns
  it) to re-export `listOpenRuns`, `reconcileInterruptedRuns` should switch
  to calling it directly instead of the three-status loop — purely an
  internal simplification, no behavior change.

  **`services/worker/src/runLifecycle.ts`**: added
  `reconcileInterruptedRuns(options, filter?)` — the boot-time
  reconciliation step. Scans every open run (optionally scoped by
  `tenantId`/`taskId` — real worker boot calls it unfiltered; tests scope it
  to their own fixture's `taskId` so they never touch another test's
  unrelated runs sharing the same database) and calls
  `resumeInterruptedRun` on each. A single run's resume failure is recorded
  as a `resume_failed` outcome rather than thrown, so one bad row can't
  abort reconciliation of the rest. Returns `ReconcileOutcome[]` so a real
  caller (or a test) can inspect exactly what happened to every run it
  touched — satisfies AC3 (callable independently of full worker-process
  boot; nothing here depends on process lifecycle).

  Multi-instance gap noted honestly, not silently ignored (per the task's
  own instruction): two worker processes reconciling concurrently could
  both attempt to resume the same orphaned run. `resumeRun`'s underlying
  `UPDATE ... WHERE status IN (...)` is still atomic per-row (only one of
  the two racing calls can actually flip the row), so this cannot corrupt
  state, but nothing here prevents the redundant, wasted attempt.
  Coordinating that is out of this task's scope (single-worker-instance
  deployment only, as the task explicitly allows).

  **Not done, and why**: wiring an actual call to `reconcileInterruptedRuns`
  into the real worker-process startup sequence (e.g. `services/worker`'s
  process entrypoint, if/when one exists — today's `src/index.ts` is a pure
  library barrel with no `main()`/CLI entrypoint) is not in this task's
  `Owned_Paths` either. AC3 only requires the step be *callable*
  independently and testable on its own — which it is — not that a boot
  entrypoint file be edited. Flagging this as a real gap for whoever owns
  the eventual process entrypoint: `reconcileInterruptedRuns` exists,
  works, and is tested, but nothing calls it automatically today.

  **Tests** — `packages/db/src/runs.ts`/`runs.test.ts`: input-validation
  tests (connectionString guard, invalid taskId, `openRunStatuses` content
  pin) plus two real-Postgres integration tests: one proves `listOpenRuns`
  returns started/waiting_approval/resumed runs and never a
  completed/failed/cancelled one (mutation-proof — removing the status
  filter would include the terminal runs), the other proves taskId scoping
  and UUID validation.

  **Tests** — `services/worker/src/runLifecycle.ts`/`test/runLifecycle.test.ts`:
  a connectionString-guard unit test plus three real-Postgres integration
  tests: (1) a run left `started` with no live process (constructed
  directly, not via an actual killed process, per the task's own
  instruction) is found and resumed — AC1; (2) completed/failed/cancelled
  runs constructed in the same fixture are never touched — outcomes list
  doesn't mention them and their DB status is unchanged after the call —
  AC2, explicitly mutation-proof (a broken status filter would produce a
  `resume_failed` outcome for them, which the assertion catches); (3) a
  bare call with no surrounding boot sequence just works — AC3.

## Test Evidence

- `packages/db`: `pnpm --filter @oikonomos/db exec vitest run` → **130
  passed, 2 skipped** (27 files), including the new `listOpenRuns` coverage
  in `src/runs.ts`/`src/runs.test.ts`.
- `services/worker`: `pnpm --filter @oikonomos/worker exec vitest run` →
  **45 passed, 1 skipped** (8 files), including all 3 new
  `reconcileInterruptedRuns` tests in `test/runLifecycle.test.ts` (ran
  twice, both clean — first run hit a pre-existing environment gap, see
  below).
- `pnpm exec tsc --noEmit` clean in both `packages/db` and `services/worker`.
- `pnpm -r build` (whole repo): all 17 buildable packages/services, exit 0.
- `pnpm lint` (whole repo, root `eslint .`): clean, exit 0.
- `pnpm -r test` (whole repo, per the CLAUDE.md amendment requiring the
  full recursive suite): run twice. Every run showed 100% green in every
  file this task touches (`packages/db/src/runs.ts`,
  `services/worker/src/runLifecycle.ts` and their test files). Two
  unrelated flakes across the two runs, both confirmed to be real-Postgres
  resource contention from many workspaces hitting the same compose
  Postgres concurrently — not regressions from this task (same pattern
  TASK-129's dossier documented): `services/worker/src/chatRunDriver.test.ts`
  (3 tests, "Run not found"/FK violation on the shared `runs`/`messages`
  tables) on the first run, `services/worker/src/registerCapabilities.test.ts`
  (1 test, 5s timeout) on the second — each re-ran clean in isolation
  (`pnpm exec vitest run <file>` inside `services/worker`) immediately
  after. Neither file is in this task's `Owned_Paths` and this branch never
  touches `packages/broker`, `chatRunDriver.ts`, or `registerCapabilities.ts`.
  One pre-existing environment gap fixed along the way (not a code change):
  `pg-boss` was listed in `services/worker/package.json` but not installed
  in `node_modules` (`pnpm install --no-frozen-lockfile` — lockfile
  unchanged, 7 packages added) — this affected `src/jobs/workerJobQueue.test.ts`
  only, unrelated to `Owned_Paths`, and was already broken before this
  session touched anything.

## Status

Handing to `needs_review`. Artifacts: `packages/db/src/runs.ts`,
`packages/db/src/runs.test.ts`, `services/worker/src/runLifecycle.ts`,
`services/worker/test/runLifecycle.test.ts`.
