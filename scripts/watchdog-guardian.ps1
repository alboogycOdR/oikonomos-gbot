# TASK-261 — independent backstop for the ServiceWatchdog disable/re-enable
# pattern used by scripts/test-isolated.ps1 (and any future script that
# needs the watchdog paused for a bounded window).
#
# Why this exists: test-isolated.ps1 disables OIKONOMOS-ServiceWatchdog
# before running tests and re-enables it in its own `finally` block. That
# `finally` is the fast path and stays exactly as-is — but PowerShell does
# not guarantee a `finally` runs across an abrupt/external process kill,
# and this has now left the watchdog stuck Disabled (with the live worker
# dead and nothing supervising it) at least three times in one session
# (2026-09-15), each time only caught because a human happened to notice.
#
# This script is a SEPARATE, independent mechanism: it does not run inside
# test-isolated.ps1's own process, so it survives that script being killed
# outright. It is meant to be registered as its own lightweight Scheduled
# Task (see Register-WatchdogGuardianTask.ps1 below / TASK-261's dossier),
# running every few minutes, completely decoupled from whatever disabled
# the watchdog in the first place.
#
# Mechanism: any script that disables the watchdog writes a timestamped
# marker file first (see test-isolated.ps1's own updated disable/finally
# block). This script checks that marker: if it is older than
# $StaleThresholdMinutes AND the watchdog task is currently Disabled, it
# force-re-enables the watchdog and removes the marker, logging the
# recovery. If the marker is missing, fresh, or the watchdog is already
# Enabled, it does nothing (idempotent, safe to run as often as desired).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/watchdog-guardian.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/watchdog-guardian.ps1 -StaleThresholdMinutes 1   # for testing

param(
  [int]$StaleThresholdMinutes = 8,
  [string]$MarkerPath = "",
  [string]$LogPath = ""
)
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$taskName = "OIKONOMOS-ServiceWatchdog"
if (-not $MarkerPath) { $MarkerPath = Join-Path $repoRoot "infra\compose\logs\watchdog-disabled.marker" }
if (-not $LogPath) { $LogPath = Join-Path $repoRoot "infra\compose\logs\watchdog-guardian.log" }

function Write-GuardianLog([string]$msg) {
  # -AsUTC is PowerShell 7.1+ only; this repo's scripts target Windows
  # PowerShell 5.1 (see dispatch.ps1's own convention) so use
  # ToUniversalTime() instead, which works on both.
  $ts = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  $line = "[$ts] $msg"
  Add-Content -Path $LogPath -Value $line
}

if (-not (Test-Path $MarkerPath)) {
  # Nothing to do — no disabling script currently claims to have the
  # watchdog paused. This is the overwhelmingly common case; stay silent
  # in the log to keep it readable (only log actual findings/actions).
  exit 0
}

$markerAgeMinutes = (New-TimeSpan -Start (Get-Item $MarkerPath).LastWriteTimeUtc -End (Get-Date).ToUniversalTime()).TotalMinutes

if ($markerAgeMinutes -lt $StaleThresholdMinutes) {
  # A legitimate, still-running disable (e.g. test-isolated.ps1 mid-suite).
  # Do nothing — this is exactly the case the guardian must NOT interfere
  # with, or it would fight a real, in-progress test run.
  exit 0
}

# Marker is stale. Check whether the watchdog is actually still Disabled
# (it may already be Enabled if the disabling script's own `finally` DID
# run but simply failed to clean up its marker — a lesser, cosmetic bug
# worth logging but not worth re-touching an already-healthy task for).
$isDisabled = (schtasks /Query /TN $taskName /FO LIST 2>$null | Select-String "Status:\s+Disabled") -ne $null

if ($isDisabled) {
  schtasks /Change /TN $taskName /ENABLE | Out-Null
  Write-GuardianLog "RECOVERED: marker was $([math]::Round($markerAgeMinutes,1))min old and watchdog was Disabled -- force re-enabled. Marker: $MarkerPath"
} else {
  Write-GuardianLog "STALE MARKER ONLY: marker was $([math]::Round($markerAgeMinutes,1))min old but watchdog was already Enabled -- the disabling script's own re-enable ran, it just didn't clean up its marker. No action needed on the task itself."
}

Remove-Item -Path $MarkerPath -Force -ErrorAction SilentlyContinue
