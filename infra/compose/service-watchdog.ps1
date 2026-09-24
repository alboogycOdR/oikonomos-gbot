# TASK-326 — native Windows supervision plus database readiness detection.
[CmdletBinding()]
param([switch]$SelfTest)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Net.Http
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$logDir = Join-Path $repoRoot "infra\compose\logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

function Write-WatchdogLog {
    param([string]$Message, [string]$LogDir = $logDir)
    $line = "[{0:yyyy-MM-ddTHH:mm:ssZ}] $Message" -f (Get-Date).ToUniversalTime()
    Add-Content -Path (Join-Path $LogDir "watchdog.log") -Value $line
    return $line
}

function Test-PortOpen {
    param([int]$Port)
    return $null -ne (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Start-OikonomosService {
    param([string]$Name, [string]$WorkingDir, [string]$ScriptPath, [string]$OutLog, [string]$ErrLog)
    Write-WatchdogLog "$Name not detected as healthy - starting."
    $process = Start-Process -FilePath "node.exe" -ArgumentList $ScriptPath -WorkingDirectory $WorkingDir `
        -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog -WindowStyle Hidden -PassThru
    Write-WatchdogLog "$Name started, pid $($process.Id)."
}

function Get-DatabaseReadiness {
    param([string]$Url)
    $client = [System.Net.Http.HttpClient]::new()
    $client.Timeout = [TimeSpan]::FromSeconds(3)
    try {
        $response = $client.GetAsync($Url).GetAwaiter().GetResult()
        if ($response.StatusCode -eq [System.Net.HttpStatusCode]::OK) { return @{ Ready = $true; Category = $null } }
        $category = "db_unreachable"
        try {
            $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json
            if ($body.category -in @("db_unreachable", "db_timeout")) { $category = [string]$body.category }
        } catch { }
        return @{ Ready = $false; Category = $category }
    } catch [System.Threading.Tasks.TaskCanceledException] {
        return @{ Ready = $false; Category = "db_timeout" }
    } catch {
        return @{ Ready = $false; Category = "db_unreachable" }
    } finally { $client.Dispose() }
}

function Invoke-DatabaseWatchdog {
    param([string]$ReadinessUrl, [string]$LogDir, [switch]$DisableDockerRestart)
    $marker = Join-Path $LogDir "db-unreachable.marker"
    $failuresPath = Join-Path $LogDir "db-unreachable.failures"
    $restartPath = Join-Path $LogDir "docker-restart.last"
    $readiness = Get-DatabaseReadiness -Url $ReadinessUrl
    if ($readiness.Ready) {
        if (Test-Path $marker) {
            $firstSeen = (Get-Content -Raw $marker).Trim()
            Remove-Item -LiteralPath $marker -Force
            Remove-Item -LiteralPath $failuresPath -Force -ErrorAction SilentlyContinue
            $duration = "unknown"
            try { $duration = ((Get-Date).ToUniversalTime() - [DateTime]::Parse($firstSeen).ToUniversalTime()).ToString() } catch { }
            Write-WatchdogLog "DATABASE RECOVERED (outage duration $duration)." -LogDir $LogDir | Out-Null
        }
        return $true
    }

    Write-WatchdogLog "DATABASE UNREACHABLE ($($readiness.Category))" -LogDir $LogDir | Out-Null
    if (-not (Test-Path $marker)) { Set-Content -LiteralPath $marker -Value ((Get-Date).ToUniversalTime().ToString("o")) }
    $failures = 0
    if (Test-Path $failuresPath) { [void][int]::TryParse((Get-Content -Raw $failuresPath).Trim(), [ref]$failures) }
    $failures++; Set-Content -LiteralPath $failuresPath -Value $failures

    if (-not $DisableDockerRestart -and $env:OIK_WATCHDOG_RESTART_DOCKER -eq "1" -and $failures -ge 3) {
        $lastRestart = [DateTime]::MinValue
        if (Test-Path $restartPath) { try { $lastRestart = [DateTime]::Parse((Get-Content -Raw $restartPath).Trim()).ToUniversalTime() } catch { } }
        if (((Get-Date).ToUniversalTime() - $lastRestart).TotalMinutes -ge 30) {
            Write-WatchdogLog "DATABASE UNREACHABLE ($($readiness.Category)); requesting opt-in Docker Desktop restart." -LogDir $LogDir | Out-Null
            try {
                & docker desktop restart
                Set-Content -LiteralPath $restartPath -Value ((Get-Date).ToUniversalTime().ToString("o"))
            } catch { Write-WatchdogLog "Docker Desktop restart request failed." -LogDir $LogDir | Out-Null }
        }
    }
    return $false
}

function Invoke-WatchdogSelfTest {
    $testLogDir = Join-Path ([System.IO.Path]::GetTempPath()) ("oikonomos-watchdog-" + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $testLogDir -Force | Out-Null
    $stub = Start-Job {
        $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
        $listener.Start(); Write-Output $listener.LocalEndpoint.Port
        foreach ($status in @(503, 200)) {
            $client = $listener.AcceptTcpClient(); $stream = $client.GetStream()
            $reader = [System.IO.StreamReader]::new($stream); while (($line = $reader.ReadLine()) -ne "") { }
            $body = if ($status -eq 503) { '{"category":"db_unreachable"}' } else { '{"status":"ok"}' }
            $bytes = [System.Text.Encoding]::ASCII.GetBytes("HTTP/1.1 $status OK`r`nContent-Type: application/json`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n$body")
            $stream.Write($bytes, 0, $bytes.Length); $client.Dispose()
        }
        $listener.Stop()
    }
    do { Start-Sleep -Milliseconds 50; $port = Receive-Job $stub } while ($null -eq $port)
    $url = "http://127.0.0.1:$port/health/ready"
    if (Invoke-DatabaseWatchdog -ReadinessUrl $url -LogDir $testLogDir -DisableDockerRestart) { throw "Self-test expected a failed readiness probe." }
    $marker = Join-Path $testLogDir "db-unreachable.marker"
    $log = Get-Content -Raw (Join-Path $testLogDir "watchdog.log")
    if (-not (Test-Path $marker) -or $log -notmatch "DATABASE UNREACHABLE \(db_unreachable\)") { throw "Self-test did not observe readiness failure evidence." }
    if (-not (Invoke-DatabaseWatchdog -ReadinessUrl $url -LogDir $testLogDir -DisableDockerRestart)) { throw "Self-test expected readiness recovery." }
    if (Test-Path $marker) { throw "Self-test marker was not cleared on recovery." }
    Wait-Job $stub | Out-Null; Remove-Job $stub
    Write-Output "SELFTEST PASS: DATABASE UNREACHABLE evidence and marker creation/clearing verified in $testLogDir"
}

if ($SelfTest) { Invoke-WatchdogSelfTest; exit 0 }

# A missing API is a process failure. A responding API with an unavailable DB
# is different: restarting API or worker cannot repair PostgreSQL.
if (-not (Test-PortOpen -Port 3000)) {
    Start-OikonomosService -Name "control-api" -WorkingDir (Join-Path $repoRoot "services\control-api") -ScriptPath "dist/index.js" `
        -OutLog (Join-Path $logDir "control-api-out.log") -ErrLog (Join-Path $logDir "control-api-err.log")
    exit 0
}
if (-not (Invoke-DatabaseWatchdog -ReadinessUrl "http://127.0.0.1:3000/health/ready" -LogDir $logDir)) { exit 0 }

if (Test-PortOpen -Port 5174) { Write-WatchdogLog "dashboard-static healthy (port 5174 listening)." | Out-Null }
else {
    Start-OikonomosService -Name "dashboard-static" -WorkingDir (Join-Path $repoRoot "infra\compose") -ScriptPath "dashboard-static.mjs" `
        -OutLog (Join-Path $logDir "dashboard-static-out.log") -ErrLog (Join-Path $logDir "dashboard-static-err.log")
}
$workerRunning = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like "*dist*main.js*" }
if ($workerRunning) { Write-WatchdogLog "worker healthy (pid $($workerRunning[0].ProcessId))." | Out-Null }
else {
    Start-OikonomosService -Name "worker" -WorkingDir (Join-Path $repoRoot "services\worker") -ScriptPath "dist/main.js" `
        -OutLog (Join-Path $logDir "worker-out.log") -ErrLog (Join-Path $logDir "worker-err.log")
}
