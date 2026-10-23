$ErrorActionPreference = 'Stop'

Write-Host "=== TEST: DUNG VA KHOI DONG LAI RIENG MONITORING (WITH STRICT ASSERTIONS) ==="

# 1. Doc bien moi truong Grafana
$grafUser = if ($env:GRAFANA_USER) { $env:GRAFANA_USER } else { 'admin' }
$grafPass = if ($env:GRAFANA_PASSWORD) { $env:GRAFANA_PASSWORD } else { 'admin' }

$authHeader = 'Basic ' + [System.Convert]::ToBase64String([System.Text.Encoding]::ASCII.GetBytes("${grafUser}:${grafPass}"))
$headers = @{ Authorization = $authHeader }

# 2. Xac nhan cac dich vu ngoai monitoring ton tai va ghi nhan PID
$mysqlConn = Get-NetTCPConnection -LocalPort 3306 -State Listen -ErrorAction SilentlyContinue
$nodeConn  = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
$nginxConn = Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue

if (-not $mysqlConn) { throw "Dich vu MySQL (3306) khong chay truoc khi test!" }
if (-not $nodeConn)  { throw "Dich vu Node.js (3000) khong chay truoc khi test!" }
if (-not $nginxConn) { throw "Dich vu Nginx (8080) khong chay truoc khi test!" }

$mysqlPidBefore = ($mysqlConn | Select-Object -ExpandProperty OwningProcess -Unique)[0]
$nodePidBefore  = ($nodeConn  | Select-Object -ExpandProperty OwningProcess -Unique)[0]
$nginxPidBefore = ($nginxConn | Select-Object -ExpandProperty OwningProcess -Unique)[0]

Write-Host "PID ngoai monitoring: MySQL=$mysqlPidBefore, Node=$nodePidBefore, Nginx=$nginxPidBefore"

# 3. Ghi nhan du lieu lich su Prometheus trong khoang thoi gian tuyet doi da ket thuc truoc restart
$nowSec = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$tEnd = $nowSec - 60   # Thoi diem ket thuc tuyet doi la 60 giay truoc
$windowSec = 600       # Khoang thoi gian khep kin 10 phut truoc do: [tEnd - 600, tEnd]

$historyQueryUrl = "http://127.0.0.1:9090/api/v1/query?time=${tEnd}&query=" + [System.Uri]::EscapeDataString("sum(count_over_time(up{job='pos_store'}[${windowSec}s]))")
$histRespBefore = Invoke-WebRequest -Uri $historyQueryUrl -UseBasicParsing -TimeoutSec 5
if ($histRespBefore.StatusCode -ne 200) { throw "Truy van lich su Prometheus tra ve HTTP $($histRespBefore.StatusCode)!" }

$histJsonBefore = $histRespBefore.Content | ConvertFrom-Json
$samplesBefore = [int]($histJsonBefore.data.result[0].value[1])
Write-Host "So mau up{job='pos_store'} trong cua so tuyet doi [tEnd-600, tEnd=$tEnd]: $samplesBefore mau"
if ($samplesBefore -le 0) {
    throw "Khong co mau lich su nao truoc restart de kiem tra tinh bao toan!"
}

# 4. Doc toan bo noi dung cac panel Dashboard Grafana truoc khi dung
$dRespBefore = Invoke-WebRequest -Uri 'http://127.0.0.1:3030/api/dashboards/uid/pos-store-monitoring-dashboard' -Headers $headers -UseBasicParsing -TimeoutSec 5
if ($dRespBefore.StatusCode -ne 200) { throw "Khong the lay Dashboard Grafana qua API truoc khi restart!" }
$dJsonBefore = $dRespBefore.Content | ConvertFrom-Json
$panelsBefore = $dJsonBefore.dashboard.panels
Write-Host "Da luu cau hinh $($panelsBefore.Count) panels truoc khi dung de doi chieu sau restart."

# 5. Thuc thi stop-monitoring.ps1 va assertion
Write-Host "`nDang dung he thong giam sat bang stop-monitoring.ps1..."
$stopProc = Start-Process -FilePath "powershell.exe" -ArgumentList @("-ExecutionPolicy", "Bypass", "-File", "deploy\monitoring\stop-monitoring.ps1") -NoNewWindow -PassThru -Wait
$stopExitCode = $stopProc.ExitCode
Write-Host "Exit code stop-monitoring: $stopExitCode"
if ($stopExitCode -ne 0) { throw "stop-monitoring.ps1 that bai voi exit code $stopExitCode!" }

. (Join-Path $PSScriptRoot "monitoring-test-assertions.ps1")

# 6. Assertions cong 9090 va 3030 da dong
Assert-PortsReleased -Ports @(9090, 3030)

# 7. Assertions cac dich vu ngoai monitoring ton tai va giu nguyen PID
$mysqlConnAfterStop = Get-NetTCPConnection -LocalPort 3306 -State Listen -ErrorAction SilentlyContinue
$nodeConnAfterStop  = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
$nginxConnAfterStop = Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue

$mysqlPidAfterStop = ($mysqlConnAfterStop | Select-Object -ExpandProperty OwningProcess -Unique)[0]
$nodePidAfterStop  = ($nodeConnAfterStop  | Select-Object -ExpandProperty OwningProcess -Unique)[0]
$nginxPidAfterStop = ($nginxConnAfterStop | Select-Object -ExpandProperty OwningProcess -Unique)[0]

Assert-ServicePidsUnchanged -PidsBefore @{ MySQL=$mysqlPidBefore; Node=$nodePidBefore; Nginx=$nginxPidBefore } -PidsAfter @{ MySQL=$mysqlPidAfterStop; Node=$nodePidAfterStop; Nginx=$nginxPidAfterStop } -Context "Dich vu ngoai monitoring"

# 8. Khoi dong lai he thong giam sat
Write-Host "`nKhoi dong lai he thong giam sat bang start-monitoring.ps1..."
$startProc = Start-Process -FilePath "powershell.exe" -ArgumentList @("-ExecutionPolicy", "Bypass", "-File", "deploy\monitoring\start-monitoring.ps1") -NoNewWindow -PassThru -Wait
$startExitCode = $startProc.ExitCode
Write-Host "Exit code start-monitoring: $startExitCode"
if ($startExitCode -ne 0) { throw "start-monitoring.ps1 that bai voi exit code $startExitCode!" }

# 9. Assertions Prometheus Ready va Target UP
$promReadyResp = Invoke-WebRequest -Uri 'http://127.0.0.1:9090/-/ready' -UseBasicParsing -TimeoutSec 5
Assert-PrometheusReady -StatusCode $promReadyResp.StatusCode

$tJson = $null
for ($i = 0; $i -lt 15; $i++) {
    try {
        $tResp = Invoke-WebRequest -Uri 'http://127.0.0.1:9090/api/v1/targets' -UseBasicParsing -TimeoutSec 5
        $tJson = $tResp.Content | ConvertFrom-Json
        $posT = $tJson.data.activeTargets | Where-Object { $_.labels.job -eq 'pos_store' -or $_.scrapePool -eq 'pos_store' }
        if ($posT -and $posT.health -ieq 'up') { break }
    } catch {}
    Start-Sleep -Seconds 1
}

Assert-TargetUp -ActiveTargets $tJson.data.activeTargets

# 10. Assertions Grafana Health (HTTP 200, database ok)
$gHealthResp = Invoke-WebRequest -Uri 'http://127.0.0.1:3030/api/health' -UseBasicParsing -TimeoutSec 5
$gJson = $gHealthResp.Content | ConvertFrom-Json
Assert-GrafanaHealth -HealthJson $gJson -StatusCode $gHealthResp.StatusCode

# 11. Assertions du lieu lich su Prometheus tai cung thoi gian tuyet doi tEnd
Write-Host "`nDoi chieu so mau lich su Prometheus tai cung moc thoi gian tuyet doi tEnd=$tEnd..."
$histRespAfter = Invoke-WebRequest -Uri $historyQueryUrl -UseBasicParsing -TimeoutSec 5
if ($histRespAfter.StatusCode -ne 200) { throw "Truy van lich su Prometheus sau restart tra ve HTTP $($histRespAfter.StatusCode)!" }
$histJsonAfter = $histRespAfter.Content | ConvertFrom-Json
$samplesAfter = [int]($histJsonAfter.data.result[0].value[1])

Write-Host " - So mau truoc restart: $samplesBefore"
Write-Host " - So mau sau restart  : $samplesAfter"

Assert-HistoricalSamples -SamplesBefore $samplesBefore -SamplesAfter $samplesAfter -TimeWindowDesc "[tEnd-600, tEnd=$tEnd]"

# 12. Assertions noi dung tung Panel tren Dashboard Grafana sau restart
Write-Host "`nDoi chieu chi tiet noi dung tung panel Dashboard sau restart..."
$dRespAfter = Invoke-WebRequest -Uri 'http://127.0.0.1:3030/api/dashboards/uid/pos-store-monitoring-dashboard' -Headers $headers -UseBasicParsing -TimeoutSec 5
if ($dRespAfter.StatusCode -ne 200) { throw "Khong the lay Dashboard Grafana sau restart!" }
$dJsonAfter = $dRespAfter.Content | ConvertFrom-Json
$panelsAfter = $dJsonAfter.dashboard.panels

Assert-DashboardPanelsMatch -PanelsBefore $panelsBefore -PanelsAfter $panelsAfter

Write-Host "`n=> TOAN BO TEST STOP & RESTART MONITORING: PASS HOAN TOAN!" -ForegroundColor Green
exit 0
