$ErrorActionPreference = 'Stop'

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   KIEM TRA TINH BEN VUNG CUA LOG KHI RESTART LOKI/ALLOY  " -ForegroundColor Yellow
Write-Host "==========================================================" -ForegroundColor Cyan

$testReqIdOld = "2161bc20-fd26-442c-9a80-dd6a2c10e531"

# 1. Dung Loki va Alloy bang stop-logging.ps1
Write-Host "`n[1/4] Dung he thong logging bang stop-logging.ps1..." -ForegroundColor Cyan
& powershell -NoProfile -ExecutionPolicy Bypass -File "deploy\logging\stop-logging.ps1"
if ($LASTEXITCODE -ne 0) {
    throw "Loi khi dung he thong logging!"
}

# Xac nhan giai phong cong
$p3100 = Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue
$p12345 = Get-NetTCPConnection -LocalPort 12345 -State Listen -ErrorAction SilentlyContinue
if ($p3100 -or $p12345) {
    throw "Loi: Cac cong chua duoc giai phong hoan toan sau khi dung!"
}
Write-Host "[OK] Cac cong 3100 va 12345 da duoc giai phong hoan toan." -ForegroundColor Green

# 2. Khoi dong lai Loki va Alloy bang start-logging.ps1
Write-Host "`n[2/4] Khoi dong lai he thong logging bang start-logging.ps1..." -ForegroundColor Cyan
& powershell -NoProfile -ExecutionPolicy Bypass -File "deploy\logging\start-logging.ps1"
if ($LASTEXITCODE -ne 0) {
    throw "Loi khi khoi dong lai he thong logging!"
}
Write-Host "[OK] He thong logging da khoi dong lai thanh cong." -ForegroundColor Green

# 3. Kiem tra truy van lai du lieu log cu truoc khi restart
Write-Host "`n[3/4] Truy van lai du lieu log cu truoc khi restart ($testReqIdOld)..." -ForegroundColor Cyan
$oldQueryEscaped = [System.Uri]::EscapeDataString("{app=`"pos_store`"} |= `"$testReqIdOld`"")
$oldQueryUrl = "http://127.0.0.1:3100/loki/api/v1/query_range?query=$oldQueryEscaped"
$oldRes = Invoke-RestMethod -Uri $oldQueryUrl -Method Get -TimeoutSec 5
$oldStreams = $oldRes.data.result
Write-Host "So stream tim thay cho log cu: $($oldStreams.Count)"
if ($oldStreams.Count -lt 2) {
    throw "ASSERTION FAILED: Khong tim thay day du log cu (Node va Nginx) sau khi restart Loki! So stream: $($oldStreams.Count)"
}
Write-Host "[ASSERTION OK] Log cu van ton tai va truy van duoc 100% tren ca 2 stream Node va Nginx sau khi restart!" -ForegroundColor Green

# 4. Gui request moi qua Nginx va xac nhan log moi tiep tuc duoc thu thap
Write-Host "`n[4/4] Gui request GET /login moi qua Nginx va xac nhan thu thap..." -ForegroundColor Cyan
$newHttp = Invoke-WebRequest -Uri 'http://127.0.0.1:8080/login' -UseBasicParsing -TimeoutSec 5
$testReqIdNew = $newHttp.Headers['X-Request-ID']
Write-Host "X-Request-ID cua request moi: $testReqIdNew"

Start-Sleep -Seconds 2

$newQueryEscaped = [System.Uri]::EscapeDataString("{app=`"pos_store`"} |= `"$testReqIdNew`"")
$newQueryUrl = "http://127.0.0.1:3100/loki/api/v1/query_range?query=$newQueryEscaped"
$newRes = Invoke-RestMethod -Uri $newQueryUrl -Method Get -TimeoutSec 5
$newStreams = $newRes.data.result
Write-Host "So stream tim thay cho log moi: $($newStreams.Count)"
if ($newStreams.Count -lt 2) {
    throw "ASSERTION FAILED: Log moi sau restart chua duoc thu thap hoac thieu stream! So stream: $($newStreams.Count)"
}
Write-Host "[ASSERTION OK] Log moi sau restart duoc thu thap thanh cong tren ca 2 stream Node va Nginx!" -ForegroundColor Green

Write-Host "`n==========================================================" -ForegroundColor Cyan
Write-Host "   TEST RESTART & PERSISTENCE: PASS HOAN TOAN 100%!       " -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Cyan
exit 0
