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
  [string]$Root = ""        # checkout to run tests in (a review worktree); defaults to this repo
)
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
if ($Root) { $repoRoot = (Resolve-Path $Root).Path }
$container = "oikonomos-postgres-local"
$testDb = "oikonomos_test"
$taskName = "OIKONOMOS-ServiceWatchdog"

$prod = [Environment]::GetEnvironmentVariable("DATABASE_URL", "User")
if (-not $prod) { $prod = $env:DATABASE_URL }
if (-not $prod) { throw "DATABASE_URL is not set (User scope or process)." }
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
$watchdogWasReady = (schtasks /Query /TN $taskName /FO LIST 2>$null | Select-String "Status:\s+Ready") -ne $null
try {
  if ($watchdogWasReady) { schtasks /Change /TN $taskName /DISABLE | Out-Null; Write-Host "[test-isolated] watchdog disabled" }
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
  if ($watchdogWasReady) { schtasks /Change /TN $taskName /ENABLE | Out-Null; Write-Host "[test-isolated] watchdog re-enabled (worker restarts within 2 minutes)" }
}
exit $code
