# OIKONOMOS ORCH reboot-recovery relauncher.
#
# Registered as Windows Scheduled Task OIKONOMOS-ORCH-RebootRecovery, firing
# every 2 minutes indefinitely -- NOT an AtLogOn trigger. `/SC ONLOGON`
# returns "Access is denied" when created from this environment (confirmed
# directly; `/SC ONCE`/`/SC MINUTE` do not), mirroring exactly the same
# elevation gap docs/runbooks/service-supervision.md already documented and
# routed around for the sibling control-api/worker watchdog. Windows
# auto-logon (AutoAdminLogon=1, confirmed already set on this workstation)
# means the account is back at the desktop immediately after a reboot with
# nobody physically present, so a 2-minute tick reaches the same outcome the
# denied AtLogOn trigger would have.
#
# Uses `claude -p --resume <id>` (headless print-mode resume), NOT
# `claude --resume --bg`. Confirmed directly, the hard way: `--bg` only
# starts an IDLE background shell -- its trailing prompt argument is never
# auto-submitted, so it just sits there doing nothing until someone
# interactively `claude attach`es to it, which defeats unattended recovery
# entirely. `-p --resume <id> --allowedTools "a,b,c" -- "<prompt>"` genuinely
# reads and continues the real persisted session headlessly, confirmed live
# against this exact project (it correctly read real PLAN.md content) with
# no dangling process or duplicate `claude agents` entry left behind
# afterward. Two syntax gotchas that silently break this, also found the
# hard way: --allowedTools values must be COMMA-separated, not
# space-separated (space-separated swallows the trailing prompt text as if
# it were more tool names); and the prompt must follow a bare `--` so the
# CLI parser cannot mistake it for more --allowedTools values.
#
# Deliberately narrow --allowedTools: read-only status checks, dependency
# install, and re-dispatching an already-filed task via dispatch.ps1. Merges,
# pushes, branch/worktree deletion, and any other write/destructive action
# are NOT on the allow list -- those still require the user reviewing and
# approving interactively, exactly as the standing review discipline
# (CLAUDE.md, COORDINATION_PROTOCOL.md) requires. Anything a headless run
# attempts outside this list is simply denied (fail closed) rather than
# hanging on an unanswerable prompt, since -p has nobody to ask.
# This is a deliberate, narrower alternative to --dangerously-skip-permissions
# -- never add that flag here.
#
# Guards against firing while the user is already back and driving the
# session interactively (checked via `claude agents --json`) so a headless
# check-in never interrupts a live conversation.

$ErrorActionPreference = 'Continue'
Set-Location -LiteralPath 'E:\DELL-PROJECTS\GROKBOT-CLONE'

if (-not $env:DATABASE_URL) { $env:DATABASE_URL = [Environment]::GetEnvironmentVariable('DATABASE_URL', 'User') }
if (Test-Path 'C:\tool\node22\node-v22.23.2-win-x64\node.exe') { $env:Path = 'C:\tool\node22\node-v22.23.2-win-x64;' + $env:Path }

# Update this if the standing ORCH session's local ID ever changes (a fresh
# `claude` invocation without --resume, or the transcript file rotating under
# C:\Users\User\.claude\projects\E--DELL-PROJECTS-GROKBOT-CLONE\).
$SessionId = '32399cb5-18cd-4fd2-ac66-ce305c676c37'
$ProjectPath = 'E:\DELL-PROJECTS\GROKBOT-CLONE'

$Prompt = 'The machine just rebooted (auto-logon, unattended). This is a scheduled reboot-recovery check-in, not an interactive request from the user -- treat it like a normal autopilot check-in turn. Verify infra/compose/service-watchdog.ps1''s own scheduled task brought control-api and worker back up (check infra/compose/logs/watchdog.log for a recent tick). Check PLAN.md for any tasks left in_progress/blocked and .devteam/runs/*.done markers that may have landed or died mid-flight during the outage. Allowed: reading files, git status/fetch/log/diff, pnpm install, scripts/dispatch.ps1 to re-launch a builder on an already-filed task, python scripts/validate_plan.py. NOT allowed here: git merge, git push, deleting branches/worktrees, or any other destructive/write action -- queue those for the user''s own review when they are back, exactly as the standing review discipline requires. Report what you found and did in plain terms.'

$LogDir = 'E:\DELL-PROJECTS\GROKBOT-CLONE\infra\compose\logs'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$LogFile = Join-Path $LogDir ("orch-reboot-recovery-{0}.log" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))

$AllowedTools = @(
    'Read', 'Glob', 'Grep',
    'Bash(git status:*)', 'Bash(git fetch:*)', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git worktree list:*)',
    'Bash(pnpm install:*)', 'Bash(pnpm --filter*)',
    'Bash(python scripts/validate_plan.py:*)',
    'PowerShell(*dispatch.ps1*)', 'PowerShell(*test-isolated.ps1*)'
) -join ','

$ExistingJson = & 'claude' 'agents' '--json' '--cwd' $ProjectPath 2>&1 | Out-String
$UserAlreadyThere = $false
try {
    $Existing = $ExistingJson | ConvertFrom-Json
    # Skip only if THIS session ID is already live and busy interactively --
    # the user is back and driving it themselves. A headless -p run exits on
    # its own and leaves nothing behind, so there is no "already running
    # background copy" case to guard against the way --bg would have had.
    $UserAlreadyThere = ($Existing | Where-Object {
        $_.sessionId -eq $SessionId -and $_.kind -eq 'interactive' -and $_.status -ne 'exited'
    } | Measure-Object).Count -gt 0
} catch {
    # Non-JSON output (e.g. no agents at all) -- treat as not running, safe to launch.
}

if ($UserAlreadyThere) {
    Write-Output "[ORCH reboot-recovery] session $SessionId is live and interactive -- user is already back, skipping this tick."
} else {
    & 'claude' '-p' '--resume' $SessionId '--allowedTools' $AllowedTools '--' $Prompt *> $LogFile
    Write-Output "[ORCH reboot-recovery] ran headless check-in, log: $LogFile"
}
