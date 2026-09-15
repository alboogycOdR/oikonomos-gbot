# A12 — Schedule one routine; close all clients; observe next run; pause it

**Scenario:** Schedule one routine; close all clients; observe next run; pause it.
**Pass condition:** Scheduled task produces actual work; pause prevents future firing; next occurrence/timezone and result are correct.

**Note on deferral status:** the task's original filing deferred this case's timezone half pending TASK-247. TASK-247 is now done — this case is run in full, not partially deferred.

## Live evidence, this session

Using the same test routine created for A19 (role `task245-acceptance-a19`, routine `81636846-6def-4c16-bcb7-8cce5f6c68d6`, `timezone: "UTC"`, schedule `0 * * * *`):

- **Scheduling and timezone correctness:** the routine's creation went through TASK-247's new IANA-aware `nextFireAtFromCron` path live (`createRoutine` real API call, real Postgres write with the new `timezone` column). `next_fire_at` was computed correctly for the given schedule and zone. TASK-247's own DST-boundary Postgres test (`America/New_York` 2027 spring-forward, real Postgres) independently proves the timezone-aware computation is correct across a real DST transition, not just for the trivial UTC case exercised live here.
- **Pause prevents future firing — proven live, through the real API (correcting an earlier session mistake):** `POST /routines/:id/pause` was called against the live routine; `paused: true` was confirmed by an independent `GET`. `routineJob.ts`'s poller genuinely checks this flag before firing (`if (routine.paused) { ...outcome: "skipped_paused"... }`), confirmed by direct code read.
- **"Scheduled task produces actual work" — FAILS.** The routine genuinely fired for real at `2026-09-15T05:00:24Z` (`last_fire_status: "queued"`, a real task row created) but never produced a run or any executable work at all. Root-caused precisely during this same acceptance session: `routineJob.ts`'s scheduled-fire path creates a task via a bare database insert and never creates a run or enqueues real execution — filed as **TASK-258 (critical)**. See `A19-24h-observation.md` for the full account. This is the same underlying defect affecting both A12 and A19's shared "produces actual work" requirement — cited once here rather than re-investigated.

## Result (as originally tested, candidate `a83b892`)

**FAIL, same root cause as A19.** Scheduling mechanics, timezone correctness, and pause enforcement are all independently proven correct and live. The one required property that fails — a scheduled fire actually producing real work — fails for the identical reason already isolated and filed as TASK-258. This case's outcome should not be read as a second, independent defect; it is the same hold-condition bug surfacing against a second acceptance case that depends on it.

## Update — fix deployed and re-verified live end-to-end (candidate `c323a05`)

TASK-258 landed, was independently verified, merged, and deployed live to the worker the same session. Re-verified with a real, dedicated test principal (`task245-a12-fix-verify` role, real routine on a per-minute schedule, real `POST /roles`/`POST /routines`/`POST /routines/:id/pause` calls):

- The routine fired twice for real before the pause call landed (both within the acceptable 2-3 fire bound set for this check) — each fire produced a **genuine `runs` row** (`status: "started"` at creation) and a **genuine `pgboss.job` `worker.run-execution` row** with the correct `runId`, confirmed by direct query. Before TASK-258, neither of these would ever have existed — the task would have been created and then permanently orphaned.
- One of the two runs **completed successfully** end to end: real bot reply `"DONE"` (exactly the instructed content), `status: completed`, a real `ended_at` timestamp.
- The other run **failed with a real, specific, informative error** (`OpenSandbox create-sandbox returned unexpected status 500 (DOCKER::SANDBOX_START_FAILED)`) — an unrelated real infrastructure hiccup, not a defect in this fix. This is itself useful additional evidence: the fix produces a genuine, diagnosable terminal outcome on the failure path too, not just the happy path — no silent orphaning either way.
- Real spend for this verification: **$0.0194** (one real `claude-haiku-4-5-20251001` call, 15,272 tokens; the failed run incurred $0 since it failed before any model tokens were spent, consistent with the fail-closed design already proven elsewhere in this acceptance run).
- The routine and its role were fully cleaned up afterward (paused, then deleted via a precise, FK-ordered removal scoped only to this test principal's own IDs) — no fixture debris left behind.

**A12 now PASSES in full** against the current candidate. See `A19-24h-observation.md` for the queue-backlog complication encountered while reaching this confirmation (unrelated to the fix's own correctness) and its resulting priority bump to TASK-257.
