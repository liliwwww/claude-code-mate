# [Requirement@2026-06-10 + 2026-06-15] Kill the process LISTENING on a given TCP port.
# Default port = 8721 (mate server).
#
# 2026-06-15: Added busy-check via /api/runtime/snapshot before killing mate.
#   - If port is mate (8721) AND alive, query busy/spawning instances.
#   - If any busy/spawning, print a summary and require confirmation (or -Force).
#   - Non-mate ports skip the check (just kill as before).
#
# Usage:
#   .\scripts\kill-port.ps1              # default 8721 (mate) with busy check
#   .\scripts\kill-port.ps1 -Port 3000   # other port (no busy check)
#   .\scripts\kill-port.ps1 -Force       # skip confirmation when busy
#   .\scripts\kill-port.ps1 -SkipCheck   # skip busy check entirely (just kill)
#
# Exit codes:
#   0 = killed (or no process to kill)
#   2 = user aborted at confirmation prompt
#
# NOTE: ASCII-only. Windows PowerShell 5.1 reads .ps1 in the system codepage
# by default; non-BOM UTF-8 with CJK text breaks string parsing.

param(
    [int]$Port = 8721,
    [switch]$Force,
    [switch]$SkipCheck
)

# ---------------- 1. Find LISTENING pid(s) ----------------

$targetPids = @()
foreach ($line in (netstat -ano -p tcp)) {
    if ($line -match ":$Port\s+\S+\s+LISTENING\s+(\d+)") {
        $foundPid = [int]$matches[1]
        if ($foundPid -gt 0 -and $targetPids -notcontains $foundPid) {
            $targetPids += $foundPid
        }
    }
}

if ($targetPids.Count -eq 0) {
    Write-Host "[kill-port] no LISTENING process on port $Port" -ForegroundColor Yellow
    exit 0
}

# ---------------- 2. Busy check (only for default mate port) ----------------

# Snapshot result, populated only if HTTP call succeeded.
$snap = $null
$snapErr = $null

if (-not $SkipCheck -and $Port -eq 8721) {
    Write-Host "[kill-port] mate port detected -- checking busy state..." -ForegroundColor DarkGray
    try {
        $snap = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/runtime/snapshot" `
                                  -TimeoutSec 3 -ErrorAction Stop
    } catch {
        $snapErr = $_.Exception.Message
    }
}

if ($snapErr) {
    # Connection refused / not mate / timeout: process listening is either mate
    # (crashed / unresponsive) or some other app. We CAN'T tell busy state, so
    # we warn and fall through to kill (matches original script behavior).
    Write-Host ("  busy check failed: {0}" -f $snapErr) -ForegroundColor DarkGray
    Write-Host "  cannot confirm mate busy state; killing without check." `
               -ForegroundColor DarkYellow
}

if ($snap) {
    $busyList = @()
    $spawningList = @()
    if ($snap.instances -and $snap.instances.busy) {
        foreach ($i in $snap.instances.busy) { $busyList += $i }
    }
    if ($snap.instances -and $snap.instances.spawning) {
        foreach ($i in $snap.instances.spawning) { $spawningList += $i }
    }
    $busyCount = $busyList.Count
    $spawningCount = $spawningList.Count
    $pending = 0
    if ($snap.pending -and $snap.pending.total) { $pending = $snap.pending.total }

    if ($busyCount -gt 0 -or $spawningCount -gt 0) {
        Write-Host ""
        Write-Host ("  !! mate has {0} busy + {1} spawning instance(s) !!" `
                    -f $busyCount, $spawningCount) -ForegroundColor Red

        foreach ($i in $busyList) {
            $name = $i.displayName
            if (-not $name) { $name = $i.id }
            $thread = $i.threadSlug
            if (-not $thread) { $thread = "(no thread)" }
            $act = $i.currentActivity
            if (-not $act) { $act = "(no activity)" }
            Write-Host ("    [busy]     {0,-16} thread={1}  act={2}" `
                        -f $name, $thread, $act) -ForegroundColor Yellow
        }
        foreach ($i in $spawningList) {
            $name = $i.displayName
            if (-not $name) { $name = $i.id }
            Write-Host ("    [spawning] {0,-16} (starting up)" -f $name) -ForegroundColor Yellow
        }
        if ($pending -gt 0) {
            Write-Host ("    [pending]  {0} message(s) queued" -f $pending) -ForegroundColor Yellow
        }

        Write-Host ""
        if ($Force) {
            Write-Host "[kill-port] -Force passed, killing anyway." -ForegroundColor DarkYellow
        } else {
            Write-Host "Killing mate now will interrupt these instances." -ForegroundColor Red

            # Reject non-interactive sessions HARD: Read-Host throws an exception
            # in NonInteractive mode -- we MUST NOT silently treat that as 'yes'.
            $isInteractive = -not ([Environment]::UserInteractive -eq $false `
                                    -or [Environment]::GetCommandLineArgs() -contains '-NonInteractive')
            if (-not $isInteractive) {
                Write-Host "  non-interactive mode detected; pass -Force to kill anyway, or run interactively." `
                           -ForegroundColor Yellow
                exit 2
            }

            $ans = $null
            try {
                $ans = Read-Host "Proceed? (y/N)"
            } catch {
                Write-Host "  cannot prompt (non-interactive); aborting. Pass -Force to override." `
                           -ForegroundColor Yellow
                exit 2
            }
            if ($ans -ne 'y' -and $ans -ne 'Y') {
                Write-Host "[kill-port] aborted by user." -ForegroundColor Cyan
                exit 2
            }
        }
    } else {
        Write-Host ("  mate idle (busy=0 spawning=0 pending={0}) -- safe to kill." `
                    -f $pending) -ForegroundColor Green
    }
}

# ---------------- 3. Kill ----------------

foreach ($targetPid in $targetPids) {
    $procName = (Get-Process -Id $targetPid -ErrorAction SilentlyContinue).ProcessName
    if (-not $procName) { $procName = '?' }
    Write-Host ("[kill-port] PID={0} ({1}) on port {2}" -f $targetPid, $procName, $Port) `
               -ForegroundColor Cyan
    taskkill /F /T /PID $targetPid | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  done" -ForegroundColor Green
    } else {
        Write-Host ("  taskkill rc={0}" -f $LASTEXITCODE) -ForegroundColor Red
    }
}
