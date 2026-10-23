$ErrorActionPreference = 'Stop'

Write-Host "=== DONG GOI MA CAU HINH DOCKER COMPOSE ===" -ForegroundColor Cyan

$stagingDir = "docker_bundle_staging"
$zipOut = "pos_store_docker_compose_bundle.zip"
$artifactDir = "C:\Users\Dell Precision 5550\.gemini\antigravity-ide\brain\697f8daf-03c0-4e4d-b364-c3b599c89596"

if (Test-Path -LiteralPath $stagingDir) {
    Remove-Item -LiteralPath $stagingDir -Recurse -Force
}
if (Test-Path -LiteralPath $zipOut) {
    Remove-Item -LiteralPath $zipOut -Force
}

New-Item -ItemType Directory -Path "$stagingDir\deploy\docker" -Force | Out-Null
New-Item -ItemType Directory -Path "$stagingDir\database\backups" -Force | Out-Null

# 1. Sao chep cac tep cau hinh Docker goc
Copy-Item "compose.yaml" "$stagingDir\" -Force
Copy-Item "Dockerfile" "$stagingDir\" -Force
Copy-Item ".dockerignore" "$stagingDir\" -Force
Copy-Item ".env.example" "$stagingDir\" -Force
Copy-Item "README.md" "$stagingDir\" -Force

# 2. Sao chep toan bo thu muc deploy/docker
Copy-Item "deploy\docker\*" "$stagingDir\deploy\docker\" -Recurse -Force

# 3. Sao chep ban backup database CSDL
Copy-Item "database\backups\pos_store_backup.sql" "$stagingDir\database\backups\" -Force

# 4. Tao SUMMARY.txt
$summaryContent = @"
================================================================================
GOI DONG GOI MA CAU HINH DOCKER COMPOSE POS STORE
Ngay dong goi: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")
Nhanh Git: feat/docker-compose
================================================================================

1. CAC TEP CAU HINH CHINH:
   - compose.yaml: Cau hinh 8 container dich vu, healthchecks, persistent volumes, pos_store_network.
   - Dockerfile: Image runner production da giai doan cho ung dung Node.js (node:20.18.0-alpine).
   - .dockerignore: Loai bo node_modules, .git, .env, logs, secrets khoi Docker context.
   - .env.example: Mau bien moi truong Docker va anh xa cong host 127.0.0.1 an toan.
   - README.md: Huong dan van hanh, start/stop, xem log, restore backup va rollback Windows.

2. HE THONG DICH VU & PHIEN BAN IMAGE DA GHIM:
   - Node.js/Express: pos-store-app:1.0.0 (Base node:20.18.0-alpine)
   - MySQL: mysql:8.0.40
   - phpMyAdmin: phpmyadmin:5.2.1
   - Nginx: nginx:1.27.2-alpine
   - Prometheus: prom/prometheus:v2.54.1
   - Grafana: grafana/grafana:11.3.0
   - Loki: grafana/loki:3.2.1
   - Grafana Alloy: grafana/alloy:v1.4.3

3. BAN SAO LUU CSDL:
   - database/backups/pos_store_backup.sql: Ban sao luu nguyen ven toan bo 8 bang du lieu.
"@

Set-Content -LiteralPath "$stagingDir\SUMMARY.txt" -Value $summaryContent -Encoding UTF8

# 5. Nen file ZIP
Write-Host "Dang tao file ZIP..." -ForegroundColor Cyan
Compress-Archive -Path "$stagingDir\*" -DestinationPath $zipOut -Force

if (Test-Path -LiteralPath $artifactDir) {
    Copy-Item $zipOut "$artifactDir\$zipOut" -Force
}

# Don dep thu muc staging
Remove-Item -LiteralPath $stagingDir -Recurse -Force

$zipItem = Get-Item $zipOut
Write-Host "`n[THANH CONG] Da dong goi file ZIP: $($zipItem.FullName)" -ForegroundColor Green
Write-Host "Kich thuoc: $($zipItem.Length) bytes ($([Math]::Round($zipItem.Length / 1KB, 2)) KB)" -ForegroundColor Green
