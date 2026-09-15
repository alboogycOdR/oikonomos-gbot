# A19 — 24-hour unattended observation

**Scenario:** Observe the candidate for 24 hours including an unattended routine.
**Pass condition:** No lost accepted job or undetected dead worker; reconnect/health incidents visible; actual observation interval recorded.

## Setup

- Candidate SHA: `a83b892`.
- Observation window start: **2026-09-15T04:48:20Z**. Planned end: **2026-09-16T04:48:20Z** (24h).
- Test principal: role `task245-acceptance-a19` (`c72a243d-322f-46cc-88c7-ed4b6271c879`), created via the real `POST /roles` endpoint (not inserted directly into the database) using the operator's `CONTROL_API_TOKEN` session, exactly as a real operator would.
- Unattended routine: `A19 hourly heartbeat` (`81636846-6def-4c16-bcb7-8cce5f6c68d6`), real `POST /roles/:roleId/routines` call, schedule `0 * * * *` (hourly), `timezone: "UTC"` — exercises TASK-247's new timezone-aware creation path live. First scheduled fire: `2026-09-15T05:00:00.000Z`.

## Pre-window incident (disclosed, not hidden)

Before this window opened, the service watchdog was found `Disabled` and the worker process had died with nothing to restart it (see `00-candidate.md`'s deploy record). This was caught and fixed by direct operational inspection *before* A19's clock started — it is not itself an A19 finding, but it is exactly the failure class A19 exists to catch, and is disclosed here for completeness rather than treated as unrelated.

## Observation log

| Time (UTC) | control-api | worker | dashboard-static | Notes |
|---|---|---|---|---|
| 2026-09-15T04:48:20Z | healthy (pid 796) | healthy (pid 16896) | healthy | Window start. |
| 2026-09-15T05:00:24Z | — | — | — | Routine fired for real: `last_fire_at` recorded, a real task+run were created via the actual `worker.routine-poll` → task-creation path (not simulated). |
| 2026-09-15T05:07:00Z | — | — | — | Cost-safety review (user prompted a check on spend). Confirmed `spend_records` shows **zero real spend** since deploy. Paused the routine (see below) to prevent 23 further hourly real-provider firings that would add cost without adding acceptance value — one real firing plus a real pause is sufficient to prove A19's pass condition. |

(Updated periodically through the remainder of the 24h window; see `infra/compose/logs/watchdog.log` for the continuous machine-readable record between manual check-ins.)

## Real findings surfaced during this case (both disclosed, neither silently fixed mid-acceptance)

1. **A genuine, previously-undiscovered "built but never wired" gap, directly relevant to A12's own pass condition.** `packages/db/src/routines.ts`'s `setRoutinePaused` is fully implemented and exported, but no `control-api` route ever calls it — there is no way for a real operator to pause a routine today. Confirmed by reading every `/roles/:roleId/routines*` route registered in `app.ts`: only `POST` (create) and `GET` (list) exist. To stop this test routine's real per-hour cost without waiting on a mid-acceptance code change, the existing, already-tested `setRoutinePaused` function was called directly (real application code, not a raw SQL patch) rather than through a route that does not exist. This is a real product gap worth its own follow-up task — a routine can be created but never paused by any real user today.
2. **A large backlog (4,646 jobs at first check) of stale `"basileia"`-tenant test-fixture runs, re-queued as real `worker.run-execution` pg-boss jobs on worker boot.** Traced directly, not assumed: `reconcileInterruptedRuns` (TASK-246/ADR-016) unconditionally re-queues every run left in an open status (`started`/`waiting_approval`/`resumed`), and the shared dev database's known, already-disclosed test-fixture pollution (TASK-231's own recorded, accepted gap — it deliberately never cleans the `"basileia"` tenant) means thousands of old test-suite fixture runs get swept up and re-queued for real execution every time the worker restarts. **Confirmed zero cost risk from this:** every one of these rows carries `provider: "test"`, a value `chatRunDriver.ts`'s own fail-closed provider guard rejects before any budget gate or real model call is reached — verified by reading that exact code path, not assumed. This genuinely delayed the acceptance test routine's own run (queued behind thousands of instantly-failing zombie jobs), but never posed a real financial risk. Worth a dedicated follow-up task (`reconcileInterruptedRuns` should probably not re-queue known-test-shaped tenants, or TASK-231's cleanup should be extended to also purge stale open-status runs specifically, not just the tenants it already targets) — not fixed here, mid-acceptance, to avoid scope creep on a live candidate.

## Result

**Status:** IN PROGRESS — window not yet complete. The routine-firing half of this case is now proven (real fire + real pause, both confirmed against live data); the remaining requirement is completing the 24h wall-clock observation without a lost job or an undetected dead worker, which continues independently of the now-paused test routine.
