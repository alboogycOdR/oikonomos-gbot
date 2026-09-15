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

(Updated periodically through the 24h window; see `infra/compose/logs/watchdog.log` for the continuous machine-readable record between manual check-ins.)

## Result

**Status:** IN PROGRESS — window not yet complete.
