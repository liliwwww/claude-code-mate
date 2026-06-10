# [需求@2026-06-10] 杀指定端口 LISTENING 进程
# 用法:
#   .\scripts\kill-port.ps1                 # 默认杀 8721 (mate server)
#   .\scripts\kill-port.ps1 -Port 3000      # 指定端口

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
    Write-Host "端口 $Port 没有 LISTENING 的进程" -ForegroundColor Yellow
    exit 0
}

foreach ($targetPid in $targetPids) {
    $procName = (Get-Process -Id $targetPid -ErrorAction SilentlyContinue).ProcessName
    if (-not $procName) { $procName = '?' }
    Write-Host ("PID={0} ({1}) 端口 {2}" -f $targetPid, $procName, $Port) -ForegroundColor Cyan
    taskkill /F /T /PID $targetPid | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  done" -ForegroundColor Green
    } else {
        Write-Host "  taskkill rc=$LASTEXITCODE" -ForegroundColor Red
    }
}
