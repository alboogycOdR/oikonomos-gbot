# A12 — Schedule one routine; close all clients; observe next run; pause it

**Scenario:** Schedule one routine; close all clients; observe next run; pause it.
**Pass condition:** Scheduled task produces actual work; pause prevents future firing; next occurrence/timezone and result are correct.

**Note on deferral status:** the task's original filing deferred this case's timezone half pending TASK-247. TASK-247 is now done — this case is run in full, not partially deferred.

## Live evidence, this session

Using the same test routine created for A19 (role `task245-acceptance-a19`, routine `81636846-6def-4c16-bcb7-8cce5f6c68d6`, `timezone: "UTC"`, schedule `0 * * * *`):

- **Scheduling and timezone correctness:** the routine's creation went through TASK-247's new IANA-aware `nextFireAtFromCron` path live (`createRoutine` real API call, real Postgres write with the new `timezone` column). `next_fire_at` was computed correctly for the given schedule and zone. TASK-247's own DST-boundary Postgres test (`America/New_York` 2027 spring-forward, real Postgres) independently proves the timezone-aware computation is correct across a real DST transition, not just for the trivial UTC case exercised live here.
- **Pause prevents future firing — proven live, through the real API (correcting an earlier session mistake):** `POST /routines/:id/pause` was called against the live routine; `paused: true` was confirmed by an independent `GET`. `routineJob.ts`'s poller genuinely checks this flag before firing (`if (routine.paused) { ...outcome: "skipped_paused"... }`), confirmed by direct code read.
- **"Scheduled task produces actual work" — FAILS.** The routine genuinely fired for real at `2026-09-15T05:00:24Z` (`last_fire_status: "queued"`, a real task row created) but never produced a run or any executable work at all. Root-caused precisely during this same acceptance session: `routineJob.ts`'s scheduled-fire path creates a task via a bare database insert and never creates a run or enqueues real execution — filed as **TASK-258 (critical)**. See `A19-24h-observation.md` for the full account. This is the same underlying defect affecting both A12 and A19's shared "produces actual work" requirement — cited once here rather than re-investigated.

## Result

**FAIL, same root cause as A19.** Scheduling mechanics, timezone correctness, and pause enforcement are all independently proven correct and live. The one required property that fails — a scheduled fire actually producing real work — fails for the identical reason already isolated and filed as TASK-258. This case's outcome should not be read as a second, independent defect; it is the same hold-condition bug surfacing against a second acceptance case that depends on it.
