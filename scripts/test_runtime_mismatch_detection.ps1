$ErrorActionPreference = 'Stop'

Write-Host "=== TEST: RUNTIME KHAC CAU HINH MONG MUON - PHAI PHAT HIEN ===" -ForegroundColor Cyan

# Source ham Parse-PrometheusYaml va Compare-PrometheusDesiredVsRuntime tu start-monitoring.ps1
$startScriptContent = Get-Content -LiteralPath "deploy\monitoring\start-monitoring.ps1" -Raw

# Trich xuat 2 ham bang regex hoac execute trong scope
$funcBlockMatch = [regex]::Match($startScriptContent, '(?ms)function Parse-PrometheusYaml.*?function Compare-PrometheusDesiredVsRuntime.*?\r?\n}')
if (-not $funcBlockMatch.Success) {
    throw "Khong the trich xuat ham Parse-PrometheusYaml va Compare-PrometheusDesiredVsRuntime tu start-monitoring.ps1!"
}
Invoke-Expression $funcBlockMatch.Value

Write-Host "[OK] Da load thanh cong Parse-PrometheusYaml va Compare-PrometheusDesiredVsRuntime tu start-monitoring.ps1."

# -------------------------------------------------------------
# PHAN 1: KIEM TRA XU LY CAC GIA TRI MAC DINH PROMETHEUS THEM VAO
# -------------------------------------------------------------
Write-Host "`n--- PHAN 1: PROMETHEUS THEM CAC GIA TRI MAC DINH VAO RUNTIME ---" -ForegroundColor Cyan

$desiredBase = @"
global:
  scrape_interval: 15s
  evaluation_interval: 15s

scrape_configs:
  - job_name: 'pos_store'
    scrape_interval: 15s
    scrape_timeout: 10s
    metrics_path: '/metrics'
    static_configs:
      - targets: ['127.0.0.1:9101']
        labels:
          app: 'pos_store'
          env: 'development'
"@

# Runtime co rat nhieu field mac dinh do Prometheus inject (utf8, protocols, compression, follow_redirects, etc.)
$runtimeWithDefaults = @"
global:
  scrape_interval: 15s
  scrape_timeout: 10s
  evaluation_interval: 15s
  metric_name_validation_scheme: utf8
  scrape_native_histograms: false
  extra_scrape_metrics: false
runtime:
  gogc: 75
  log_level: info
scrape_configs:
- job_name: pos_store
  honor_timestamps: true
  track_timestamps_staleness: false
  scrape_interval: 15s
  scrape_timeout: 10s
  scrape_protocols:
  - OpenMetricsText1.0.0
  - OpenMetricsText0.0.1
  - PrometheusText1.0.0
  - PrometheusText0.0.4
  scrape_native_histograms: false
  always_scrape_classic_histograms: false
  convert_classic_histograms_to_nhcb: false
  metrics_path: /metrics
  scheme: http
  enable_compression: true
  metric_name_validation_scheme: utf8
  metric_name_escaping_scheme: allow-utf-8
  extra_scrape_metrics: false
  follow_redirects: true
  enable_http2: true
  static_configs:
  - targets:
    - 127.0.0.1:9101
    labels:
      app: pos_store
      env: development
storage:
  tsdb:
    outofordertimewindow: 0
    retention:
      time: 1w
"@

$cmpDefaults = Compare-PrometheusDesiredVsRuntime -DesiredYaml $desiredBase -RuntimeYaml $runtimeWithDefaults
Write-Host "Ket qua so sanh voi cac gia tri mac dinh: IsMatch = $($cmpDefaults.IsMatch)"
if (-not $cmpDefaults.IsMatch) {
    throw "ASSERTION FAILED: So sanh bao loi voi cac gia tri mac dinh cua Prometheus! Diffs: $($cmpDefaults.Differences -join '; ')"
}
Write-Host "[ASSERTION OK] Cac gia tri mac dinh do Prometheus inject duoc xu ly chinh xac, IsMatch = True." -ForegroundColor Green

# -------------------------------------------------------------
# PHAN 2: PHAT HIEN CAC SAI KHAC CAU TRUC (MISMATCHES)
# -------------------------------------------------------------
Write-Host "`n--- PHAN 2: BAT BUOC PHAT HIEN CAC TRUONG HOP MISMATCH ---" -ForegroundColor Cyan

# Case A: Desired co job ma Runtime khong co
$desiredExtraJob = $desiredBase + @"
`n  - job_name: 'mysql_exporter'
    static_configs:
      - targets: ['127.0.0.1:9104']
"@
$cmpA = Compare-PrometheusDesiredVsRuntime -DesiredYaml $desiredExtraJob -RuntimeYaml $runtimeWithDefaults
Write-Host "Case A (Job thieu trong runtime): IsMatch = $($cmpA.IsMatch)"
if ($cmpA.IsMatch -or ($cmpA.Differences -notmatch "Job 'mysql_exporter' thieu")) {
    throw "ASSERTION FAILED: Khong phat hien duoc job thieu trong runtime!"
}
Write-Host "[ASSERTION OK] Phat hien chinh xac: $($cmpA.Differences[0])" -ForegroundColor Green

# Case B: Runtime co job ma Desired da go bo
$runtimeExtraJob = $runtimeWithDefaults + "`n" + @"
- job_name: removed_service
  metrics_path: /metrics
  static_configs:
  - targets:
    - 127.0.0.1:9999
"@
$cmpB = Compare-PrometheusDesiredVsRuntime -DesiredYaml $desiredBase -RuntimeYaml $runtimeExtraJob
Write-Host "Case B (Job da bi loai bo khoi desired): IsMatch = $($cmpB.IsMatch), Diffs = $($cmpB.Differences -join ' | ')"
if ($cmpB.IsMatch -or ($cmpB.Differences -notmatch "Job 'removed_service' co trong runtime nhung da bi loai bo")) {
    throw "ASSERTION FAILED: Khong phat hien duoc job runtime bi loai bo!"
}
Write-Host "[ASSERTION OK] Phat hien chinh xac: $($cmpB.Differences[0])" -ForegroundColor Green

# Case C: Target bi sai lech
$desiredDiffTarget = $desiredBase.Replace("'127.0.0.1:9101'", "'127.0.0.1:9999'")
$cmpC = Compare-PrometheusDesiredVsRuntime -DesiredYaml $desiredDiffTarget -RuntimeYaml $runtimeWithDefaults
Write-Host "Case C (Target khac nhau): IsMatch = $($cmpC.IsMatch)"
if ($cmpC.IsMatch -or ($cmpC.Differences -notmatch "target")) {
    throw "ASSERTION FAILED: Khong phat hien duoc target sai lech!"
}
Write-Host "[ASSERTION OK] Phat hien chinh xac sai lech target: $($cmpC.Differences -join '; ')" -ForegroundColor Green

# Case D: Label thieu trong runtime
$desiredExtraLabel = $desiredBase.Replace("env: 'development'", "env: 'development'`n          tier: 'backend'")
$cmpD = Compare-PrometheusDesiredVsRuntime -DesiredYaml $desiredExtraLabel -RuntimeYaml $runtimeWithDefaults
Write-Host "Case D (Nhan thieu trong runtime): IsMatch = $($cmpD.IsMatch)"
if ($cmpD.IsMatch -or ($cmpD.Differences -notmatch "tier")) {
    throw "ASSERTION FAILED: Khong phat hien duoc nhan 'tier' thieu trong runtime!"
}
Write-Host "[ASSERTION OK] Phat hien chinh xac nhan thieu: $($cmpD.Differences[0])" -ForegroundColor Green

# Case E: Gia tri label khac nhau
$desiredDiffVal = $desiredBase.Replace("env: 'development'", "env: 'production'")
$cmpE = Compare-PrometheusDesiredVsRuntime -DesiredYaml $desiredDiffVal -RuntimeYaml $runtimeWithDefaults
Write-Host "Case E (Gia tri label khac nhau): IsMatch = $($cmpE.IsMatch)"
if ($cmpE.IsMatch -or ($cmpE.Differences -notmatch "khac nhau")) {
    throw "ASSERTION FAILED: Khong phat hien duoc gia tri label khac nhau!"
}
Write-Host "[ASSERTION OK] Phat hien chinh xac gia tri label khac nhau: $($cmpE.Differences[0])" -ForegroundColor Green

# Case F: MetricsPath khac nhau
$desiredDiffPath = $desiredBase.Replace("metrics_path: '/metrics'", "metrics_path: '/app_metrics'")
$cmpF = Compare-PrometheusDesiredVsRuntime -DesiredYaml $desiredDiffPath -RuntimeYaml $runtimeWithDefaults
Write-Host "Case F (metrics_path khac nhau): IsMatch = $($cmpF.IsMatch)"
if ($cmpF.IsMatch -or ($cmpF.Differences -notmatch "metrics_path khac nhau")) {
    throw "ASSERTION FAILED: Khong phat hien duoc metrics_path khac nhau!"
}
Write-Host "[ASSERTION OK] Phat hien chinh xac metrics_path khac nhau: $($cmpF.Differences[0])" -ForegroundColor Green

# Case G: scrape_interval khac nhau (ke thua hoac override)
$desiredDiffInterval = $desiredBase.Replace("scrape_interval: 15s", "scrape_interval: 30s")
$cmpG = Compare-PrometheusDesiredVsRuntime -DesiredYaml $desiredDiffInterval -RuntimeYaml $runtimeWithDefaults
Write-Host "Case G (scrape_interval khac nhau): IsMatch = $($cmpG.IsMatch)"
if ($cmpG.IsMatch -or ($cmpG.Differences -notmatch "scrape_interval khac nhau")) {
    throw "ASSERTION FAILED: Khong phat hien duoc scrape_interval khac nhau!"
}
Write-Host "[ASSERTION OK] Phat hien chinh xac scrape_interval khac nhau: $($cmpG.Differences[0])" -ForegroundColor Green

# Case H: scrape_timeout khac nhau
$desiredDiffTimeout = $desiredBase.Replace("scrape_timeout: 10s", "scrape_timeout: 5s")
$cmpH = Compare-PrometheusDesiredVsRuntime -DesiredYaml $desiredDiffTimeout -RuntimeYaml $runtimeWithDefaults
Write-Host "Case H (scrape_timeout khac nhau): IsMatch = $($cmpH.IsMatch)"
if ($cmpH.IsMatch -or ($cmpH.Differences -notmatch "scrape_timeout khac nhau")) {
    throw "ASSERTION FAILED: Khong phat hien duoc scrape_timeout khac nhau!"
}
Write-Host "[ASSERTION OK] Phat hien chinh xac scrape_timeout khac nhau: $($cmpH.Differences[0])" -ForegroundColor Green

# Case I: Runtime API loi, YAML rong hoac khong phan tich duoc
$cmpEmpty = Compare-PrometheusDesiredVsRuntime -DesiredYaml $desiredBase -RuntimeYaml ""
Write-Host "Case I1 (Runtime YAML rong): IsMatch = $($cmpEmpty.IsMatch)"
if ($cmpEmpty.IsMatch -or ($cmpEmpty.Differences -notmatch "khong hop le hoac rong")) {
    throw "ASSERTION FAILED: Runtime YAML rong nhung khong bao loi!"
}
Write-Host "[ASSERTION OK] Runtime YAML rong duoc bat chinh xac: $($cmpEmpty.Differences[0])" -ForegroundColor Green

$cmpUnparseable = Compare-PrometheusDesiredVsRuntime -DesiredYaml $desiredBase -RuntimeYaml "invalid: [unparseable"
Write-Host "Case I2 (Runtime YAML khong the phan tich): IsMatch = $($cmpUnparseable.IsMatch)"
if ($cmpUnparseable.IsMatch -or ($cmpUnparseable.Differences -notmatch "khong hop le hoac rong")) {
    throw "ASSERTION FAILED: Runtime YAML khong the phan tich nhung khong bao loi!"
}
Write-Host "[ASSERTION OK] Runtime YAML khong the phan tich duoc bat chinh xac: $($cmpUnparseable.Differences[0])" -ForegroundColor Green

# -------------------------------------------------------------
# PHAN 3: KIEM TRA LIVE TREN RUNTIME PROMETHEUS THUC TE
# -------------------------------------------------------------
Write-Host "`n--- PHAN 3: DOI CHIEU LIVE VOI RUNTIME PROMETHEUS QUA API ---" -ForegroundColor Cyan
$liveResp = Invoke-WebRequest -Uri 'http://127.0.0.1:9090/api/v1/status/config' -UseBasicParsing -TimeoutSec 5
$liveYaml = ($liveResp.Content | ConvertFrom-Json).data.yaml

$repoContent = Get-Content -LiteralPath "deploy\monitoring\prometheus.yml" -Raw
$cmpLive = Compare-PrometheusDesiredVsRuntime -DesiredYaml $repoContent -RuntimeYaml $liveYaml
Write-Host "Doi chieu Desired goc voi Live Runtime: IsMatch = $($cmpLive.IsMatch)"
if (-not $cmpLive.IsMatch) {
    throw "ASSERTION FAILED: Desired goc khong khop voi Live Runtime! Diffs: $($cmpLive.Differences -join '; ')"
}
Write-Host "[ASSERTION OK] Desired goc trong repo khop 100% voi Live Runtime Prometheus." -ForegroundColor Green

# Thu doi chieu Desired bi thay doi tren Live Runtime
$fakeDesired = $repoContent.Replace("env: 'development'", "env: 'staging'")
$cmpFakeLive = Compare-PrometheusDesiredVsRuntime -DesiredYaml $fakeDesired -RuntimeYaml $liveYaml
Write-Host "Doi chieu Fake Desired voi Live Runtime: IsMatch = $($cmpFakeLive.IsMatch)"
if ($cmpFakeLive.IsMatch) {
    throw "ASSERTION FAILED: Live runtime khong phat hien duoc mismatch voi Fake Desired!"
}
Write-Host "[ASSERTION OK] Live Runtime da phat hien mismatch ngay lap tuc: $($cmpFakeLive.Differences[0])" -ForegroundColor Green

Write-Host "`n=> TEST RUNTIME MISMATCH DETECTION: PASS HOAN TOAN!" -ForegroundColor Green
exit 0
