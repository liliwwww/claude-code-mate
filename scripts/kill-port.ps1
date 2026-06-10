# [Requirement@2026-06-10] Kill the process LISTENING on a given TCP port.
# Default port = 8721 (mate server).
#
# Usage:
#   .\scripts\kill-port.ps1              # default 8721
#   .\scripts\kill-port.ps1 -Port 3000   # other port
#
# NOTE: kept ASCII-only. Windows PowerShell 5.1 reads .ps1 in the system
# codepage by default; non-BOM UTF-8 with CJK text breaks string parsing.

param([int]$Port = 8721)

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

foreach ($targetPid in $targetPids) {
    $procName = (Get-Process -Id $targetPid -ErrorAction SilentlyContinue).ProcessName
    if (-not $procName) { $procName = '?' }
    Write-Host ("[kill-port] PID={0} ({1}) on port {2}" -f $targetPid, $procName, $Port) -ForegroundColor Cyan
    taskkill /F /T /PID $targetPid | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  done" -ForegroundColor Green
    } else {
        Write-Host ("  taskkill rc={0}" -f $LASTEXITCODE) -ForegroundColor Red
    }
}
