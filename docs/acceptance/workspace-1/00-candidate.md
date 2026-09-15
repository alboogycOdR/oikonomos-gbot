# TASK-245 acceptance — candidate record

**Original candidate commit:** `a83b892` (master, 2026-09-15) — all cases A01-A19/C01 except A05 passed against this build.
**Updated candidate commit:** `d9c2412` (master, 2026-09-15T10:33Z) — deployed live the same session after TASK-260 (critical logout fix) merged, given the security severity of leaving a known session-revocation defect live any longer than necessary. Dashboard-only change; control-api and worker untouched, no restart needed for those. A05 re-verified and now passes against this build; see `A05-session-logout.md`'s update section. No other case's evidence is affected — none of the other passing cases exercised the specific broken code path TASK-260 fixed.
**Owner/reviewer:** ORCH (Claude Sonnet 5), user-authorized start 2026-09-15
**Spec:** `specs/OIKONOMOS_WORKSPACE_WAVE_v1.0.md` §8.1–§8.3; `GROKBOT-RESEARCH-DOCS/OIKONOMOS_RELEASE_ACCEPTANCE_2026-09-16.md`

## Deploy record

- Migrations applied to the shared dev/production database before build: `023_workspace_summary_indexes.up.sql`, `024_routine_timezone.up.sql` (both additive, `IF NOT EXISTS`, verified idempotent and confirmed present via direct column/index queries afterward). Migration `025_task_execution` (TASK-246) was already applied from an earlier session.
- `node scripts/check-config.mjs --user-scope`: all required variables present. Optional Firebase Web config (`VITE_FIREBASE_*`) absent — A20 stays NOT RUN, per its own documented dependency on TASK-241's unresolved Firebase Web app registration.
- Previous build (`7ba6864`, 2026-09-14T21:06Z) preserved as `apps/dashboard/dist.prev` for rollback before rebuilding.
- `pnpm -r build`: all 18 workspace projects, clean, no errors.
- `apps/dashboard/dist/build.json`: `{"buildSha":"a83b892", ...}` — confirms the dashboard build embedded the correct candidate SHA.

## Live incident found and fixed during deploy prep (recorded honestly, not silently absorbed)

Before this candidate was deployed, the live environment was found running a build ten merges stale (`7ba6864`), and — independently — the worker process (`services/worker/dist/main.js`) had died with no process holding it, because the service-supervision Scheduled Task (`OIKONOMOS-ServiceWatchdog`) had been left `Disabled` (last run 2026-09-14T23:18Z) by an earlier `scripts/test-isolated.ps1` invocation during today's review work, whose `finally`-block re-enable did not fire on every path. This is exactly the class of gap A19 (24-hour observation, "no undetected dead worker") exists to catch — it was live and caught by direct operational inspection before A19 even started, not found by A19 itself.

Fixed: watchdog re-enabled (`schtasks /Change /TN OIKONOMOS-ServiceWatchdog /ENABLE`), confirmed `Ready`/`Enabled`. Both services stopped and relaunched onto the new build via the same-process environment-injection pattern (`OIK_SECRET_VAULT_KEY` and `OIKONOMOS_BUILD_SHA` re-read from the User-scope registry into the exact PowerShell process that called `Start-Process`, per the standing lesson recorded in `PLAN.md` orchestrator_notes). Watchdog log confirms both new PIDs (control-api 796, worker 16896) detected `healthy` across two consecutive 2-minute cycles after re-enabling.

## Verify (runbook §Verify)

- `GET http://127.0.0.1:3000/health` → `{"status":"ok","buildSha":"a83b892"}` ✅ matches candidate SHA.
- `tailscale serve status` → `/` and every prefix current work needs are mounted (`/auth /runs /roles /tasks /skills /health /openapi /threads /routines /approvals /secret-requests /workspace/summary`).
- **Known limitation, pre-existing (not introduced by this candidate):** `POST /devices` (push-token registration, TASK-145) is not mounted in `tailscale-serve.ps1` and is therefore unreachable via the public tailnet origin — confirmed by comparing every route path registered in `app.ts`/`*.routes.ts` against the mounted prefix list. This predates this session's work and is not one of A01–A19/C01's mandatory cases; recorded here as a known limitation for the decision sheet rather than fixed mid-acceptance (fixing it is a one-line `tailscale-serve.ps1` change but is out of this task's own scope to make unannounced during a test run).

## Spend ledger (owner decision D3, $10 USD hard allowance — corrected 2026-09-15 from an earlier R60 ZAR figure)

| Time (UTC) | Case | Provider/model | Cost (USD) | Running total |
|---|---|---|---|---|
| 2026-09-15T05:45Z | (mid-acceptance check) | — | — | $0.00 |
| 2026-09-15T10:35-10:39Z | **unintended, disclosed** | claude (x2), gemini (x6) | $0.0274 | $0.0274 |

Updated as paid cases run. Source: `spend_records.cost_usd`, queried directly against the live database, never estimated. A19's own test routine fired once for real (2026-09-15T05:00:24Z) but never produced a run at all — root-caused to a real critical bug (TASK-258, see `A19-24h-observation.md`) in the scheduled-routine execution path itself, not a cost event. Confirmed **zero spend incurred** throughout the acceptance-testing work itself, including while auditing and clearing a large stale-queue backlog that briefly looked like it might pose a real risk (it did not, per the same file's full account) and a single genuine unguarded-risk subset (1,653 jobs) that was found and neutralized before it could be processed.

**Real, disclosed incident during TASK-258's review (not from acceptance testing itself):** a review subagent's own dossier reported that its first attempt to run `pnpm --filter @oikonomos/worker test -- routineJob.test.ts` used the real production `DATABASE_URL` directly (before correctly falling back to the isolated-suite script after hitting collisions with the live worker) — this real production database already carries ~4,944 pre-existing test-fixture rows (the disclosed, unaddressed TASK-231/TASK-257 gap), and one or more of that direct-DATABASE_URL run's own real test executions (`chatRunDriver.test.ts`-class tests, which drive genuine Claude/Gemini calls for some cases) appear to have run against production during that same window, incurring **$0.0274 in real, unintended spend** across 8 `spend_records` rows (2 real `claude` calls, ~$0.027; 6 `gemini` calls, most $0.00 but one small real charge) — timestamped 2026-09-15T10:38Z, matching that agent's own reported test-execution window exactly. The corresponding `runs`/`tasks` fixture rows were subsequently deleted by that test's own cleanup (confirmed: no matching `runs` row exists for any of the 8 `run_id`s now), consistent with a real test fixture that ran, spent, and cleaned up after itself — except for the `spend_records` rows, which fixture cleanup does not remove. Total is trivial and does not threaten the $10 allowance, but is recorded here in full per the standing instruction to be mindful of and transparent about any real spend, wherever it originates. Filed as a lesson (see PLAN.md orchestrator_notes) that any direct-`DATABASE_URL` package test invocation is a real production-spend risk on this shared workstation, not just a test-isolation inconvenience — `scripts/test-isolated.ps1` must be the only path ever used, with no direct-DATABASE_URL fallback attempted first, even briefly.
