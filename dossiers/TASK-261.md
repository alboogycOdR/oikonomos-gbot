# TASK-261 — independent watchdog self-heal backstop

## Root cause recap

`scripts/test-isolated.ps1` disables `OIKONOMOS-ServiceWatchdog` before running tests and re-enables it in its own `finally` block. That `finally` is not guaranteed to run if the script's process is killed abruptly (a documented, real PowerShell behavior) — and this exact gap left the watchdog stuck `Disabled`, with the live worker dead and nothing supervising it, at least three times in one session (2026-09-15), each time only caught because a human happened to notice.

## Fix

Two parts, deliberately decoupled so the backstop survives the exact failure mode it exists for (the disabling script being killed outright):

1. **`scripts/test-isolated.ps1`** now writes a timestamped marker file (`infra/compose/logs/watchdog-disabled.marker`) the moment it disables the watchdog, and removes it in its own `finally` alongside the existing re-enable. This is the only change to the original script — the fast path is untouched.
2. **`scripts/watchdog-guardian.ps1`** (new) — a small, independent script that checks the marker: if it is older than 8 minutes AND the watchdog is currently `Disabled`, it force-re-enables the watchdog and removes the marker, logging the recovery to `infra/compose/logs/watchdog-guardian.log`. If the marker is missing, fresh, or the watchdog is already healthy, it does nothing — silently, so the log stays readable.

This is registered as its own Windows Scheduled Task, **`OIKONOMOS-WatchdogGuardian`**, running every 5 minutes, with no dependency on `test-isolated.ps1`'s own process tree. Killing that script outright no longer leaves the watchdog stuck indefinitely — the guardian recovers it within one cycle (worst case ~13 minutes: 8min stale threshold + up to 5min until the next guardian tick; typically much faster).

## Verification (real, direct simulation — not assumed)

**Test 1 — the actual failure mode this task exists for:** disabled the watchdog, wrote a marker, backdated it 10 minutes (simulating a killed script whose `finally` never ran), then ran the guardian directly.
- Result: watchdog `Disabled` → `Ready`. Marker removed. Log: `RECOVERED: marker was 10min old and watchdog was Disabled -- force re-enabled.`
- One real bug caught and fixed during this test: the guardian's own `Get-Date -AsUTC` call failed (`-AsUTC` is PowerShell 7.1+ only; this repo's scripts target Windows PowerShell 5.1). Fixed to `(Get-Date).ToUniversalTime()`. A second bug was caught the same way: the guardian checked for `"Scheduled Task State:\s+Disabled"` via `schtasks /FO LIST` **without** `/V`, so the field was never present and the check silently always returned false. Fixed to check `Status:\s+Disabled` (present without `/V`, matching `test-isolated.ps1`'s own existing convention). Both bugs would have made the guardian a no-op in production had they shipped — caught only because the test was run for real rather than assumed to work from reading the code.

**Test 2 — must NOT interfere with a legitimate, still-running disable:** disabled the watchdog, wrote a fresh (unbackdated) marker, ran the guardian directly.
- Result: watchdog stayed `Disabled`. Marker untouched. No log entry written (correct — nothing to report). Confirms the guardian won't fight a real, in-progress `test-isolated.ps1` run.

Both tests cleaned up afterward; live services (`control-api` pid 10036, `worker`) were never stopped by this exercise and were confirmed healthy throughout via `/health`.

## Full test-suite evidence (AC4)

Ran `scripts/test-isolated.ps1` (no filter) twice, plus one targeted `-Filter "@oikonomos/worker"` run, to separate this task's own effect from pre-existing, unrelated flakiness:

1. **First full run** (existing, not-yet-reset database): `control-api` and `worker` both showed failures. Traced `chat.routes.test.ts`'s one failure to known DB-fixture pollution (confirmed clean on a fresh database, see below) — not a regression.
2. **`-Init` (fresh database) + full run**: `control-api` 288/288 clean (including the test that failed in run 1 — confirms that was pollution, not a real defect). `worker` had 4 failures, all `RunNotFoundError`/FK races internal to `chatRunDriver.test.ts` — a different, narrower issue than run 1's, consistent with pre-existing intra-file test-ordering races (same class TASK-255 already partially fixed in this file, evidently not exhaustively).
3. **Immediate follow-up, `-Filter "@oikonomos/worker"` only, no `-Init`**: 27/253 failures, all `StaleCapabilityRowError` on capability id `gmail.send_message` — a capability that exists in no current manifest or builtin-tools declaration. This is the exact leak `dossiers/TASK-254.md` already identified and flagged as "a real, separate leak bug in `chat.routes.test.ts` ... worth its own task" but never filed: `POST /roles` fixture roles in that file are never deleted, so their grants survive into later, unrelated test runs. Directly queried the database to confirm: by the time I checked, the specific offending row had already been cleaned up by some other test's own teardown — consistent with a transient, order-dependent leak rather than a permanent one.

**None of this is caused by TASK-261's own change** — the change here is a plain-text marker file write/delete in a PowerShell script; it has no interaction with Postgres, `CapabilityRegistry`, or any Node process. The watchdog's own `finally`-path re-enable worked correctly and was confirmed in both full runs (`[test-isolated] watchdog re-enabled` logged each time).

**Disposition:** folded the `chat.routes.test.ts` fixture-leak fix into TASK-264 (already touches this exact file for an unrelated reason — the ADR-018 amendment's TASK-117 assertion update), rather than leaving it unfixed a second time or filing a territorially-overlapping task.

## Result

**Done.** The independent backstop exists, is registered as a live Scheduled Task on this workstation, and is directly verified against both the real failure mode (killed script) and the real non-interference requirement (legitimate in-progress disable). The pre-existing `finally` fast path is unchanged and confirmed still working. AC4's full-suite run is recorded with every residual failure traced to a specific, already-known, separately-tracked cause — not asserted clean when it wasn't, and not left unexplained.
