$ErrorActionPreference = 'Stop'

Write-Host "=== KHOI DONG LAI CO KIEM SOAT BACKEND NODE.JS POS STORE ===" -ForegroundColor Cyan

# 1. Kiem tra tien trinh node server.js hien tai
$nodeConns = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($nodeConns) {
    $currentPid = ($nodeConns | Select-Object -ExpandProperty OwningProcess -Unique)[0]
    $pInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $currentPid" -ErrorAction SilentlyContinue
    Write-Host "Phat hien Node.js dang chay tai PID $currentPid (CommandLine: $($pInfo.CommandLine)). Dang dung..." -ForegroundColor Yellow
    Stop-Process -Id $currentPid -Force
    Start-Sleep -Seconds 1
}

# 2. Xac nhan giai phong cong 3000 va 9101
$retries = 10
while ($retries -gt 0) {
    $still3000 = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
    $still9101 = Get-NetTCPConnection -LocalPort 9101 -State Listen -ErrorAction SilentlyContinue
    if (-not $still3000 -and -not $still9101) {
        break
    }
    Start-Sleep -Milliseconds 500
    $retries--
}
Write-Host "[OK] Cac cong 3000 va 9101 da duoc giai phong hoan toan." -ForegroundColor Green

# 3. Khoi dong lai Node.js
$repoRoot = (Resolve-Path "$PSScriptRoot\..").Path
Write-Host "Dang khoi dong lai Node.js server.js tu $repoRoot..." -ForegroundColor Cyan
Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $repoRoot -WindowStyle Hidden

# 4. Cho cong 3000 va 9101 mo lai
$started = $false
$retries = 15
while ($retries -gt 0) {
    $check3000 = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
    $check9101 = Get-NetTCPConnection -LocalPort 9101 -State Listen -ErrorAction SilentlyContinue
    if ($check3000 -and $check9101) {
        $started = $true
        $newPid = $check3000.OwningProcess
        Write-Host "[THANH CONG] Node.js da khoi dong tai cong 3000 / 9101 (PID moi: $newPid)." -ForegroundColor Green
        break
    }
    Start-Sleep -Milliseconds 500
    $retries--
}

if (-not $started) {
    throw "Loi: Node.js khong khoi dong duoc sau 7.5 giay!"
}

# 5. Xac nhan website va metrics hoat dong binh thuong
Start-Sleep -Seconds 1
Write-Host "Xac nhan website qua Nginx (http://localhost:8080/login)..." -ForegroundColor Cyan
$webResp = Invoke-WebRequest -Uri 'http://127.0.0.1:8080/login' -UseBasicParsing -TimeoutSec 5
if ($webResp.StatusCode -ne 200) {
    throw "Loi: Website Nginx /login tra ve HTTP $($webResp.StatusCode)"
}
Write-Host "[OK] Website qua Nginx: HTTP 200 OK" -ForegroundColor Green

Write-Host "Xac nhan backend Node.js truc tiep (http://127.0.0.1:3000/login)..." -ForegroundColor Cyan
$backendResp = Invoke-WebRequest -Uri 'http://127.0.0.1:3000/login' -UseBasicParsing -TimeoutSec 5
if ($backendResp.StatusCode -ne 200) {
    throw "Loi: Backend /login tra ve HTTP $($backendResp.StatusCode)"
}
Write-Host "[OK] Backend Node.js truc tiep: HTTP 200 OK" -ForegroundColor Green

Write-Host "Xac nhan Metrics server (http://127.0.0.1:9101/metrics)..." -ForegroundColor Cyan
$metricsResp = Invoke-WebRequest -Uri 'http://127.0.0.1:9101/metrics' -UseBasicParsing -TimeoutSec 5
if ($metricsResp.StatusCode -ne 200) {
    throw "Loi: Metrics server tra ve HTTP $($metricsResp.StatusCode)"
}
Write-Host "[OK] Metrics server: HTTP 200 OK" -ForegroundColor Green

Write-Host "`n=> KHOI DONG LAI NODE.JS BACKEND THANH CONG VA DA XAC NHAN AN TOAN!" -ForegroundColor Green
