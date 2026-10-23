$ErrorActionPreference = 'Stop'

Write-Host "=== DONG GOI TEP DA SUA VA BANG CHUNG THANH FILE ZIP ===" -ForegroundColor Cyan

$bundleDir = "deploy\monitoring\monitoring_bundle_staging"
$zipOut = "deploy\monitoring\monitoring_operational_bundle.zip"

if (Test-Path -LiteralPath $bundleDir) {
    Remove-Item -LiteralPath $bundleDir -Recurse -Force
}
if (Test-Path -LiteralPath $zipOut) {
    Remove-Item -LiteralPath $zipOut -Force
}

New-Item -ItemType Directory -Path "$bundleDir\deploy\monitoring" -Force | Out-Null
New-Item -ItemType Directory -Path "$bundleDir\evidence" -Force | Out-Null
New-Item -ItemType Directory -Path "$bundleDir\test_scripts" -Force | Out-Null

# 1. Sao chep cac tep da sua
Copy-Item "deploy\monitoring\start-monitoring.ps1" "$bundleDir\deploy\monitoring\" -Force
Copy-Item "deploy\monitoring\stop-monitoring.ps1" "$bundleDir\deploy\monitoring\" -Force
Copy-Item "deploy\monitoring\prometheus.yml" "$bundleDir\deploy\monitoring\" -Force
Copy-Item "deploy\monitoring\README.md" "$bundleDir\deploy\monitoring\" -Force

# 2. Sao chep cac bang chung JSON va log kiem tra moi nhat
Copy-Item "deploy\monitoring\artifacts\test_execution_report.json" "$bundleDir\evidence\" -Force
Copy-Item "deploy\monitoring\artifacts\test_reload_retry_not_skipped.log" "$bundleDir\evidence\" -Force
Copy-Item "scripts\evidence_step1_prometheus_T.json" "$bundleDir\evidence\" -Force
Copy-Item "scripts\evidence_step2_comparison.json" "$bundleDir\evidence\" -Force
Copy-Item "scripts\evidence_step3_after_restart.json" "$bundleDir\evidence\" -Force

# 3. Sao chep anh chup dashboard
$dashImg = "C:\Users\Dell Precision 5550\.gemini\antigravity-ide\brain\3a7246d0-4d26-4297-a017-2197f1d2ea10\grafana_dashboard_top_panels.png"
if (Test-Path -LiteralPath $dashImg) {
    Copy-Item $dashImg "$bundleDir\evidence\" -Force
}

# 4. Sao chep toan bo cac script kiem tra
Copy-Item "scripts\monitoring-test-assertions.ps1" "$bundleDir\test_scripts\" -Force
Copy-Item "scripts\test_ast_syntax.ps1" "$bundleDir\test_scripts\" -Force
Copy-Item "scripts\test_invalid_config_does_not_replace.ps1" "$bundleDir\test_scripts\" -Force
Copy-Item "scripts\test_reload_retry_not_skipped.ps1" "$bundleDir\test_scripts\" -Force
Copy-Item "scripts\test_runtime_mismatch_detection.ps1" "$bundleDir\test_scripts\" -Force
Copy-Item "scripts\test_negative_assertions.ps1" "$bundleDir\test_scripts\" -Force
Copy-Item "scripts\test_start_idempotency.ps1" "$bundleDir\test_scripts\" -Force
Copy-Item "scripts\test_stop_and_restart_monitoring.ps1" "$bundleDir\test_scripts\" -Force
Copy-Item "scripts\test_config_reload.ps1" "$bundleDir\test_scripts\" -Force
Copy-Item "scripts\run_all_operational_tests.ps1" "$bundleDir\test_scripts\" -Force

# 5. Tao file SUMMARY.txt mo ta day du noi dung goi
$summaryContent = @"
================================================================================
GOI HOAN THIEN VAN HANH HE THONG GIAM SAT PROMETHEUS & GRAFANA (POS STORE)
Ngay dong goi: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")
================================================================================

1. CAC TEP NGUON DA SUA DOI VA HOAN THIEN (deploy/monitoring/):
   - start-monitoring.ps1:
     + Xu ly Rollback hoan chinh duoi ErrorActionPreference='Stop':
       * Khong bao gio goi Write-Error truoc khi thuc hien cleanup va rollback file disk.
       * Bao toan bo thao tac thay disk, POST reload va xac nhan runtime trong try/catch/finally phu hop.
       * POST reload loi hoac truy van xac nhan runtime loi deu phai chay rollback truoc khi thoat khac 0.
       * Neu rollback cung loi, bao ca loi ban dau va loi rollback; khong bao da khoi phuc khi chua xac nhan SHA256 disk.
     + So sanh runtime Prometheus thuc te:
       * Bo sung so sanh scrape_interval va scrape_timeout hieu luc cua job pos_store, co xet ke thua tu global/default (1m / 10s).
       * Runtime API loi, YAML rong hoac khong phan tich duoc phai bao loi; khong bao gio coi la cau hinh khop.
       * Kiem tra ung vien bang promtool truoc khi thay file disk.
       * Xac nhan readiness /-/ready co timeout o ca hai nhanh chay san va khoi dong moi.
       * Phan biet ro ha tang giam sat san sang va giam sat POS Store san sang (target UP).
   - stop-monitoring.ps1:
     + Thu nhan ket qua dung tung dich vu rieng biet.
     + Xac minh chinh xac ExecutablePath va CommandLine tranh dung nham tien trinh khac.
     + Polling timeout xac nhan giai phong cong mang 9090 va 3030.
     + Exit code 0 khi thanh cong hoan toan; exit code 1 khi co bat ky loi nao.
   - README.md:
     + Thay the hoan toan curl.exe -I bang yeu cau GET /metrics (curl.exe http://127.0.0.1:9101/metrics).
     + Huong dan chi tiet cac lenh van hanh, troubleshooting su co thuong gap.

2. BO SCRIPT KIEM TRA TU DONG VA ASSERTIONS CHAT CHE (test_scripts/):
   - monitoring-test-assertions.ps1:
     + Thu vien assertion dung chung: Assert-TargetUp, Assert-GrafanaHealth, Assert-PrometheusReady, Assert-HistoricalSamples, Assert-PortsReleased, Assert-ServicePidsUnchanged, Assert-DashboardPanelsMatch.
   - test_ast_syntax.ps1:
     + Kiem tra 0 loi cu phap AST PowerShell cho ca 2 script start va stop.
   - test_invalid_config_does_not_replace.ps1:
     + Dua cau hinh candidate loi cu phap vao, start-monitoring exit 1.
     + File hop le C:\prometheus\prometheus.yml tren disk giu nguyen 100% hash, khong bi ghi de.
   - test_reload_retry_not_skipped.ps1:
     + Kich ban 1: Thuc su mo phong loi ket noi POST reload (Connection Refused tai port 9999, khong phai HTTP 500) tren luong san xuat -> assert exit 1, disk hash khoi phuc 100%, lan chay tiep theo ap dung thanh cong canary_retry='post_fail'.
     + Kich ban 2: Thuc su mo phong loi ket noi GET status/config (Connection Refused tai port 9999) sau reload -> assert exit 1, disk hash khoi phuc 100%, lan chay tiep theo ap dung thanh cong canary_retry='status_fail'.
     + Kich ban 3: Hash disk == repo nhung runtime bi lech -> phat hien va reload lai thanh cong canary_retry='v3'.
   - test_runtime_mismatch_detection.ps1:
     + Kiem tra day du cac truong hop lech runtime: them job moi, doi target, doi metric path, doi label, doi scrape_interval, doi scrape_timeout, YAML rong, YAML khong hop le.
   - test_negative_assertions.ps1:
     + Dung ham assertion chung duoc bai test van hanh that goi (monitoring-test-assertions.ps1).
     + Khong viet lai if/throw rieng cho mock test.
     + Kiem tra dung mau loi mong doi bang regex (khong coi moi exit khac 0 la bat dung loi).
   - test_start_idempotency.ps1:
     + Chay start khi dang chay giu nguyen PID Prometheus va Grafana.
     + Goi thu vien assertion dung chung de kiem tra HTTP 200, target UP, DB ok, PID khong doi.
   - test_stop_and_restart_monitoring.ps1:
     + Goi thu vien assertion dung chung.
     + Doi chieu so mau lich su Prometheus trong khoang thoi gian tuyet doi khep kin da ket thuc truoc restart: so mau truoc == so mau sau.
     + Doi chieu chi tiet tat ca 9 panel tren Dashboard (title, type, expr, noValue, mappings, thresholds, text content).
   - test_config_reload.ps1:
     + Kiem tra exit code moi lan chay va gia tri label reload_test='verified_active'.
     + Luon luon phuc hoi ca file va runtime trong block finally.
   - run_all_operational_tests.ps1:
     + Chay toan bo 7 test va xuat bao cao JSON day du (100% PASS).

3. KET QUA THUC THI KIEM TRA MOI NHAT (evidence/):
   - test_execution_report.json:
     + Tong so test: 7
     + So test dat: 7 (100% PASS)
     + So test loi: 0
     + AllPassed: true
   - test_reload_retry_not_skipped.log:
     + Log chi tiet toan bo stdout/stderr, ma loi ket noi (Connection Refused tai port 9999), exit code, SHA256 disk truoc va sau rollback, ket qua runtime o cac lan chay lai.
   - evidence_step1_prometheus_T.json, evidence_step2_comparison.json, evidence_step3_after_restart.json.
   - grafana_dashboard_top_panels.png: Anh chup dashboard nghiem thu 2 panel.
"@

Set-Content -LiteralPath "$bundleDir\SUMMARY.txt" -Value $summaryContent -Encoding UTF8

# 6. Dong goi file ZIP
Write-Host "Dang nen file ZIP..." -ForegroundColor Cyan
Compress-Archive -Path "$bundleDir\*" -DestinationPath $zipOut -Force

# Copy ban luu sang thu muc goc va brain artifacts
Copy-Item $zipOut "monitoring_operational_bundle.zip" -Force
$artDir = "C:\Users\Dell Precision 5550\.gemini\antigravity-ide\brain\3a7246d0-4d26-4297-a017-2197f1d2ea10"
if (Test-Path -LiteralPath $artDir) {
    Copy-Item $zipOut "$artDir\monitoring_operational_bundle.zip" -Force
}

# Don dep thu muc staging
Remove-Item -LiteralPath $bundleDir -Recurse -Force

$zipItem = Get-Item $zipOut
Write-Host "`n[THANH CONG] Da tao file ZIP: $($zipItem.FullName)" -ForegroundColor Green
Write-Host "Kich thuoc: $($zipItem.Length) bytes ($([Math]::Round($zipItem.Length / 1KB, 2)) KB)" -ForegroundColor Green
