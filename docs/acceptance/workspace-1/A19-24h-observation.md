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

## Real findings surfaced during this case (disclosed, including ORCH's own mistake)

1. **A real pause route already exists — ORCH's initial finding here was wrong and has been retracted (filed as TASK-256, then closed as invalid the same session).** `POST /routines/:id/pause`/`resume` genuinely exist in `services/control-api/src/app.ts`, are already covered by a real HTTP-level test, and are already documented in `openapi.ts`. The mistake: an initial grep only searched paths starting with `/roles/:roleId/routines`, missing this separate top-level route. Once found, the real route was confirmed working directly against the live acceptance candidate — `POST /routines/81636846-.../resume` then `POST /routines/81636846-.../pause` both returned real 200s with the persisted `paused` flag flipping correctly each time. The routine was re-paused through this real route (not the earlier direct-function workaround) before this case's evidence was finalized. This also cleanly satisfies A12's own "pause prevents future firing" pass condition with a real operator-facing mechanism, not a workaround.
2. **A large backlog (4,646 jobs at first check) of stale `"basileia"`-tenant test-fixture runs, re-queued as real `worker.run-execution` pg-boss jobs on worker boot.** Traced directly, not assumed: `reconcileInterruptedRuns` (TASK-246/ADR-016) unconditionally re-queues every run left in an open status (`started`/`waiting_approval`/`resumed`), and the shared dev database's known, already-disclosed test-fixture pollution (TASK-231's own recorded, accepted gap — it deliberately never cleans the `"basileia"` tenant) means thousands of old test-suite fixture runs get swept up and re-queued for real execution every time the worker restarts. **Confirmed zero cost risk from this:** every one of these rows carries `provider: "test"`, a value `chatRunDriver.ts`'s own fail-closed provider guard rejects before any budget gate or real model call is reached — verified by reading that exact code path, not assumed. This genuinely delayed the acceptance test routine's own run (queued behind thousands of instantly-failing zombie jobs), but never posed a real financial risk. Filed as TASK-257, still open and valid.

## Result

**Status:** IN PROGRESS — window not yet complete. The routine-firing half of this case is now proven (real fire + real pause, both confirmed against live data); the remaining requirement is completing the 24h wall-clock observation without a lost job or an undetected dead worker, which continues independently of the now-paused test routine.
