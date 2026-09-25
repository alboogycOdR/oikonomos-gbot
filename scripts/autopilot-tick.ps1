# OIKONOMOS autopilot (L2) -- one supervisor tick, run every 5 minutes by the
# Windows Scheduled Task OIKONOMOS-Autopilot. The supervisor holds no state of
# its own (state lives in .devteam/ and PLAN.md), so a single tick per
# invocation is exactly equivalent to `supervisor.py --loop` and, unlike a
# long-lived loop, survives reboots and crashes with no recovery logic: the
# next scheduled tick simply resumes. Task Scheduler's default of "do not start
# a new instance if one is still running" means a long tick (a review can take
# many minutes) is never overlapped.
#
# SAFETY RAILS (see docs/AUTOPILOT.md):
#   * Create a file named STOP in the repo root to halt every tick immediately.
#   * `schtasks /Change /TN OIKONOMOS-Autopilot /DISABLE` turns it off entirely.
#   * autopilot.json: builders.active is CX9 + S5 only; budget.max_dispatches_per_hour = 6;
#     review_cmd carries the protected-path / cross-model rules for the unattended reviewer.
#   * Autopilot merges reviewed work to master. It NEVER deploys: applying migrations to
#     production, rebuilding and restarting services stay a deliberate, separate step.
$ErrorActionPreference = 'Continue'
# Location-independent (2026-09-25): resolve the repo root from this script's own path, so the same file
# works on any machine (this PC, a laptop) without editing.
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $RepoRoot

# Optional per-machine Node 22 folder: set OIKONOMOS_NODE22_DIR (a folder containing node.exe) if Node 22 is not already first on PATH.
if ($env:OIKONOMOS_NODE22_DIR -and (Test-Path (Join-Path $env:OIKONOMOS_NODE22_DIR 'node.exe'))) { $env:Path = $env:OIKONOMOS_NODE22_DIR + ';' + $env:Path }
elseif (Test-Path 'C:\tool\node22\node-v22.23.2-win-x64\node.exe') { $env:Path = 'C:\tool\node22\node-v22.23.2-win-x64;' + $env:Path }
if (-not $env:DATABASE_URL) { $env:DATABASE_URL = [Environment]::GetEnvironmentVariable('DATABASE_URL', 'User') }

$LogDir = Join-Path $RepoRoot 'infra\compose\logs'
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$Log = Join-Path $LogDir 'autopilot-tick.log'

# Keep the log bounded (rotate at ~2 MB, keep one previous generation).
if ((Test-Path $Log) -and ((Get-Item $Log).Length -gt 2MB)) { Move-Item -Path $Log -Destination ($Log + '.1') -Force }

Add-Content -Path $Log -Value ("=== tick {0} ===" -f (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'))
& python scripts/supervisor.py --once 2>&1 | ForEach-Object { Add-Content -Path $Log -Value ([string]$_) }
Add-Content -Path $Log -Value ("=== end (exit {0}) ===" -f $LASTEXITCODE)
