# Runbook — control-api / worker process supervision

**Status:** live, tested (TASK-229). **Owner:** ORCH.

## What this is

`control-api` and `worker` run on the Tailscale host `studyworkstation` (a
personal Windows dev workstation, not a server). Until TASK-229, both were
bare `node dist/index.js` / `node dist/main.js` foreground processes
started by hand in a terminal, with no supervision at all: no auto-restart
on crash, no start-on-boot. If the machine slept, restarted, or the
terminal closed, both silently died and stayed dead until someone noticed
— which is exactly what caused a real user-facing outage (a bot went
unanswered) this session.

This is scoped deliberately to *this workstation*. It is not a migration
to `clawsrv` or a systemd/docker-compose production deployment — that is a
separate, larger decision about where the product is hosted long-term.

## The mechanism

`infra/compose/service-watchdog.ps1` checks both services and starts
whichever one isn't running:

- **control-api**: healthy = port 3000 is listening (`Get-NetTCPConnection`).
- **worker**: healthy = a `node.exe` process exists whose command line
  contains `dist/main.js` (worker has no port of its own — it's a queue
  consumer, not a server).

It is registered as a Windows Scheduled Task, **`OIKONOMOS-ServiceWatchdog`**,
that runs at login and every 2 minutes thereafter, indefinitely. Output
goes to `infra/compose/logs/` (`watchdog.log` for the check/restart
decisions themselves, `control-api-out.log`/`control-api-err.log` and
`worker-out.log`/`worker-err.log` for each service's own stdout/stderr).

### Why not pm2 or docker-compose

pm2 was tried first (the natural cross-platform choice) and rejected: it
reported both apps as `online` with 0 restarts, yet neither ever bound a
port or produced a single log line, even across a manual restart —
reproducible, not a fluke. Docker-compose already runs the local dev
Postgres (`infra/compose/docker-compose.local.yml`, `restart:
unless-stopped`) but that only helps once Docker Desktop itself is
running, and Docker Desktop has no bundled equivalent for two plain Node
services. A native Scheduled Task avoids all of this: no extra runtime
dependency beyond PowerShell and Node, both already required, and it is
provably reliable — see "How this was verified" below.

## One-time setup (already done on this workstation)

```powershell
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument '-NoProfile -ExecutionPolicy Bypass -File "E:\DELL-PROJECTS\GROKBOT-CLONE\infra\compose\service-watchdog.ps1"'
$trigger1 = New-ScheduledTaskTrigger -AtLogOn
$trigger2 = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 2) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName "OIKONOMOS-ServiceWatchdog" `
    -Action $action -Trigger @($trigger1, $trigger2) -Settings $settings `
    -Description "Checks control-api (port 3000) and worker (dist/main.js) every 2 minutes and restarts either if not running." `
    -RunLevel Limited
```

`Register-ScheduledTask` itself returned `Access is denied` in this
environment even at `-RunLevel Limited`; the classic `schtasks /Create`
CLI form worked without elevation:

```
schtasks /Create /TN "OIKONOMOS-ServiceWatchdog" /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"E:\DELL-PROJECTS\GROKBOT-CLONE\infra\compose\service-watchdog.ps1\"" /SC MINUTE /MO 2 /RL LIMITED /F
```

`DATABASE_URL` and every other required env var must be set at **User**
scope (`[Environment]::SetEnvironmentVariable(name, value, "User")`) —
the Scheduled Task launches a genuinely fresh process each time, which
reads User-scope environment variables from the registry correctly (this
is more reliable here than an already-running shell's `$env:`, which has
been observed stale after a rotation in this same environment — see
CLAUDE.md's `orchestrator_notes` history).

## Operating it

```powershell
# Check status / next run time
schtasks /Query /TN "OIKONOMOS-ServiceWatchdog" /V /FO LIST

# Force an immediate check (safe to run any time — idempotent)
schtasks /Run /TN "OIKONOMOS-ServiceWatchdog"

# Watch the logs
Get-Content E:\DELL-PROJECTS\GROKBOT-CLONE\infra\compose\logs\watchdog.log -Tail 20
Get-Content E:\DELL-PROJECTS\GROKBOT-CLONE\infra\compose\logs\control-api-out.log -Tail 20
Get-Content E:\DELL-PROJECTS\GROKBOT-CLONE\infra\compose\logs\worker-out.log -Tail 20

# Stop supervision entirely (e.g. for a deliberate maintenance window)
schtasks /End /TN "OIKONOMOS-ServiceWatchdog"
schtasks /Change /TN "OIKONOMOS-ServiceWatchdog" /DISABLE
```

After a code change, rebuild before the next watchdog tick picks up the
old build:

```
pnpm --filter @oikonomos/control-api build
pnpm --filter @oikonomos/worker build
```

(The watchdog only starts a service that isn't running — it does not
detect "running but stale" the way TASK-229's own incident did. Kill the
process yourself after a rebuild; the next tick, within 2 minutes,
restarts it on the fresh build.)

## How this was verified (control-liveness, not just "the config exists")

Per CLAUDE.md's control-liveness rule, config being present proves
nothing on its own. This was proven live, twice, the second time through
the actual deployed mechanism rather than a manual script run:

1. Both services killed by PID.
2. `service-watchdog.ps1` run directly — both detected as down, both
   restarted, `control-api`'s `/health` responded again.
3. Both killed again.
4. **`schtasks /Run /TN "OIKONOMOS-ServiceWatchdog"`** — the real
   Scheduled Task, not the script invoked by hand — both restarted with
   the correct environment (`DATABASE_URL` etc.), `/health` responded
   again.
5. A genuinely healthy pair, re-checked, produces zero restarts (proven
   idempotent — the watchdog does not thrash a working system).

A real bug was caught and fixed during this process: the worker
health-check's first version matched `CommandLine -like "*worker*dist*main.js*"`,
but a real process's `CommandLine` is just `"...\node.exe" dist/main.js`
— `"worker"` never appears in it (it comes from the working directory,
which `Win32_Process.CommandLine` doesn't include). That false negative
spawned a **second, uncoordinated worker process** alongside a real live
one. Fixed to match on `*dist*main.js*` alone (unambiguous — only the
worker service has that entrypoint), and re-verified idempotent
afterward.

## Known limitations (recorded honestly, not left silent)

- Detects "not running," not "running but broken/stale" — a hung or
  stale-build process that's still alive is not restarted automatically.
- Single workstation only. If this machine is off, both services are
  down regardless of the watchdog — it supervises processes, not power.
- The local dev Postgres (`docker-compose.local.yml`) needs Docker
  Desktop running first; the watchdog does not start Docker Desktop
  itself. Configure Docker Desktop's own "Start Docker Desktop when you
  sign in" setting for that.
- No alerting — a failed restart (`max` retries aside, this watchdog has
  no retry cap and will keep trying every 2 minutes forever) is visible
  only in the logs, not pushed anywhere. Pairs naturally with TASK-230's
  latency monitoring as a future "is anything actually wrong" surface.
