# TASK-258 — Scheduled routine firings never actually execute

Root cause: `routineJob.ts`'s `createTask` port called `@oikonomos/db`'s bare
`createTask` directly — a plain INSERT with no run and no
`worker.run-execution` enqueue. The reference implementation
(`services/control-api/src/ports.ts`'s `testRunRoutine`, the manual "test
run" button) creates the task and then explicitly calls
`notify({task, threadId})`, which is what actually creates a run and
enqueues it. Nothing else in the system reconciles a run-less task, so every
automatically-scheduled fire was permanently orphaned.

**Owned_Paths:** `services/worker/src/jobs/routineJob.ts`,
`services/worker/src/jobs/routineJob.test.ts`

## Work Log

- [2026-09-15T12:35:00Z] [S5] Session start.

  **Note on prior worktree state:** this worktree was left on branch
  `task/TASK-247-s5` at session start (with a stale `.devteam/CHECKPOINT.md`
  from a PreCompact checkpoint and uncommitted edits to `AUTOPILOT_LOG.md` +
  `dossiers/TASK-247.md`). Verified via `origin/master` that TASK-247 was
  already fully merged (`dca13a0 merge: TASK-247 ...`, `11d20a6 chore(plan):
  TASK-247 and TASK-251 done — merged`), so nothing was lost. Discarded the
  stale uncommitted diff (`git checkout -- AUTOPILOT_LOG.md
  dossiers/TASK-247.md`, neither touched again — `AUTOPILOT_LOG.md` is not
  builder territory per CLAUDE.md), deleted the stale checkpoint, and the
  worktree was already correctly repointed at `task/TASK-258-s5` (up to date
  with `origin/master` at `03135f6`, the ORCH commit claiming this task for
  me) by the time I re-checked — no branch surgery of my own was needed.

  **Preflight (`python scripts/preflight_paths.py TASK-258`), pasted
  verbatim:**
  ```
  [preflight] TASK-258 Owned_Paths inspected in E:/DELL-PROJECTS/wt-s5-GROKBOT-CLONE
  [preflight] 2 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    FILE   services/worker/src/jobs/routineJob.ts  -> exists, 128 line(s), 5327 bytes
    FILE   services/worker/src/jobs/routineJob.test.ts  -> exists, 147 line(s), 7061 bytes
  ```

  **Root-cause confirmation, live (AC3):** queried the dev database
  (`oikonomos-postgres-local` container, `docker exec ... psql`, read-only —
  never touched schema or rows) for scheduled-fire tasks with no matching
  run:
  ```sql
  SELECT count(*), min(t.created_at), max(t.created_at)
  FROM tasks t LEFT JOIN runs r ON r.task_id = t.task_id
  WHERE t.requested_by LIKE 'routine:%' AND r.run_id IS NULL;
  ```
  Result: **238,105 / 238,105** `requested_by LIKE 'routine:%'` tasks had
  zero matching `runs` row — literally every automatically-scheduled fire,
  spanning `2026-09-05 09:20:11Z` (earliest) through `2026-09-15 10:13:11Z`
  (the live poll running at the moment of this investigation, minute-by-
  minute). Cross-checked `requested_by LIKE 'routine-test:%'` (the manual
  "test run" button's path): **zero** such tasks exist in this database at
  all, so there is no local A/B to compare against directly, but the code
  comparison (`testRunRoutine` vs. the old `routineJob.ts`) already
  establishes the mechanism difference unambiguously, and this query
  confirms the practical, 100%, ongoing impact.
  **Answering AC3 directly: yes, orphaned rows exist, all 238,105 of them,
  entirely pre-dating this fix. Remediation (backfilling runs for those
  rows, or another remedy) is explicitly out of this task's scope per its
  own Acceptance_Criteria — named here for whoever picks that decision up.
  This fix stops the bleeding going forward; it does not touch the existing
  orphaned rows.**

  **Implementation (AC1):** added `createAndEnqueueRoutineRun` in
  `routineJob.ts`, used by the scheduler's `createTask` port. It: (1)
  `getRole` to resolve the routine's role (throws clearly if the role
  vanished — shouldn't happen since `environmentIsUp` already checked it
  moments earlier, but a bare non-null assertion would be a silent trap);
  (2) `getOrCreateThreadForRole` for the role's own 1:1 conversation thread
  (same call `testRunRoutine` makes); (3) `resolveRoleRuntime(role).provider`
  for the run's provider; (4) `createTaskExecutionRun` — the atomic
  task+run transaction from `packages/db/src/tasks.ts` (`BEGIN`/INSERT
  task/INSERT run/`COMMIT` on one connection) with `execution: {version: 1,
  kind: "chat", threadId}`; (5) `enqueueRunExecution(options.connectionString,
  runId)` from this same package's `workerJobQueue.ts` — the identical
  standalone producer function `services/control-api/src/ports.ts` already
  imports from `@oikonomos/worker` for its own `runChatTask`/
  `submitTaskExecution` paths. Importing `enqueueRunExecution` from
  `workerJobQueue.ts` into `routineJob.ts` is a circular import
  (`workerJobQueue.ts` already imports `routineJob.ts`'s
  `runDueRoutinePoll`), but it is only ever called inside an async function
  body at runtime, never referenced at module-evaluation time, so ESM's live
  bindings resolve it safely — confirmed by the build and every test below
  actually exercising the call.

  **Liveness test (AC2):** added "TASK-258: a due routine fire creates a
  real run and enqueues a real worker.run-execution job, not just a task
  row" to `routineJob.test.ts`. It polls a real due routine, then asserts
  directly against Postgres: a `runs` row exists for the created task
  (`SELECT run_id FROM runs WHERE task_id = $1`), AND a real `pgboss.job`
  row exists for `WORKER_RUN_EXECUTION_JOB` with `data->>'runId'` matching
  that run — not a mock/spy on `createTask` or `enqueueRunExecution`, so it
  fails if either the run-creation or the enqueue is ever silently dropped
  or swapped for a stub. Wrapped in `withPgBossQueueLock` +
  `purgePgBossQueue(WORKER_RUN_EXECUTION_JOB)` before and after, following
  the exact pattern `workerJobQueue.test.ts`/`pgBossTestCleanup.ts` already
  established for tests against this same fixed literal pg-boss queue name.

  **Collateral fixes forced by the real atomic path, both within
  Owned_Paths (`routineJob.test.ts`'s own `afterAll`):** a scheduled fire
  now leaves behind a real `runs` row and a real `threads` row (via
  `getOrCreateThreadForRole`), which the existing cleanup didn't account
  for — `DELETE FROM tasks` was violating `runs_task_id_fkey` and `DELETE
  FROM roles` was violating `threads_role_id_fkey`. Added the two missing
  `DELETE`s (`runs` before `tasks`, `threads` before `roles`), each with an
  inline comment explaining why TASK-258 introduced the dependency.

  **A genuine, reproduced, cross-file regression found via the mandated
  full-suite run — NOT fixable from within this task's Owned_Paths, flagged
  for ORCH:**
  `services/worker/src/jobs/workerJobQueue.test.ts` > "uses a real pg-boss
  poll job to queue each due routine and persist its fire outcome" now
  fails deterministically (reproduced in isolation, 3 separate runs, not a
  flake):
  ```
  AssertionError: expected { …(16) } to match object { lastFireStatus: 'queued', …(1) }
  - Expected
  + Received
    { "lastFireStatus": "queued", ... }
    { "lastFireStatus": "missed", ... }
  ```
  **Root cause, confirmed by temporarily reverting `routineJob.ts` to its
  pre-fix HEAD version and re-running this exact test in isolation (passed
  cleanly, 7/7) before restoring the fix:** `scheduler.ts`'s `fireRoutine`
  (not in my Owned_Paths) calls `await ports.createTask(...)` THEN `await
  ports.recordFire(...)` — task visibility and fire-outcome persistence were
  never atomic with each other, but the pre-fix `createTask` was a single
  near-instant raw INSERT, so the gap between "task visible" and "recordFire
  persisted" was practically zero. My fix's `createAndEnqueueRoutineRun`
  does much more inside that same `createTask` port call, including
  `enqueueRunExecution` opening a brand-new `PgBoss` connection
  (`new PgBoss().start()` → `createQueue` → `send` → `stop()`), which alone
  takes ~2-3 real seconds — the *exact same* per-call cost
  `services/control-api/src/ports.ts`'s `runChatTask`/`submitTaskExecution`
  already pays today for every real chat message, via the identical
  imported `enqueueRunExecution` function. This is architecturally correct
  and matches the reference path this task was filed to converge on; it is
  not a regression in behavior, only in this one test's timing assumption.
  `workerJobQueue.test.ts`'s own `waitFor` helper polls only for the task
  row to appear via `listTasks`, then immediately asserts
  `getRoutine(...).lastFireStatus === "queued"` with no further wait — so it
  now reliably samples the multi-second window between "task committed" and
  "recordFire completed" that my fix's added (correct, necessary) latency
  opened up. **`workerJobQueue.test.ts` is not in this task's Owned_Paths
  (`services/worker/src/jobs/routineJob.ts`,
  `services/worker/src/jobs/routineJob.test.ts` only) — I did not and will
  not edit it.** The fix is mechanical (have that test's `waitFor` also wait
  for `lastFireStatus !== "missed"`/`=== "queued"`, or wait on
  `persisted?.lastFireAt`, instead of stopping at task-existence), but it is
  out of my territory. Flagging prominently for ORCH: either widen this
  task's `Owned_Paths` to include `workerJobQueue.test.ts` for a one-line
  fix, or file/dispatch a fast-follow. Every other test in the full worker
  suite and the full recursive suite is unaffected by this change.

  **Test evidence (`scripts/test-isolated.ps1`, real Postgres,
  `oikonomos-postgres-local` / `oikonomos_test`, `-Root` pointed at this
  worktree):**
  - `pnpm --filter @oikonomos/worker build` — clean, zero errors, both
    before and after the fix.
  - `-Filter "@oikonomos/worker"` (fresh `-Init`): **252/253 passed.** The
    1 failure is the `workerJobQueue.test.ts` regression above (root-caused,
    reproduced, explained, out of Owned_Paths). `routineJob.test.ts` itself:
    **5/5** (all 4 pre-existing tests + the 1 new TASK-258 liveness test),
    confirmed in isolation too (`vitest run ... src/jobs/routineJob.test.ts`
    — 5/5, 664ms).
  - Full recursive `pnpm -r test` via `scripts/test-isolated.ps1 -Root`
    (fresh `-Init`, single pass, 18 packages): **2 fails / 16 passes** at
    the package level.
    - `@oikonomos/worker`: the same, already-explained
      `workerJobQueue.test.ts` collateral failure above (252/253).
    - `@oikonomos/control-api`: 1 failure, `chat.routes.test.ts` >
      "grants a real pending approval and durably queues its persisted SDK
      session for the worker (TASK-155)" — `expected [] to deeply equal
      [ObjectContaining{event_type: 'run.queued', ...}]`, an audit-row-
      visibility race. **Not caused by this change:** `routineJob.ts` is
      never imported by `control-api`, `-r test` under
      `--workspace-concurrency=1` runs packages sequentially (never
      overlapping with `@oikonomos/worker`'s run), and re-running
      `src/chat.routes.test.ts` alone immediately afterward passed cleanly
      (**43/43**, `npx vitest run ... src/chat.routes.test.ts`) — i.e. it
      is flaky/order-dependent, not deterministic, unlike the
      `workerJobQueue.test.ts` failure above which reproduced 3/3 times.
      Consistent with the pre-existing flaky-test families already
      documented in TASK-247's/TASK-251's Progress_Notes (real-DB
      audit/spend-concurrency races under the full suite's load); not
      re-litigating root cause here since it is unrelated to routines,
      the worker, or this task's Owned_Paths.
    - Zero other packages affected; `@oikonomos/db`,
      `@oikonomos/harness-factory`, `@oikonomos/broker`,
      `@oikonomos/policy`, `@oikonomos/approvals`, `@oikonomos/shared`, and
      the remaining 11 packages/apps all green.

  All three code-facing `Acceptance_Criteria` addressed: (1) the atomic
  task+run+enqueue path is wired and live-tested (AC1, AC2); (2) live
  orphan confirmation query run and result recorded above, remediation
  explicitly deferred as the AC itself specifies (AC3). AC4 (full recursive
  suite recorded) — worker-scoped run done and recorded; full-repo run
  pending completion, appended below.

  Handing off `needs_review`. Flagging the one collateral,
  out-of-territory test failure prominently per the note above — this
  task's own code and tests are complete, correct, and passing.
