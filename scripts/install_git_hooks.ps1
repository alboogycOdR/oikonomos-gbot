<#
.SYNOPSIS
    Install the composed git pre-commit hook (territory enforcement + secret scan).
.DESCRIPTION
    ADR-002 §5 (decision 2026-08-15): hooks/territory-precommit.js is the CLI-agnostic
    mechanical territory control for builder units whose CLIs do not read
    .claude/settings.json (grok, codex) and therefore never triggered
    hooks/territory-firewall.js.

    Git resolves hooks from the COMMON git dir — `git rev-parse --git-path hooks` inside
    a worktree returns the MAIN checkout's .git/hooks — so a single installed file covers
    the main checkout and every present and future worktree. There is nothing to install
    per-worktree, and re-running after `git worktree add` is unnecessary.

    The installed hook composes two controls in order:
      1. hooks/territory-precommit.js  (territory; fails closed)
      2. infra/ci/hooks/pre-commit     (OIK-007 secret scan, if present)

    Existing hook handling: if a pre-commit exists and is not one of ours, it is backed up
    to pre-commit.pre-devteam.<timestamp> rather than overwritten, and the path is reported.
.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\install_git_hooks.ps1
    powershell -ExecutionPolicy Bypass -File scripts\install_git_hooks.ps1 -Verify
#>
param(
    [switch]$Verify,          # report installed state and exit; change nothing
    [string]$Stamp = ""       # deterministic backup suffix for tests; default = UTC now
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot

$HooksDir = (& git -C $RepoRoot rev-parse --git-path hooks).Trim()
if (-not [System.IO.Path]::IsPathRooted($HooksDir)) {
    $HooksDir = Join-Path $RepoRoot $HooksDir
}
$Target = Join-Path $HooksDir "pre-commit"

$MARKER = "devteam-composed-pre-commit"

$Body = @'
#!/bin/sh
# devteam-composed-pre-commit — DO NOT EDIT BY HAND.
# Regenerate with: powershell -File scripts/install_git_hooks.ps1
#
# Composes the repo's two staged-index controls, most fundamental first:
#   1. territory  — hooks/territory-precommit.js  (ADR-002 §5; fails closed)
#   2. secrets    — infra/ci/hooks/pre-commit     (OIK-007; if present)
#
# Hooks are shared across worktrees, so this one file serves the main checkout and
# every builder worktree. Territory is resolved from the worktree the commit is
# happening in, not from the environment.
set -eu

common=$(git rev-parse --git-common-dir)
case "$common" in
  /*) main=$(dirname "$common") ;;
   *) main=$(cd "$(git rev-parse --show-toplevel)" && cd "$(dirname "$common")" && pwd) ;;
esac

if [ ! -f "$main/hooks/territory-precommit.js" ]; then
  printf '%s\n' "[pre-commit] REJECTED: $main/hooks/territory-precommit.js is missing." >&2
  printf '%s\n' "[pre-commit] The territory control cannot run, so the commit is refused (fail closed)." >&2
  exit 1
fi

node "$main/hooks/territory-precommit.js" || exit 1

if [ -f "$main/infra/ci/hooks/pre-commit" ]; then
  sh "$main/infra/ci/hooks/pre-commit" || exit 1
fi

exit 0
'@ -replace "`r`n", "`n"

function Get-State {
    if (-not (Test-Path $Target)) { return "absent" }
    $c = Get-Content $Target -Raw
    if ($c -match [regex]::Escape($MARKER)) { return "ours" }
    return "foreign"
}

$state = Get-State

if ($Verify) {
    switch ($state) {
        "absent"  { Write-Host "[install-hooks] NOT INSTALLED - $Target does not exist." -ForegroundColor Yellow; exit 1 }
        "foreign" { Write-Host "[install-hooks] FOREIGN hook present at $Target (not ours)." -ForegroundColor Yellow; exit 1 }
        "ours"    { Write-Host "[install-hooks] installed: $Target" -ForegroundColor Green; exit 0 }
    }
}

if (-not (Test-Path $HooksDir)) { New-Item -ItemType Directory -Path $HooksDir -Force | Out-Null }

if ($state -eq "foreign") {
    if (-not $Stamp) { $Stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ") }
    $backup = "$Target.pre-devteam.$Stamp"
    Copy-Item $Target $backup -Force
    Write-Host "[install-hooks] existing non-devteam hook backed up to: $backup" -ForegroundColor Yellow
    Write-Host "[install-hooks] its checks are NOT chained automatically - fold them in by hand if still needed." -ForegroundColor Yellow
}

[System.IO.File]::WriteAllText($Target, $Body, (New-Object System.Text.UTF8Encoding($false)))

# chmod +x matters on any filesystem git treats as POSIX; harmless on NTFS.
if (Get-Command git -ErrorAction SilentlyContinue) {
    try { & git -C $RepoRoot update-index --chmod=+x 2>$null | Out-Null } catch { }
}
try { & icacls $Target /grant "*S-1-1-0:(RX)" 2>&1 | Out-Null } catch { }

Write-Host "[install-hooks] installed composed pre-commit: $Target" -ForegroundColor Green
Write-Host "[install-hooks]   1. hooks/territory-precommit.js (territory, fails closed)"
if (Test-Path (Join-Path $RepoRoot "infra\ci\hooks\pre-commit")) {
    Write-Host "[install-hooks]   2. infra/ci/hooks/pre-commit (OIK-007 secret scan)"
} else {
    Write-Host "[install-hooks]   2. infra/ci/hooks/pre-commit ABSENT - secret scan not chained" -ForegroundColor Yellow
}
Write-Host "[install-hooks] covers the main checkout and ALL worktrees (git shares the hooks dir)."
