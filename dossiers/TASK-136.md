# TASK-136 — Dossier (S5)

## Work Log

- [2026-09-04T00:00:00Z] [S5] Session start. Checkpoint at `.devteam/CHECKPOINT.md` referenced stale
  TASK-135 (already merged per PLAN.md — TASK-135's block shows `Status: done`, merged --no-ff by
  ORCH, and TASK-136 opened as its fast-follow). Dispatch prompt is authoritative and names TASK-136,
  `control.mode=strict`. Confirmed via `PLAN.md` (`### TASK-136` block, `Assigned_To: S5`,
  `Status: claimed`, `Branch: task/TASK-136-s5`).

  Worktree was left on `task/TASK-135-s5` with one stray unstaged change to `AUTOPILOT_LOG.md`
  (discarded via `git checkout -- AUTOPILOT_LOG.md`, not part of any Owned_Paths so left untouched
  otherwise). Fetched origin, confirmed `origin/master` tip is `10304c0` (`chore(plan): claim
  TASK-136 [SV origin=S5]`), created `task/TASK-136-s5` from that tip (git refused a literal
  `checkout master` — this worktree cannot check out the branch the main checkout already has
  open — so branched directly from `origin/master`'s commit instead; `git log` on the new branch
  confirms it sits on `10304c0`).

  Preflight (`python scripts/preflight_paths.py TASK-136`):
  ```
  [preflight] TASK-136 Owned_Paths inspected in E:/DELL-PROJECTS/wt-s5-GROKBOT-CLONE
  [preflight] 4 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
    FILE   services/worker/src/chatRunDriver.ts  -> exists, 325 line(s), 15904 bytes
    FILE   services/worker/src/chatRunDriver.test.ts  -> exists, 573 line(s), 30228 bytes
    FILE   services/worker/src/runLifecycle.ts  -> exists, 193 line(s), 7246 bytes
    FILE   services/worker/test/runLifecycle.test.ts  -> exists, 337 line(s), 14438 bytes
  [preflight] Paste this output into your first Progress_Note as the c8b9872 filesystem check.
  ```
  All 4 Owned_Paths entries exist as ordinary files; no NEW/GLOB surprises.

- [2026-09-04T00:20:00Z] [S5] **Investigation (per the task's own "investigate before implementing"
  instruction), findings, and the blocking conclusion:**

  1. Read `packages/harness-factory/src/compose.ts` end to end for the park mechanism. Confirmed the
     task's own framing exactly: `RunParkPort`/`withPark` (lines ~152–155, ~381–397) already exist;
     `ComposeOptions.park` (line 203) is already threaded into `composeHarness`; `PARK_REASONS`
     (line 246) already includes `"approval_pending"`; `withPark` calls `park.park({toolUseId, reason})`
     whenever L1 denies with a reason in that set, deliberately including the fail-closed broker-error
     reasons too (CAN-04), not only `approval_pending`.
  2. Read `services/worker/src/executeRun.ts` end to end. `ExecuteTaskRunInput.park?: RunParkPort`
     (line 72) is already passed straight through to `composeHarness` (line 99). Confirmed via
     `grep -rn "park:" services/worker/src/` that **no production caller anywhere in `services/worker`
     currently supplies a `park` option** — `chatRunDriver.ts`'s `executeTaskRun` call (the task's
     stated target) has no `park` key at all, matching the task's premise precisely.
  3. Read `services/worker/src/runLifecycle.ts` end to end (already familiar from TASK-133/135).
     `resumeInterruptedRun` reads `getRun` then calls `resumeRun`, which only accepts `started`,
     `waiting_approval`, or `resumed` as its *source* status — there is no lifecycle helper here or
     in `packages/db` that can *set* a run to `waiting_approval` in the first place.
  4. Read `packages/db/src/runs.ts` end to end (all ~677 lines, including its own inline tests). The
     full set of state-mutating exports is `startRun`, `resumeRun`, `failRun`, `completeRun`,
     `cancelRun` — every one of `resumeRun`/`failRun`/`completeRun`/`cancelRun`'s `UPDATE` targets a
     *different* terminal-or-`resumed` status; **none of them, and no other exported function, ever
     writes `status = 'waiting_approval'`.** Confirmed by grepping the whole package
     (`grep -n "waiting_approval" packages/db/src/*.ts`): the only hits are the enum literal in
     `runStatuses`/`OPEN_STATUSES` and a *test's* raw `UPDATE ... SET status = 'waiting_approval'`
     used to fabricate fixture state (`runs.test.ts` line 326) — i.e. today, in the whole codebase,
     the *only* way a run's row ever reaches `waiting_approval` is a test manually forging it with SQL.
     This is the concrete, sourced version of the task's own framing ("nothing ever reaches the state
     [TASK-133/135] reconciles").

  **Conclusion — genuine ownership conflict, not an implementation choice:** wiring a real
  `RunParkPort` into `chatRunDriver.ts` whose `park()` callback transitions the run to
  `waiting_approval` requires a new state-mutating accessor in `packages/db/src/runs.ts` (an atomic,
  guarded `UPDATE ... SET status = 'waiting_approval' WHERE status IN (...)` — same shape as
  `resumeRun`/`failRun`/etc., returning `RunNotFoundError`/`IllegalRunTransitionError` on the same
  terms) — no such function exists, and none of the existing four covers this transition. Per this
  project's own N-rule (stated verbatim in `runLifecycle.ts`'s own header comment: "there is no raw
  SQL here (N-rule)" — all persistence goes through `@oikonomos/db`'s typed modules) and per
  `CLAUDE.md`'s "All harness invocations go through `packages/harness-factory`... Direct `query()`
  calls elsewhere fail lint" precedent for the same architectural discipline, `chatRunDriver.ts`
  cannot legally reach for a raw `UPDATE runs SET status='waiting_approval'` itself even though it
  has DB credentials in scope — it must call a typed `packages/db` accessor, the same way
  `runLifecycle.ts` calls `resumeRun`/`failRun`/`completeRun`/`cancelRun` today.

  `packages/db/**` is **not** in TASK-136's `Owned_Paths` (`services/worker/src/chatRunDriver.ts`,
  `services/worker/src/chatRunDriver.test.ts`, `services/worker/src/runLifecycle.ts`,
  `services/worker/test/runLifecycle.test.ts` only). The task's own Description anticipated exactly
  this risk ("a real `packages/db/src/runs.ts` accessor may be needed if one doesn't already cleanly
  support this transition from `started` — check `resumeRun`'s own status-transition list first") —
  I checked, and it is needed, and it does not exist.

  Per `AGENTS.md` commandment 4 / the briefing's "Verify territory" and "Shared infrastructure is out
  of territory" sections: STOP rather than reach outside Owned_Paths, even for one function. Setting
  `Status: blocked`, `Blocked_Reason: OWNERSHIP_CONFLICT`.

  **What ORCH needs to unblock this:** either (a) widen TASK-136's `Owned_Paths` to include
  `packages/db/src/runs.ts` (+ its colocated test) so this builder can add the new accessor itself, or
  (b) carve a small single-owner prerequisite task (same discipline `CLAUDE.md`'s "Sequence
  cross-cutting work" calls for) that adds a `parkRun`/`markRunWaitingApproval`-shaped accessor to
  `packages/db/src/runs.ts`, with TASK-136 sequenced via `Depends_On` behind it. No code has been
  written yet in `services/worker/**` — nothing to lose either way; this was pure investigation plus
  branch setup, matching the task's own "investigate before implementing" instruction.

  I have **not** yet investigated the second, harder question in the Description (what "resuming" a
  parked chat run means for the live Agent SDK session) in similar depth, since the first-order
  blocker above must resolve before that question is actionable — no point designing the resume path
  around a park mechanism that cannot yet exist.

## Status

Branch `task/TASK-136-s5` created from `origin/master@10304c0`, no code changes. No files outside
`Owned_Paths` were modified (the stray `AUTOPILOT_LOG.md` diff left over from a prior session on
`task/TASK-135-s5` was discarded via `git checkout --`, not committed).
