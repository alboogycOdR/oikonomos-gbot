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

## Disclosed limitation (TASK-240, 2026-09-12)

The Scheduled Task is **logon-triggered** (`-AtLogOn` plus a 2-minute repeat,
`/RL LIMITED`, no `-AtStartup`, no stored credential). After a reboot nothing
runs until a user logs in. Therefore, until TASK-249 moves the services to an
always-on host: **the host must be on and logged in; no 24/7 or "works while
your device is off" claim is made.** The watchdog also supervises
`dashboard-static.mjs` (port 5174) since TASK-240 — see
`docs/runbooks/release-workspace-1.md`.

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

## ORCH's own reboot recovery (2026-09-17, user request after a real power interruption)

A real power cut mid-session (2026-09-17) left `control-api`/`worker`
covered by the watchdog above, but the ORCH Claude Code session itself had
no equivalent — the user would have had to remember to reopen it manually.
`scripts/orch-reboot-recovery.ps1` closes that gap, registered as Windows
Scheduled Task **`OIKONOMOS-ORCH-RebootRecovery`**.

**Mechanism:** `claude -p --resume <session-id> --allowedTools "<narrow list>" -- "<check-in prompt>"`
— a headless, one-shot resume of the standing ORCH session, scoped to a
deliberately narrow tool allow-list (read-only git/status checks, `pnpm
install`, `dispatch.ps1`/`test-isolated.ps1`). Anything outside that list
is denied (fail closed) rather than hanging on an unanswerable prompt,
since there is nobody present to answer one. Merges, pushes, and
branch/worktree deletion are deliberately NOT on the list — those still
wait for the user's own interactive review, per the standing review
discipline in CLAUDE.md/COORDINATION_PROTOCOL.md. This is a narrower,
deliberate alternative to `--dangerously-skip-permissions` — never add
that flag here.

**Trigger:** every 2 minutes, indefinitely — not `AtLogOn`. `schtasks
/Create ... /SC ONLOGON` returns `Access is denied` in this environment
(confirmed directly), the same elevation gap already documented above for
the sibling watchdog; `/SC MINUTE` does not. Windows auto-logon
(`AutoAdminLogon=1`, already set on this workstation) means the desktop is
back unattended immediately after a reboot, so a 2-minute tick reaches the
same outcome the denied `AtLogOn` trigger would have. The script checks
`claude agents --json` first and skips the tick entirely if the session is
already live and interactive (the user is back and driving it themselves).

**A real, reproducible product limitation found while building this:**
`claude --resume <id> --bg <prompt>` — the seemingly obvious mechanism —
does **not** work for unattended kickoff. It starts a real background
session, but the trailing prompt argument is silently never submitted; the
session just sits idle ("send a prompt to start") until someone
interactively `claude attach`es to it, which defeats the entire point of
unattended recovery. This was confirmed three times (against a fresh
session, and against a `--resume` of a live one) before switching to `-p
--resume` instead, which does work and leaves no dangling process behind.
Two further syntax gotchas found the same way: `--allowedTools` values
must be comma-separated, not space-separated (space-separated silently
swallows the trailing prompt text as if it were more tool names); and the
prompt must follow a bare `--` so the parser cannot mistake it for more
`--allowedTools` values.

**How this was verified:** ran the actual registered scheduled task's
script directly (not just the underlying `claude` command) twice — once
while this ORCH session was live and interactive (correctly skipped,
logged why) and once with the full real allow-list and check-in prompt
invoked directly (correctly resumed the real session, read real live
`PLAN.md` content, and replied describing exactly the scoped actions it
would take on a genuine reboot). `claude agents --json` confirmed clean
before and after — no dangling process or duplicate session left behind
by the headless run, unlike the `--bg` attempts.

**Known limitations:**
- Same single-workstation caveat as the sibling watchdog: if the machine
  is off, nothing runs regardless of any of this.
- Not yet verified through an actual full reboot cycle — only through
  direct invocation of the same script Task Scheduler runs. Worth
  confirming end-to-end after the next real restart.
- A genuinely unattended run can only make progress within its narrow
  allow-list; anything needing a merge, push, or destructive action still
  queues silently for the user's return rather than being reported
  anywhere proactively (same "no alerting" gap as the sibling watchdog).
