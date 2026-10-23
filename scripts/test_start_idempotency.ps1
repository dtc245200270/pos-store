$ErrorActionPreference = 'Stop'

Write-Host "=== TEST: KIEM TRA START KHI DICH VU DANG CHAY (IDEMPOTENCY & ASSERTIONS) ==="

# 1. Doc bien moi truong Grafana
$grafUser = if ($env:GRAFANA_USER) { $env:GRAFANA_USER } else { 'admin' }
$grafPass = if ($env:GRAFANA_PASSWORD) { $env:GRAFANA_PASSWORD } else { 'admin' }

# 2. Xac nhan cac dich vu ngoai monitoring ton tai truoc khi test
$mysqlConn = Get-NetTCPConnection -LocalPort 3306 -State Listen -ErrorAction SilentlyContinue
$nodeConn  = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
$nginxConn = Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue

if (-not $mysqlConn) { throw "Dich vu MySQL (3306) khong chay truoc khi test!" }
if (-not $nodeConn)  { throw "Dich vu Node.js (3000) khong chay truoc khi test!" }
if (-not $nginxConn) { throw "Dich vu Nginx (8080) khong chay truoc khi test!" }

$mysqlPidBefore = ($mysqlConn | Select-Object -ExpandProperty OwningProcess -Unique)[0]
$nodePidBefore  = ($nodeConn  | Select-Object -ExpandProperty OwningProcess -Unique)[0]
$nginxPidBefore = ($nginxConn | Select-Object -ExpandProperty OwningProcess -Unique)[0]

Write-Host "PID dich vu ngoai monitoring truoc test: MySQL=$mysqlPidBefore, Node=$nodePidBefore, Nginx=$nginxPidBefore"

# 3. Ghi nhan PID cua Prometheus va Grafana truoc khi chay
$promConnBefore = Get-NetTCPConnection -LocalPort 9090 -State Listen -ErrorAction SilentlyContinue
$grafConnBefore = Get-NetTCPConnection -LocalPort 3030 -State Listen -ErrorAction SilentlyContinue

if (-not $promConnBefore) { throw "Prometheus (9090) chua chay truoc khi test!" }
if (-not $grafConnBefore) { throw "Grafana (3030) chua chay truoc khi test!" }

$promPidBefore = ($promConnBefore | Select-Object -ExpandProperty OwningProcess -Unique)[0]
$grafPidBefore = ($grafConnBefore | Select-Object -ExpandProperty OwningProcess -Unique)[0]

Write-Host "PID monitoring truoc test: Prometheus=$promPidBefore, Grafana=$grafPidBefore"

# 4. Chay start-monitoring.ps1 va kiem tra exit code
Write-Host "`nThuc thi start-monitoring.ps1..."
$proc = Start-Process -FilePath "powershell.exe" -ArgumentList @("-ExecutionPolicy", "Bypass", "-File", "deploy\monitoring\start-monitoring.ps1") -NoNewWindow -PassThru -Wait
$exitCode = $proc.ExitCode
Write-Host "Exit code: $exitCode"

if ($exitCode -ne 0) {
    throw "start-monitoring.ps1 tra ve exit code $exitCode (khac 0)!"
}

. (Join-Path $PSScriptRoot "monitoring-test-assertions.ps1")

# 5. Assertions ve PID monitoring khong bi tao trung
$promConnAfter = Get-NetTCPConnection -LocalPort 9090 -State Listen -ErrorAction SilentlyContinue
$grafConnAfter = Get-NetTCPConnection -LocalPort 3030 -State Listen -ErrorAction SilentlyContinue

$promPidAfter = ($promConnAfter | Select-Object -ExpandProperty OwningProcess -Unique)[0]
$grafPidAfter = ($grafConnAfter | Select-Object -ExpandProperty OwningProcess -Unique)[0]

Assert-ServicePidsUnchanged -PidsBefore @{ Prometheus=$promPidBefore; Grafana=$grafPidBefore } -PidsAfter @{ Prometheus=$promPidAfter; Grafana=$grafPidAfter } -Context "Tien trinh Monitoring"

# 6. Assertions ve dich vu ngoai monitoring giu nguyen PID
$mysqlConnAfter = Get-NetTCPConnection -LocalPort 3306 -State Listen -ErrorAction SilentlyContinue
$nodeConnAfter  = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
$nginxConnAfter = Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue

$mysqlPidAfter = ($mysqlConnAfter | Select-Object -ExpandProperty OwningProcess -Unique)[0]
$nodePidAfter  = ($nodeConnAfter  | Select-Object -ExpandProperty OwningProcess -Unique)[0]
$nginxPidAfter = ($nginxConnAfter | Select-Object -ExpandProperty OwningProcess -Unique)[0]

Assert-ServicePidsUnchanged -PidsBefore @{ MySQL=$mysqlPidBefore; Node=$nodePidBefore; Nginx=$nginxPidBefore } -PidsAfter @{ MySQL=$mysqlPidAfter; Node=$nodePidAfter; Nginx=$nginxPidAfter } -Context "Dich vu ngoai monitoring"

# 7. Assertions ve HTTP 200, target UP, database ok
# Prometheus /-/ready
$promResp = Invoke-WebRequest -Uri 'http://127.0.0.1:9090/-/ready' -UseBasicParsing -TimeoutSec 5
Assert-PrometheusReady -StatusCode $promResp.StatusCode

# Target pos_store UP
$targetsResp = Invoke-WebRequest -Uri 'http://127.0.0.1:9090/api/v1/targets' -UseBasicParsing -TimeoutSec 5
$tJson = $targetsResp.Content | ConvertFrom-Json
Assert-TargetUp -ActiveTargets $tJson.data.activeTargets

# Grafana /api/health
$gResp = Invoke-WebRequest -Uri 'http://127.0.0.1:3030/api/health' -UseBasicParsing -TimeoutSec 5
$gJson = $gResp.Content | ConvertFrom-Json
Assert-GrafanaHealth -HealthJson $gJson -StatusCode $gResp.StatusCode

Write-Host "`n=> TEST START IDEMPOTENCY: PASS HOAN TOAN!" -ForegroundColor Green
exit 0
