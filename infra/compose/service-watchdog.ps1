# TASK-229 — native Windows process supervision for control-api and
# worker on the workstation they currently run on (Tailscale host
# "studyworkstation"). Neither service previously had any supervisor:
# both were bare `node dist/index.js` / `node dist/main.js` foreground
# processes started by hand, with no auto-restart on crash and no
# start-on-boot — the direct cause of a real user-facing outage this
# session (jeff's bot went unanswered because control-api was running a
# stale build and worker had never been started at all in this
# environment). See PLAN.md TASK-229's Progress_Notes for the incident.
#
# pm2 was tried first and rejected: it accepted both apps as "online"
# with 0 restarts, yet neither ever bound its port or produced a single
# log line, even across a manual restart — broken in a way worth naming
# rather than fighting further. This script is deliberately simple and
# native instead: check each service by its actual TCP port / process
# command line, start it via the built-in Start-Process cmdlet if it
# isn't there, log every action. No extra runtime dependency beyond
# PowerShell and Node, both already required.
#
# Deployment: registered as a recurring Windows Scheduled Task (every 2
# minutes) — see docs/runbooks/service-supervision.md for the exact
# `schtasks` command. Running it by hand is also always safe (idempotent
# — does nothing if a service is already healthy).

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$logDir = Join-Path $repoRoot "infra\compose\logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logFile = Join-Path $logDir "watchdog.log"

function Write-WatchdogLog {
    param([string]$Message)
    $line = "[{0:yyyy-MM-ddTHH:mm:ssZ}] $Message" -f (Get-Date).ToUniversalTime()
    Add-Content -Path $logFile -Value $line
}

function Test-PortOpen {
    param([int]$Port)
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    return $null -ne $conn
}

function Start-OikonomosService {
    param(
        [string]$Name,
        [string]$WorkingDir,
        [string]$ScriptPath,
        [string]$OutLog,
        [string]$ErrLog
    )
    Write-WatchdogLog "$Name not detected as healthy - starting."
    $process = Start-Process -FilePath "node.exe" `
        -ArgumentList $ScriptPath `
        -WorkingDirectory $WorkingDir `
        -RedirectStandardOutput $OutLog `
        -RedirectStandardError $ErrLog `
        -WindowStyle Hidden `
        -PassThru
    Write-WatchdogLog "$Name started, pid $($process.Id)."
}

# --- control-api: healthy means port 3000 is listening ---
if (Test-PortOpen -Port 3000) {
    Write-WatchdogLog "control-api healthy (port 3000 listening)."
} else {
    Start-OikonomosService -Name "control-api" `
        -WorkingDir (Join-Path $repoRoot "services\control-api") `
        -ScriptPath "dist/index.js" `
        -OutLog (Join-Path $logDir "control-api-out.log") `
        -ErrLog (Join-Path $logDir "control-api-err.log")
}

# --- worker: no port to check (it's a queue consumer, not a server) ---
# so health is "a node.exe process with dist/main.js on its command line
# exists". CommandLine access requires Win32_Process (Get-Process alone
# doesn't expose it). The command line is genuinely just
# `"...\node.exe" dist/main.js` — the launch is relative to its own
# working directory, so "worker" itself never appears in CommandLine;
# matching for that (as an earlier version of this script did) is a
# false negative that spawns a SECOND, uncoordinated worker process
# alongside a real live one — confirmed by direct reproduction before
# this fix. `dist/main.js` alone is unambiguous: only the worker service
# has that entrypoint (control-api's is `dist/index.js`).
$workerRunning = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*dist*main.js*" }
if ($workerRunning) {
    Write-WatchdogLog "worker healthy (pid $($workerRunning[0].ProcessId))."
} else {
    Start-OikonomosService -Name "worker" `
        -WorkingDir (Join-Path $repoRoot "services\worker") `
        -ScriptPath "dist/main.js" `
        -OutLog (Join-Path $logDir "worker-out.log") `
        -ErrLog (Join-Path $logDir "worker-err.log")
}
