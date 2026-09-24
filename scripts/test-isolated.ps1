# TASK-240 — run the full test suite against the ISOLATED test database
# (`oikonomos_test` in the same local Postgres container) with the live
# worker stopped for the duration, so tests never share a pg-boss queue or
# fixture rows with production.
#
# Why: every test reads process.env.DATABASE_URL directly (~13 files) and
# pg-boss queue names are fixed literals (services/worker/src/jobs/
# workerJobQueue.ts), so "isolation" can only come from pointing the SAME
# variable at a different database and removing the live consumer. No test
# code changes. TASK-229's watchdog restarts the worker every 2 minutes, so
# the Scheduled Task is disabled while tests run and re-enabled in `finally`.
#
# The test DATABASE_URL is derived from the production one by swapping the
# database name — the value is never printed. Create the database once with
# scripts/test-isolated.ps1 -Init (applies every migration).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/test-isolated.ps1 [-Init] [-Filter <pnpm filter>]

param(
  [switch]$Init,
  [string]$Filter = "",
  [string]$Root = "",       # checkout to run tests in (a review worktree); defaults to this repo
  [switch]$SelfTestWatchdogQueryTimeout
)
$ErrorActionPreference = "Stop"

function Get-WatchdogReady {
  param(
    [string]$QueryExecutable = "schtasks.exe",
    [string]$QueryArguments = "/Query /TN `"OIKONOMOS-ServiceWatchdog`" /FO LIST",
    [int]$TimeoutSeconds = 10
  )

  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $QueryExecutable
  $startInfo.Arguments = $QueryArguments
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo

  try {
    if (-not $process.Start()) { throw "could not start watchdog status query" }
    # Task Scheduler has hung indefinitely on this workstation. Ten seconds is
    # ample for a local task query, while keeping the only sanctioned test
    # harness responsive when the Scheduler service is wedged.
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      $process.Kill()
      $process.WaitForExit()
      Write-Warning "[test-isolated] watchdog status query timed out after ${TimeoutSeconds}s; proceeding without disabling the watchdog."
      return $false
    }
    $output = $process.StandardOutput.ReadToEnd()
    return $process.ExitCode -eq 0 -and $output -match "Status:\s+Ready"
  } finally {
    $process.Dispose()
  }
}

if ($SelfTestWatchdogQueryTimeout) {
  $timer = [System.Diagnostics.Stopwatch]::StartNew()
  # Inject a deliberately hanging query executable so this verifies the
  # timeout path without depending on the workstation's Task Scheduler state.
  # Use THIS process's own executable rather than a hardcoded name -- $PSHOME
  # holds pwsh.exe under PowerShell 7 and powershell.exe under Windows
  # PowerShell 5.1, and assuming the wrong one made this self-test itself
  # fail to even launch on a pwsh-based workstation (found live, 2026-09-18).
  $selfExe = (Get-Process -Id $PID).Path
  $ready = Get-WatchdogReady -QueryExecutable $selfExe -QueryArguments "-NoProfile -NonInteractive -Command `"Start-Sleep -Seconds 30`"" -TimeoutSeconds 1
  $timer.Stop()
  if ($ready) { throw "watchdog timeout self-test unexpectedly reported Ready" }
  if ($timer.Elapsed.TotalSeconds -gt 5) { throw "watchdog timeout self-test exceeded five seconds" }
  Write-Host "[test-isolated] watchdog timeout self-test passed in $([Math]::Round($timer.Elapsed.TotalSeconds, 2))s"
  exit 0
}

# 2026-09-19: ONE shared test database, many concurrent builders. Each builder
# runs -Init from its own worktree, which applies only THAT worktree's
# migrations, so two overlapping runs corrupt each other (relation
# "project_roles" does not exist, FK failures on leftover fixtures, a
# "reproducible" failure that no one else can reproduce). Serialise every
# database-touching run behind a machine-wide named mutex. Windows releases it
# automatically if the holder dies, so a killed session cannot deadlock the
# queue (the next waiter just sees AbandonedMutexException and proceeds).
$script:TestDbLock = New-Object System.Threading.Mutex($false, 'Global\OIKONOMOS-test-isolated')
$lockAcquired = $false
try {
  $lockAcquired = $script:TestDbLock.WaitOne(0)
  if (-not $lockAcquired) {
    Write-Host "[test-isolated] another test run holds the shared test-database lock; waiting (up to 60 min)..."
    $lockAcquired = $script:TestDbLock.WaitOne(60 * 60 * 1000)
  }
} catch [System.Threading.AbandonedMutexException] {
  $lockAcquired = $true   # previous holder died; the lock is ours
}
if (-not $lockAcquired) { Write-Error "[test-isolated] gave up waiting for the shared test-database lock after 60 minutes."; exit 2 }
Write-Host "[test-isolated] holding the shared test-database lock"

$repoRoot = Split-Path -Parent $PSScriptRoot
if ($Root) { $repoRoot = (Resolve-Path $Root).Path }
$container = "oikonomos-postgres-local"
$testDb = "oikonomos_test"
$taskName = "OIKONOMOS-ServiceWatchdog"

$prod = [Environment]::GetEnvironmentVariable("DATABASE_URL", "User")
if (-not $prod) { $prod = $env:DATABASE_URL }
if (-not $prod) { throw "DATABASE_URL is not set (User scope or process)." }

# 2026-09-24 (ORCH): scrub operator configuration from THIS process before any
# node/pnpm child runs. Everything except DATABASE_URL used to pass through, so
# OIK_DEFAULT_ROLE_PROVIDER=gemini + GEMINI_API_KEY routed provider-less test
# roles onto the live Gemini lane (real paid calls, HTTP 402, 5s timeouts): ~22
# worker failures that were really the operator's shell. Tests that need one of
# these set it themselves. Process scope only; the User-scope values are untouched.
$scrubPattern = '^(OIK_|OIKONOMOS_|GEMINI_|GOOGLE_API_KEY$|ANTHROPIC_|OPENAI_|OPENROUTER_|FREELLMAPI_|USD_TO_ZAR_RATE$)'
$scrubbed = @(Get-ChildItem env: | Where-Object { $_.Name -match $scrubPattern } | ForEach-Object { $_.Name })
foreach ($n in $scrubbed) { Remove-Item -Path "env:$n" -ErrorAction SilentlyContinue }
# Liveness (ADR-005): fail if the scrub is inert, i.e. a matching variable survived it.
$survivors = @(Get-ChildItem env: | Where-Object { $_.Name -match $scrubPattern })
if ($survivors.Count -gt 0) { throw "[test-isolated] env scrub inert: $($survivors.Name -join ', ') still set" }
Write-Host "[test-isolated] scrubbed $($scrubbed.Count) operator env var(s) from the test process"

# 2026-09-24 (owner request): test/dev Gemini traffic bills a SEPARATE key, never
# the production one. Opt-in: set User-scope TEST_GEMINI_API_KEY to a key from a
# dedicated AI Studio project. Only live tests that pin provider gemini use it;
# provider-less test roles still fall back to Claude (no default is re-exported).
$devGeminiKey = [Environment]::GetEnvironmentVariable("TEST_GEMINI_API_KEY", "User")
if ($devGeminiKey) {
  $prodGeminiKey = [Environment]::GetEnvironmentVariable("GEMINI_API_KEY", "User")
  # Liveness: refuse if the "dev" key is really the production key.
  if ($prodGeminiKey -and $devGeminiKey -eq $prodGeminiKey) {
    throw "[test-isolated] TEST_GEMINI_API_KEY equals the production GEMINI_API_KEY; create a separate key for tests"
  }
  $env:GEMINI_API_KEY = $devGeminiKey
  Write-Host "[test-isolated] Gemini: using the dedicated TEST key (production key not exposed)"
} else {
  Write-Host "[test-isolated] Gemini: no TEST_GEMINI_API_KEY set; tests cannot reach Gemini"
}
Remove-Item -Path env:TEST_GEMINI_API_KEY -ErrorAction SilentlyContinue
$uri = [Uri]$prod
if ($uri.AbsolutePath -eq "/$testDb") { throw "DATABASE_URL already points at $testDb; refusing to guess the production name." }
$testUrl = $prod.Substring(0, $prod.LastIndexOf("/")) + "/$testDb" + $uri.Query

$pgUser = (docker exec $container printenv POSTGRES_USER).Trim()

if ($Init) {
  # The migrations are not re-runnable (016_routine_parity fails on a second
  # apply), so -Init always drops and recreates the DISPOSABLE test database.
  # This script never touches any database other than $testDb.
  docker exec $container psql -U $pgUser -d postgres -v ON_ERROR_STOP=1 -q -c "DROP DATABASE IF EXISTS $testDb WITH (FORCE)" | Out-Null
  docker exec $container psql -U $pgUser -d postgres -v ON_ERROR_STOP=1 -q -c "CREATE DATABASE $testDb" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "CREATE DATABASE $testDb failed" }
  Write-Host "[test-isolated] recreated database $testDb"
  # Copy each migration into the container and apply it there: piping file
  # content through Windows PowerShell re-encodes it, `docker cp` does not.
  Get-ChildItem (Join-Path $repoRoot "infra\postgres\migrations\*.up.sql") | Sort-Object Name | ForEach-Object {
    Write-Host "[test-isolated] applying $($_.Name)"
    docker cp $_.FullName "${container}:/tmp/oik-migration.sql" | Out-Null
    docker exec $container psql -U $pgUser -d $testDb -v ON_ERROR_STOP=1 -q -f /tmp/oik-migration.sql | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "migration $($_.Name) failed on $testDb" }
  }
  docker exec $container rm -f /tmp/oik-migration.sql | Out-Null
  # Baseline rows the suite assumes exist (found 2026-09-12 on a pristine database:
  # packages/db's capabilities.test.ts and inbox-triage.integration.test.ts expect the
  # `inbox-triage` role and the Gmail capability seed, which production got by hand,
  # not by migration). Idempotent.
  docker exec $container psql -U $pgUser -d $testDb -v ON_ERROR_STOP=1 -q -c "INSERT INTO roles (role_id, tenant_id, name, title) VALUES ('inbox-triage','basileia','Inbox Triage','Inbox Triage') ON CONFLICT (role_id) DO NOTHING" | Out-Null
  $env:DATABASE_URL = $testUrl
  node (Join-Path $repoRoot "packages\db\dist\seedInboxTriage.js")
  if ($LASTEXITCODE -ne 0) { throw "inbox-triage seed failed on $testDb" }
  # Register every connector manifest + built-in tool into the test database
  # (the broker fails closed on an unregistered capability, and 45 tests across
  # worker/control-api/evals exercise the real registry — observed 2026-09-12).
  Push-Location (Join-Path $repoRoot "services\worker")
  try { node dist/registerCapabilities.js; if ($LASTEXITCODE -ne 0) { throw "register-capabilities failed on $testDb" } }
  finally { Pop-Location }
  Write-Host "[test-isolated] $testDb ready (migrations + baseline seed + registered capabilities)"
  if (-not $Filter -and -not $PSBoundParameters.ContainsKey("Filter")) { return }
}

Write-Host "[test-isolated] database: $testDb (container $container)"
# TASK-261: an independent guardian (scripts/watchdog-guardian.ps1, its own
# Scheduled Task) watches for this marker and force-re-enables the watchdog
# if it goes stale -- a backstop for the case where this script itself is
# killed before the `finally` below can run. The `finally` stays the fast
# path; this marker is only ever consulted if that fast path never fires.
#
# The guardian task always watches the MAIN repo's infra/compose/logs, never
# a -Root review worktree's own copy (which may not have that directory at
# all -- confirmed live: this crashed every -Root invocation, including
# review runs, before any test could execute). Resolve the marker path from
# this script's own physical location (always the main repo, regardless of
# -Root), not from $repoRoot (which -Root overrides).
#
# 2026-09-19 FIX: "this script's own physical location" is only the main repo
# when THIS copy of the script is the main checkout's. A builder runs its own
# worktree's copy, so `Split-Path -Parent $PSScriptRoot` resolved to the
# WORKTREE, the marker landed there, the guardian never saw it, and a builder
# session that ended mid-run left the watchdog disabled and the worker down
# (live outage, 2026-09-19 ~09:10). Every worktree shares one git common dir,
# whose parent is the main checkout -- resolve from that instead.
$mainRepoRoot = Split-Path -Parent $PSScriptRoot
$gitCommonDir = (& git -C $PSScriptRoot rev-parse --path-format=absolute --git-common-dir 2>$null)
if ($LASTEXITCODE -eq 0 -and $gitCommonDir) { $mainRepoRoot = Split-Path -Parent ($gitCommonDir | Select-Object -First 1).Trim() }
$watchdogMarker = Join-Path $mainRepoRoot "infra\compose\logs\watchdog-disabled.marker"
$watchdogMarkerDir = Split-Path -Parent $watchdogMarker
if (-not (Test-Path $watchdogMarkerDir)) { New-Item -ItemType Directory -Path $watchdogMarkerDir -Force | Out-Null }
$watchdogWasReady = Get-WatchdogReady
try {
  if ($watchdogWasReady) {
    schtasks /Change /TN $taskName /DISABLE | Out-Null
    Set-Content -Path $watchdogMarker -Value (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    Write-Host "[test-isolated] watchdog disabled (guardian marker written)"
  }
  $workers = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*dist*main.js*" }
  foreach ($w in $workers) { Stop-Process -Id $w.ProcessId -Force; Write-Host "[test-isolated] stopped live worker pid $($w.ProcessId)" }

  $env:DATABASE_URL = $testUrl
  Push-Location $repoRoot
  try {
    # --no-bail: report every package, not just the first failing one.
    if ($Filter) { pnpm --filter $Filter test } else { pnpm -r --no-bail --workspace-concurrency=1 test }
    $code = $LASTEXITCODE
  } finally { Pop-Location }
  Write-Host "[test-isolated] pnpm exit code $code (database $testDb)"
} finally {
  if ($watchdogWasReady) {
    schtasks /Change /TN $taskName /ENABLE | Out-Null
    Remove-Item -Path $watchdogMarker -Force -ErrorAction SilentlyContinue
    Write-Host "[test-isolated] watchdog re-enabled (worker restarts within 2 minutes)"
  }
}
exit $code
