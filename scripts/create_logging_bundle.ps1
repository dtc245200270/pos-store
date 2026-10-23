$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path "$PSScriptRoot\..").Path
$artifactDir = "C:\Users\Dell Precision 5550\.gemini\antigravity-ide\brain\3a7246d0-4d26-4297-a017-2197f1d2ea10"
$tempStaging = Join-Path $repoRoot "temp_logging_bundle"

Write-Host "-> Dang tao thu muc staging tai: $tempStaging" -ForegroundColor Cyan
if (Test-Path $tempStaging) {
    Remove-Item $tempStaging -Recurse -Force
}
New-Item -ItemType Directory -Path $tempStaging -Force | Out-Null
New-Item -ItemType Directory -Path "$tempStaging\deploy\logging" -Force | Out-Null
New-Item -ItemType Directory -Path "$tempStaging\deploy\logging\artifacts" -Force | Out-Null
New-Item -ItemType Directory -Path "$tempStaging\scripts" -Force | Out-Null
New-Item -ItemType Directory -Path "$tempStaging\config" -Force | Out-Null
New-Item -ItemType Directory -Path "$tempStaging\middleware" -Force | Out-Null

Write-Host "-> Sao chep cac file cau hinh va scripts..." -ForegroundColor Cyan
# 1. deploy/logging
Copy-Item "$repoRoot\deploy\logging\loki.yml" "$tempStaging\deploy\logging\" -Force
Copy-Item "$repoRoot\deploy\logging\config.alloy" "$tempStaging\deploy\logging\" -Force
Copy-Item "$repoRoot\deploy\logging\start-logging.ps1" "$tempStaging\deploy\logging\" -Force
Copy-Item "$repoRoot\deploy\logging\stop-logging.ps1" "$tempStaging\deploy\logging\" -Force
Copy-Item "$repoRoot\deploy\logging\ProcessIdentity.ps1" "$tempStaging\deploy\logging\" -Force
Copy-Item "$repoRoot\deploy\logging\README.md" "$tempStaging\deploy\logging\" -Force

# 2. deploy/logging/artifacts
Copy-Item "$repoRoot\deploy\logging\artifacts\loki_query_verification.json" "$tempStaging\deploy\logging\artifacts\" -Force
Copy-Item "$repoRoot\deploy\logging\artifacts\grafana_explore_loki.png" "$tempStaging\deploy\logging\artifacts\" -Force

# 3. scripts kiem thu
Copy-Item "$repoRoot\scripts\verify_logging_pipeline.js" "$tempStaging\scripts\" -Force
Copy-Item "$repoRoot\scripts\test_verify_pipeline_isolated.js" "$tempStaging\scripts\" -Force
Copy-Item "$repoRoot\scripts\test_process_identity_isolated.ps1" "$tempStaging\scripts\" -Force
Copy-Item "$repoRoot\scripts\test_logging_restart_persistence.ps1" "$tempStaging\scripts\" -Force
Copy-Item "$repoRoot\scripts\capture_grafana_explore.js" "$tempStaging\scripts\" -Force

# 4. config va middleware lien quan logging
Copy-Item "$repoRoot\config\logger.js" "$tempStaging\config\" -Force
Copy-Item "$repoRoot\middleware\request-id.js" "$tempStaging\middleware\" -Force

# Tao file SUMMARY_REPORT.txt
$summaryText = @"
================================================================================
POS STORE - LOKI & GRAFANA ALLOY LOGGING SUBSYSTEM HANDOVER BUNDLE
================================================================================
Timestamp: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss K")
Environment: Windows (x64)

1. PHIÊN BẢN CÔNG NGHỆ CHÍNH THỨC:
 - Grafana Loki : v3.7.8 (commit: 09e6ce2f, windows/amd64)
 - Grafana Alloy: v1.20.1 (commit: 95e12cf, windows/amd64)
 - Grafana      : v11.5.2 (port 3030)
 - Prometheus   : v3.2.1 (port 9090, default datasource)
 - Node.js      : v26.8.2 (port 3000, metrics 9101)
 - Nginx Proxy  : 1.29.1 (port 8080)

2. ĐỊA CHỈ & CỔNG LẮNG NGHE:
 - Loki Ingestion/Query : 127.0.0.1:3100
 - Loki Readiness Check : http://127.0.0.1:3100/ready (HTTP 200)
 - Grafana Alloy UI     : http://127.0.0.1:12345/
 - Grafana Web UI       : http://127.0.0.1:3030/

3. NGUỒN LOG THU THẬP & ĐÍNH CHÍNH LOGGER THEO MÃ THỰC TẾ:
 - Node.js Backend JSON : logs/app.log (UTF-8, ham sanitizeData() loai bo hoan toan cac truong trong SENSITIVE_KEYS)
 - Nginx Access Log     : C:\nginx\logs\access.log (dinh dang kem req_id)
 - Nginx Error Log      : C:\nginx\logs\error.log

4. CHIẾN LƯỢC GẮN NHÃN (ANTI-HIGH-CARDINALITY):
 - Stream index labels  : app="pos_store", env="development", source="node_backend"|"nginx_access"|"nginx_error"
 - Payload attributes   : requestId, userId, url, statusCode, durationMs duoc luu tru o payload va trich xuat qua LogQL

5. TRUY VẤN LOGQL:
 - Node.js log: {app="pos_store", source="node_backend"}
 - Nginx access log: {app="pos_store", source="nginx_access"}
 - Loc theo requestId: {app="pos_store"} |= "<requestId>"
 - Loc ma loi >= 400 (Node.js): {app="pos_store", source="node_backend"} | json | statusCode >= 400
 - Loc ma loi >= 400 (Nginx): {app="pos_store", source="nginx_access"} |~ " (4[0-9]{2}|5[0-9]{2}) "

6. KẾT QUẢ KIỂM THỬ THỰC TẾ:
 - test_process_identity_isolated.ps1: PASS 17/17 tests cach ly nhan dien tien trinh
   * Dung executable nhung config khac -> Tu choi ($false).
   * Executable khac nhung cung ten file config (loki.yml, config.alloy) -> Tu choi ($false).
   * Chi trung so cong trong CommandLine (3100, 12345) -> Tu choi ($false).
   * Dung executable va duong dan config co khoang trang -> Chap nhan ($true).
   * Tien trinh imposter chiem cong du HTTP tra 200 van bi tu choi va nem loi xung dot.
   * Stop-logging bo qua tien trinh khong dung danh tinh, chi bao da dung khi PID dich ket thuc va cong giai phong.
 - test_verify_pipeline_isolated.js: PASS 8/8 tests cach ly
   * Loki tra ve result rong -> bi tu choi.
   * Loki HTTP/API loi -> bi tu choi.
   * Log hai nguon khop nhau nhung sai request da gui (sai requestId, method, status, path) -> bi tu choi.
 - verify_logging_pipeline.js: PASS 100% assertions
   * 3 requests GET /login doi chieu khop 100% voi request da gui (requestId, GET, /login, 200).
   * Polling co timeout qua Loki API.
   * Ca 404 thuc te qua /api/products/99999999 (xac nhan HTTP 404 that va doi chieu dung requestId moi sinh tren ca Node va Nginx).
   * Kiem tra persistence: request truoc restart duoc luu voi moc nano co dinh, sau restart van truy van du ca 2 nguon; request moi sau restart tiep tuc duoc thu thap; ket qua luu vao restartPersistenceTest.
 - Grafana Explore:
   * Anh chup thuc te: deploy/logging/artifacts/grafana_explore_loki.png
   * Hien thi bieu do log volume va dong log doi chieu dong thoi ca log truoc/sau restart.

7. DANH MỤC FILE TRONG BUNDLE:
 - deploy/logging/loki.yml
 - deploy/logging/config.alloy
 - deploy/logging/start-logging.ps1
 - deploy/logging/stop-logging.ps1
 - deploy/logging/ProcessIdentity.ps1
 - deploy/logging/README.md
 - deploy/logging/artifacts/loki_query_verification.json
 - deploy/logging/artifacts/grafana_explore_loki.png
 - scripts/verify_logging_pipeline.js
 - scripts/test_verify_pipeline_isolated.js
 - scripts/test_process_identity_isolated.ps1
 - scripts/test_logging_restart_persistence.ps1
 - scripts/capture_grafana_explore.js
 - config/logger.js
 - middleware/request-id.js
 - SUMMARY_REPORT.txt
================================================================================
"@
Set-Content -Path "$tempStaging\SUMMARY_REPORT.txt" -Value $summaryText -Encoding UTF8

$destZip1 = "$repoRoot\deploy\logging\pos_store_loki_alloy_bundle.zip"
$destZip2 = "$repoRoot\pos_store_loki_alloy_bundle.zip"
$destZip3 = "$artifactDir\pos_store_loki_alloy_bundle.zip"

Write-Host "-> Dang tao file ZIP tai: $destZip1..." -ForegroundColor Cyan
if (Test-Path $destZip1) { Remove-Item $destZip1 -Force }
Compress-Archive -Path "$tempStaging\*" -DestinationPath $destZip1 -Force

Copy-Item $destZip1 $destZip2 -Force
Copy-Item $destZip1 $destZip3 -Force

Remove-Item $tempStaging -Recurse -Force

Write-Host "[HOAN TAT] File ZIP ban giao da duoc tao thanh cong:" -ForegroundColor Green
Write-Host " 1. $destZip1"
Write-Host " 2. $destZip2"
Write-Host " 3. $destZip3"
