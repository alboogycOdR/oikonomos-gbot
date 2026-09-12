# Runbook — Workspace-1 release environment (build, deploy, verify, roll back)

**Status:** live, executed once end-to-end (TASK-240, 2026-09-12). **Owner:** ORCH.
**Spec:** `specs/OIKONOMOS_WORKSPACE_WAVE_v1.0.md` §6.

## Topology (workstation, disclosed limitation)

Everything runs on the Tailscale host `studyworkstation` (a personal Windows
workstation). The host must be **on and logged in**: the watchdog
(`docs/runbooks/service-supervision.md`) is a logon-triggered Scheduled Task. No
24/7 or "works while your device is off" claim is made until TASK-249 moves the
services to an always-on host.

| Component | Where | Port | Started by |
|---|---|---|---|
| Postgres 16 + pgvector | Docker `oikonomos-postgres-local` | 127.0.0.1:5432 | Docker Desktop (`restart: unless-stopped`) |
| control-api | `services/control-api/dist/index.js` | 127.0.0.1:3000 | watchdog |
| worker | `services/worker/dist/main.js` | — (queue consumer) | watchdog |
| dashboard-static | `infra/compose/dashboard-static.mjs` serving `apps/dashboard/dist` | 127.0.0.1:5174 | watchdog |
| release origin | Tailscale Serve, `https://studyworkstation.<tailnet>.ts.net` | 443 (tailnet only) | `infra/compose/tailscale-serve.ps1` |

One origin: Serve mounts `/` on dashboard-static and each public API prefix on
control-api, so the `Secure; SameSite=Strict` session cookie works and no CORS
exists. `/internal/*` is not mounted (falls through to the SPA, never to the API).
**Prefix rule:** a dashboard client route must not share a top-level segment with
an API prefix; where one path does (`/workspace/summary`), it is mounted exactly.

## Build

**Node version (found 2026-09-12):** the repo requires Node 22 (`.nvmrc`, CLAUDE.md) and
`.npmrc` sets `engine-strict=true`, but the workstation has only Node 23.10 and no
version manager. `pnpm install --frozen-lockfile` therefore refuses on
`eslint-visitor-keys@5.0.1` (engines exclude odd-numbered 23). Until Node 22 is
installed on the host (a TASK-249 host-preparation item), install with
`pnpm install --frozen-lockfile --config.engine-strict=false` — the mismatch is a
lint-only devDependency, not a runtime one, and the services have run on 23.10 all
along. Do not commit an `.npmrc` change to hide this.

```powershell
# from the repo root, on the commit you intend to release
git rev-parse --short HEAD                      # record as CANDIDATE_SHA
$env:OIKONOMOS_BUILD_SHA = (git rev-parse --short HEAD)
pnpm -r build                                   # services + packages
pnpm --filter @oikonomos/dashboard build        # embeds __OIKONOMOS_BUILD_SHA__
```

Keep the previous dashboard build for rollback before overwriting:
`Rename-Item apps\dashboard\dist apps\dashboard\dist.prev` (do it before the build,
or copy afterwards). For control-api/worker, `dist/` is rebuilt in place; the
previous commit's build is recovered by checking out the previous SHA and
rebuilding (see Roll back).

### Dashboard Google sign-in (TASK-241)

The dashboard build reads four **public** Firebase web-app fields at build time:
`VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`,
`VITE_FIREBASE_APP_ID` (see `apps/dashboard/.env.example`). They come from a
**Web app** registered in the same Firebase project the Android app uses
(`FIREBASE_PROJECT_ID`, default `basileia-oikonomos-gmail`, see
`docs/runbooks/firebase-android-setup.md`); the release origin
`https://studyworkstation.<tailnet>.ts.net` must be added to that project's
authorised domains or the popup is refused. These are not secrets, but they are
build inputs: set them in the shell that runs `pnpm --filter @oikonomos/dashboard
build`. Until they are provisioned the "Continue with Google" button reports
`FirebaseConfigError`, the operator-token login still works, and acceptance case
A20 (same principal on web and Android) is **not run**.

## Deploy

1. `node scripts/check-config.mjs --user-scope` — must exit 0. It names every
   required variable and prints present/absent only. It will refuse if
   `OIKONOMOS_CAPABILITIES_ENABLED` is absent or not `true` (the 2026-09-12
   kill-switch outage).
2. Apply new migrations to the production database in order
   (`infra/postgres/migrations/NNN_*.up.sql`; additive only — see Roll back).
3. Restart the services onto the new build: stop the node processes for
   `dist/index.js` and `dist/main.js` (and `dashboard-static.mjs` if its file
   changed); the watchdog restarts all three within 2 minutes, or run
   `powershell -File infra/compose/service-watchdog.ps1` to do it now.
4. If a new top-level API prefix was added, add it to `tailscale-serve.ps1` and
   run it (idempotent; it resets and re-applies the mounts).

## Verify

- `GET https://studyworkstation.<tailnet>.ts.net/` → 200, HTML.
- `GET …/workspace/<anything>` → 200 HTML (SPA fallback, not the API).
- `GET …/health` → reaches control-api (401 without a session; with a session,
  the JSON includes `buildSha` = CANDIDATE_SHA once TASK-237 lands).
- Sign in on the origin, open a thread, confirm the SSE stream connects
  (devtools: `/threads/<id>/stream` stays open) and an approval decision succeeds.
- `tailscale serve status` shows `/` and every prefix in `tailscale-serve.ps1`.
- `Get-Content infra/compose/logs/watchdog.log -Tail 5` shows all three services healthy.

## Roll back

1. Dashboard: `Rename-Item apps\dashboard\dist apps\dashboard\dist.bad;
   Rename-Item apps\dashboard\dist.prev apps\dashboard\dist` — dashboard-static
   reads from disk per request; no restart needed.
2. Services: `git checkout <PREVIOUS_SHA>`, `pnpm -r build`, stop the node
   processes, let the watchdog restart them.
3. Database: migrations are **additive only**. Never run a `.down.sql` against
   production data as part of a rollback; a previous build must tolerate the new
   columns/tables being present. If a migration is not additive, it needs its own
   ADR before it ships.
4. Re-verify: sign in, send one chat turn, confirm a reply. Record the rollback
   in PLAN.md's orchestrator_notes.

**Drill record (2026-09-12 10:30Z, TASK-240, ORCH):** dashboard rollback executed
live on the release origin and verified through `GET /build.json` (emitted by the
vite build): `cbe56bb` (N-1) → deploy `drill-N` → observed `drill-N` → swap
`dist.prev` back → observed `cbe56bb`; `/` and `/workspace/zzz` 200 throughout; no
service restart. Two setup mistakes on the first attempt are worth knowing:
`Copy-Item` into an already-existing `dist.prev` nests the tree (delete stale
`dist.prev`/`dist.bad` first), and an unreferenced vite `define` is tree-shaken,
which is why `build.json` exists. Service-level (control-api/worker) rollback was
not exercised — no earlier SHA differs in `dist/` yet; the procedure above is the
plan, unverified until the first real service rollback.

## Isolated tests

Never run the suite against the production database while the live worker runs:
tests read the same `DATABASE_URL` and share pg-boss queue names.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\test-isolated.ps1 -Init   # once: creates oikonomos_test and applies all migrations
powershell -ExecutionPolicy Bypass -File scripts\test-isolated.ps1         # full pnpm -r test against oikonomos_test, live worker stopped, watchdog re-enabled after
powershell -ExecutionPolicy Bypass -File scripts\test-isolated.ps1 -Filter @oikonomos/worker
```

The script derives the test URL by swapping the database name and never prints
it. After a new migration lands, re-run `-Init` (it is idempotent: it re-applies
every `up` file, which are written to be re-runnable; if one is not, drop and
recreate `oikonomos_test`).

## Known limitations (disclose in every release note)

- Host must be on and logged in (logon-triggered watchdog; no boot-without-logon).
- Watchdog detects "not running", not "running but broken"; no alerting.
- A worker restart loses the in-flight chat turn (no run-execution queue — TASK-246).
- Web and Android sessions are different tenants until TASK-241 lands.
- Routine schedules are evaluated without a time zone (TASK-247).
- The dynamic secret vault (`packages/db/src/secretVault.ts`, ADR-014) has no
  production composition site as of 2026-09-12; `OIK_SECRET_VAULT_KEY` is therefore
  listed as optional by `check-config.mjs` until it is wired.
