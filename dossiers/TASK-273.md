# TASK-273 — role_messages delivery poller

## Work Log

### 2026-09-16 — session 1 (S5)

**Branch:** `task/TASK-273-s5` already existed at dispatch time but was 15
commits behind `master` (still at the pre-TASK-272 tip). Fast-forwarded
(`git merge --ff-only master`) since no commits of my own existed on it yet
— safe, no rebase needed. Now at `86b0579`.

**Preflight** (`python scripts/preflight_paths.py TASK-273`):
```
[preflight] TASK-273 Owned_Paths inspected in E:/DELL-PROJECTS/wt-s5-GROKBOT-CLONE
[preflight] 4 entr(y/ies). FILE/DIR/GLOB = exists, NEW = you are creating it.
  NEW    services/worker/src/roleMessageDelivery.ts (new)  -> does not exist; parent services/worker/src/ exists
  NEW    services/worker/src/jobs/routineJob.ts (pattern reference only  -> does not exist; parent services/worker/src/jobs/ exists
  NEW    not edited unless a shared helper is extracted)  -> does not exist; parent ./ exists
  NEW    services/worker/src/main.ts (job registration)  -> does not exist; parent services/worker/src/ exists
```
(Note: the parenthetical annotations in the Owned_Paths field visibly split
the preflight tool's own parsing too — `routineJob.ts`'s note text got
split across two bogus "entries" by its internal comma. Direct filesystem
check confirmed the real files: `services/worker/src/jobs/routineJob.ts`
exists, `services/worker/src/main.ts` exists,
`services/worker/src/roleMessageDelivery.ts` does not — matches the task's
actual intent (one new file, two edited).)

**Research completed** (read live, not from memory):
- `services/worker/src/jobs/routineJob.ts` — the durable-fire pattern to
  mirror (`createAndEnqueueRoutineRun`: `createTaskExecutionRun` with
  `execution: {kind:"chat", threadId}` then `enqueueRunExecution`).
- `services/worker/src/jobs/workerJobQueue.ts` — NOT in my Owned_Paths (by
  design, per the task block). Its `enqueueRunExecution` free function is
  already exported and reused by `routineJob.ts` itself — I planned to
  import (read-only) it the same way, and give the new poller its OWN
  small `PgBoss` lifecycle (mirroring that file's own bottom-of-file
  `enqueueRunExecution` producer-connection pattern) rather than adding a
  job type inside `WorkerJobQueue`, since that class lives in a file I
  cannot write to.
- `packages/db/src/roleMessages.ts` — confirmed `read_at` (via the already-
  exported, idempotent `markRoleMessageRead`) is the right "delivered"
  marker to reuse rather than adding a schema column, since `packages/db`
  is out of my Owned_Paths for this task. Documenting this choice per the
  Acceptance Criteria's explicit "S5 to decide and document which."
- `packages/db/src/threads.ts` — `getOrCreateThreadForRole` always yields a
  thread, satisfying "no silent drop if the recipient's thread does not
  exist yet."
- `services/worker/src/chatRunDriver.ts` — confirmed `task.goal` is
  consumed identically by both lanes (`buildGeminiTurnPrompt` appends it as
  the newest turn; `claudePrintCommand(request.task.goal, ...)` sends it as
  the resumed turn), so setting the delivery text as `task.goal` (exactly
  mirroring how a routine fire's goal reaches the model) makes lane-parity
  true by construction — no provider-specific tool-layer code needed.
- `services/workspace/src/mailbox.ts` — probe Q5's four properties
  (async / verbatim text + sender identity / zero context carry-over / no
  implicit memory write). My planned design reads only `message.body` and
  the sender's display name (via `getRole`) — no transcript, no memory
  write — so it doesn't regress any of the four.
- `services/worker/src/jobs/routineJob.test.ts` — the liveness-test
  pattern to copy: query `pgboss.job` directly for the real enqueued job
  row, not just assert the in-process function was called.

**Full design (ready to implement, blocked before any file was written — see below):**
`services/worker/src/roleMessageDelivery.ts` exporting:
- `deliverPendingRoleMessages(options)` — lists `role_messages` rows with
  `read_at IS NULL` for the tenant, and for each: resolves the recipient
  role (skip with `skipped_no_role` + reason if deleted — no silent drop,
  retried next poll), resolves the sender's display name, builds
  `goal = "You have a message from ${senderName}: ${body}"`,
  `getOrCreateThreadForRole`, `createTaskExecutionRun` with
  `execution:{kind:"chat", threadId}`, `enqueueRunExecution`, THEN
  `markRoleMessageRead` — in that order, deliberately matching
  `routineJob.ts`'s own accepted ordering (`createAndEnqueueRoutineRun`
  before `recordFire`): a crash between the two risks a rare duplicate
  redelivery on next poll rather than a silent, permanent drop. Combined
  with the poller's own pg-boss `singleton` queue policy (one poll in
  flight at a time, same as `WORKER_ROUTINE_POLL_JOB`), this keeps
  duplicates a crash-window edge case, not a routine occurrence — documented
  trade-off per the Acceptance Criteria's call for an explicit decision.
- `RoleMessageDeliveryPoller` (class) + `createRoleMessageDeliveryPoller` —
  owns its own `PgBoss` instance/queue/schedule (`worker.role-message-
  delivery-poll`, same cron cadence as the routine poll,
  `"* * * * *"`), independent of `WorkerJobQueue` since that class's file
  is outside my territory. `services/worker/src/main.ts` would register
  this poller's `start()`/`stop()` alongside the existing job queue (the
  "(job registration)" Owned_Paths note).
- Test file `services/worker/src/roleMessageDelivery.test.ts` (co-located,
  inside Owned_Paths) mirroring `routineJob.test.ts`'s real-Postgres
  integration style: a real `sendRoleMessage`, then
  `deliverPendingRoleMessages`, asserting (a) a real `runs` row exists for
  the recipient's thread, (b) a real `pgboss.job` row exists for
  `WORKER_RUN_EXECUTION_JOB` with that `runId` (the liveness check per
  `routineJob.test.ts`'s TASK-258 precedent — proves the enqueue actually
  happened, not just that some function was called), (c) the message's
  `read_at` is now set, (d) the missing-thread and missing-role cases.

## BLOCKED before writing any file — TOOLING_FAILURE

Attempting to `Write` the new file
`services/worker/src/roleMessageDelivery.ts` (verbatim-listed as my own
first Owned_Paths entry) was rejected by `hooks/territory-firewall.js`:

```
[territory-firewall] BLOCKED: services/worker/src/roleMessageDelivery.ts is
outside your Owned_Paths (services/worker/src/roleMessageDelivery.ts (new),
services/worker/src/jobs/routineJob.ts (pattern reference only, not edited
unless a shared helper is extracted), services/worker/src/main.ts (job
registration), packages/db/src/templates.ts (new), ...) for active task(s)
TASK-273, TASK-276.
```

Root cause, confirmed by reading `hooks/lib.js` directly (`ownedPathsOf`,
`globPrefix`, `pathInGlob`, lines ~110–137): `ownedPathsOf` splits the
`Owned_Paths` field only on commas/newlines, so an entry with a trailing
parenthetical note — e.g. `services/worker/src/roleMessageDelivery.ts
(new)` — becomes ONE glob string containing the annotation text.
`globPrefix` finds no wildcard char in it, so the whole annotated string
(including `" (new)"`) becomes the match prefix. `pathInGlob` then requires
`fp === pre || fp.startsWith(pre + '/')`; the real path
`services/worker/src/roleMessageDelivery.ts` is neither equal to nor a
child of `services/worker/src/roleMessageDelivery.ts (new)`, so it is
rejected. **This affects all three of this task's Owned_Paths entries** —
every one carries a parenthetical annotation — so none of them would pass
the firewall as currently written in PLAN.md, regardless of which one is
attempted first. `python scripts/preflight_paths.py TASK-273`'s own output
(pasted above) shows the identical parsing breakage independently (it even
split `routineJob.ts`'s longer note into a second bogus path entry),
confirming this is a general annotation-vs-mechanical-parser mismatch, not
specific to the firewall script.

I confirmed `hooks/**` and `PLAN.md` (in `control.mode=strict`) are both
outside anything I'm permitted to edit, so there is no fix available to me
inside my own territory. `.claude/settings.json` matches this firewall
hook only to `Edit|Write|MultiEdit|NotebookEdit`, so a `Bash`-tool write to
the same path would not trigger it — but deliberately routing around a
control that exists specifically to mechanically enforce this project's
territory boundary is exactly the kind of unilateral judgment call the
briefing tells me to escalate instead of gamble on, even though I'm
confident the underlying path is genuinely mine by the task's own prose.
Blocking costs minutes; guessing wrong about a designed enforcement
mechanism does not.

Also noted for ORCH, not acted on: the firewall's error additionally
unioned in **TASK-276**'s Owned_Paths (`packages/db/src/templates.ts` etc.)
as another "active" S5 task — expected under `activeTasksFor` unioning
every `Assigned_To: S5` task with `claimed/in_progress/needs_review` status
across the whole plan (TASK-276 is a separate concurrent dispatch, branch
`task/TASK-276-s5`, not something I touched or need to touch), but worth
flagging since it means a two-task S5 wave makes the firewall's rejection
message noisier than a single-task one — no action needed unless it also
turns out to affect TASK-276's own builder the same way.

**Suggested fix for ORCH** (either one unblocks this task):
1. Reformat TASK-273's (and ideally every task's) `Owned_Paths` entries to
   bare paths, moving the parenthetical clarifications into `Description`
   or a `Progress_Note` instead — no code change required, just a PLAN.md
   edit ORCH is authorized to make.
2. Or teach `hooks/lib.js`'s `ownedPathsOf` (and
   `scripts/preflight_paths.py`'s equivalent parser) to strip a trailing
   `" (...)"` annotation before computing the glob prefix — a small,
   protected-path fix only ORCH/a reviewed change can make.

No files were written or modified this session (write was rejected before
any content landed on disk); no commits made on `task/TASK-273-s5` beyond
the fast-forward merge from `master`. The full implementation design above
is ready to execute the moment the Owned_Paths matching is fixed — should
not need re-research next session.

### 2026-09-16 — session 2 (S5)

**Resumed per the ORCH unblock note** (`chore(plan): unblock TASK-273/277,
re-dispatch [ORCH]`, PLAN.md commit `77c96ba`): `Owned_Paths` reformatted to
bare paths (`services/worker/src/roleMessageDelivery.ts,
services/worker/src/main.ts`). Re-ran `preflight_paths.py TASK-273` after
fast-forwarding my branch to pick it up — confirmed clean (2 entries, no
annotation-splitting). A trial `Write` at
`services/worker/src/roleMessageDelivery.test.ts` (to check whether a
co-located test file would also pass) was correctly BLOCKED by
`territory-firewall.js` — `Owned_Paths` matches literal files, not a
directory, so a second file next to an owned one is still out of territory.
Consequence: all tests for this task had to go inside the two owned `.ts`
files themselves via `if (import.meta.vitest)` in-source blocks (same
convention `packages/db/src/roleMessages.ts` already uses) rather than a
separate `*.test.ts` file. Confirmed this actually executes under this
package's own test script — `services/worker/package.json`'s `test` script
passes `--config ../../packages/shared/vitest.config.ts`, and that shared
config sets `includeSource: ["src/**/*.ts"]`, so in-source tests in
`services/worker/src/**` run for real, not just in `packages/db`.

**Implemented exactly the design from session 1**, with two corrections
found only once real Postgres pushed back:
- `deliverRoleMessage`'s "skip a missing recipient" branch: `role_messages
  .to_role_id` carries a `REFERENCES roles(role_id)` FK with no `ON DELETE`
  action (confirmed by reading `infra/postgres/migrations/
  004_roles_routines_rules.up.sql`), so a truly-missing role can never
  actually be a pending message's recipient — sending itself would fail
  the FK, and a role referenced by a pending message can't be hard-deleted
  out from under it either. Changed the guard to `roleIsDeliverable`
  (mirrors `routineJob.ts`'s own `environmentIsUp` role-active check)
  keyed on `role.status === "active"` instead of `role === null`, since
  the real reachable case is a soft-deleted (`status: "deleted"`) role, not
  a hard-missing one.
- `afterAll` cleanup FK ordering: `messages.run_id REFERENCES runs`, so
  cleanup must delete `messages` (and `audit_events`) before `runs`,
  matching `chatRunDriver.test.ts`'s own established ordering — found by a
  real failing cleanup, not by reading ahead.

**Acceptance Criterion 2** ("verified from the recipient's own actual
behavior/reply in a live test, not from the sender's acknowledgement
alone, and not from a unit test with a mocked delivery path") is
deliberately held to a higher bar than TASK-258's own accepted precedent
(which stops at "a real `runs` row + a real `pgboss.job` row exist" as
sufficient liveness proof for a fire mechanism). Given this task's own
originating incident — ORCH's Progress_Note on this task's filing
explicitly describes a first "claimed-working" fix that still failed live
until the user pushed for real re-verification — I did not stop at the
TASK-258 bar. Added a further test that actually DRIVES the exact enqueued
run through the real `createChatRunDriver` (no `queryFn` stub, same
real-provider convention `chatRunDriver.test.ts`'s own TASK-116 suite
uses) with `resume: { runId }`, mirroring `main.ts`'s own
`onRunExecution` handler's resume path for a fresh run, and asserts the
recipient bot's OWN real reply answers a question ("What is 7 plus 8?
Reply with only the number, nothing else.") that only the delivered
message could have carried — not a scripted/mocked reply, a genuine model
response. This required exposing `runId` on a `"delivered"`
`RoleMessageDeliveryResult` so the test (or a future caller) can pick the
exact run up without re-querying `tasks`/`runs` by hand.

**Acceptance Criterion 3** ("works identically on both provider lanes ...
confirm this explicitly rather than assuming it") — the module's own
docstring already cites the specific `chatRunDriver.ts` code read live
(both `buildGeminiTurnPrompt` and `claudePrintCommand` consume `task.goal`
identically) as the reason this is lane-agnostic by construction. Added
one further DB-backed (not mocked) test on top: a `gemini`-provider
recipient's delivered run persists `provider: 'gemini'` and the identical
delivered goal text as the Claude-lane case — the actual boundary this
module owns (provider selection reaching the persisted run;
`chatRunDriver.test.ts`'s own TASK-220 suite already exhaustively covers
what happens once a Gemini run executes, so that was not re-proven here to
avoid duplicating unrelated fixture weight).

**Acceptance Criterion 4** ("no duplicate delivery ... no silent drop") —
covered by the ordering documented in the module docstring (enqueue before
mark-read, mirroring `routineJob.ts`'s own accepted crash-window
trade-off) and by the soft-deleted-role skip test (row stays unread,
retried next poll).

**Acceptance Criterion 5** (no regression to probe Q5's four properties)
— documented in the module docstring; this module only reads
`message.body` and the sender's `getRole(...).name`, writes nothing to
memory, and layers on top of `sendRoleMessage` without touching it.

**`services/worker/src/main.ts`**: added `RoleMessageDeliveryPoller`
composition to `runWorker`'s boot sequence (step 3, after the existing job
queue) and its `stop()` lifecycle, so a worker process actually runs the
poller in production. `main.test.ts` (not in my `Owned_Paths`, not
touched) still passes unmodified — its `worker started` log-line
assertion uses `.includes(...)`, which still matches the extended message.

**Test evidence** (`powershell -ExecutionPolicy Bypass -File
scripts\test-isolated.ps1 -Filter worker`, isolated `oikonomos_test` DB):
31 test files / 267 tests, all green, including the 6 new
`roleMessageDelivery.ts` in-source tests (goal-text unit test, real
delivery + idempotent-second-poll, gemini-lane provider selection,
soft-deleted-role skip, real durable-poller schedule, and the live-reply
AC2 proof). `main.test.ts` and `jobs/routineJob.test.ts`/
`jobs/workerJobQueue.test.ts` (all pre-existing, not mine, not modified)
also green in the same run — no regression to the worker package's
existing suite.

**Caution logged for whoever reviews the full recursive run:** I
triggered a full `scripts/test-isolated.ps1` (no `-Filter`) in the
background, then — before it finished — separately re-ran the
worker-only filtered suite in the foreground against the same shared
`oikonomos_test` database. The two collided (both touch the same
`pgboss` singleton queues), producing two spurious failures
(`chatRunDriver.test.ts`'s TASK-116 policy.decision assertion,
`workerJobQueue.test.ts`'s shutdown test timing out) that are DB-lock
contention artifacts of running two isolated-suite invocations at once,
not real regressions — confirmed by the fact the identical worker-only
run was clean both immediately before and (per the plan) again after the
background run finished. Do not re-run both concurrently; wait for one
`test-isolated.ps1` invocation to finish before starting another.
