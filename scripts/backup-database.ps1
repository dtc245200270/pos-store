param (
    [string]$OutputFile = "database/backups/pos_store_backup.sql",
    [string]$ProjectName = ""
)

$ErrorActionPreference = "Stop"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "POS STORE - SAO LUU CO SO DU LIEU (BACKUP DATABASE)" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Kiem tra thu muc dich va tao moi neu can
$TargetDir = Split-Path -Parent $OutputFile
if ($TargetDir -and -not (Test-Path $TargetDir)) {
    New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
    Write-Host "[OK] Da tao thu muc sao luu: $TargetDir" -ForegroundColor Green
}

# 2. Doc mat khau tu .env neu chua co trong bien moi truong
$ComposeArgs = @()
if ($ProjectName -ne "") {
    $ComposeArgs += @("-p", $ProjectName)
}

$EnvFile = ".env"
$RootPassword = $env:MYSQL_ROOT_PASSWORD
if (-not $RootPassword -and (Test-Path $EnvFile)) {
    Get-Content $EnvFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -match '^MYSQL_ROOT_PASSWORD=(.*)$') {
            $RootPassword = $matches[1].Trim().Trim('"').Trim("'")
        }
    }
}

if (-not $RootPassword) {
    Write-Host "[CANH BAO] Khong tim thay MYSQL_ROOT_PASSWORD, su dung DB_PASSWORD de thu..." -ForegroundColor Yellow
    if (Test-Path $EnvFile) {
        Get-Content $EnvFile | ForEach-Object {
            $line = $_.Trim()
            if ($line -match '^DB_PASSWORD=(.*)$') {
                $RootPassword = $matches[1].Trim().Trim('"').Trim("'")
            }
        }
    }
}

if (-not $RootPassword) {
    Write-Host "[LOI] Khong tim thay mat khau ket noi MySQL. Vui long kiem tra file .env" -ForegroundColor Red
    exit 1
}

# 3. Kiem tra container MySQL dang chay
Write-Host "[1/4] Kiem tra container MySQL..." -ForegroundColor Yellow
$RunningContainers = docker compose @ComposeArgs ps --services --filter "status=running"
if ($RunningContainers -notcontains "mysql") {
    Write-Host "[LOI] Container 'mysql' chua khoi chay trong project Compose!" -ForegroundColor Red
    Write-Host "Vui long chay: docker compose up -d mysql" -ForegroundColor Yellow
    exit 1
}

$ContainerId = (docker compose @ComposeArgs ps -q mysql).Trim()
Write-Host "[OK] Container MySQL ID: $ContainerId" -ForegroundColor Green

# 4. Xuat dump ben trong container truc tiep bang --result-file de giu dung UTF-8
Write-Host "[2/4] Xuat dump co so du lieu pos_store (UTF-8)..." -ForegroundColor Yellow
docker compose @ComposeArgs exec -T mysql mysqldump -u root "-p$RootPassword" `
    --default-character-set=utf8mb4 `
    --single-transaction `
    --quick `
    --result-file=/tmp/pos_store_dump.sql `
    pos_store

if ($LASTEXITCODE -ne 0) {
    Write-Host "[LOI] mysqldump that bai!" -ForegroundColor Red
    docker compose @ComposeArgs exec -T mysql rm -f /tmp/pos_store_dump.sql
    exit 1
}

# 5. Sao chep file dump tu container ra file dich tren Windows
Write-Host "[3/4] Sao chep ban dump ra he thong tep Windows..." -ForegroundColor Yellow
docker cp "${ContainerId}:/tmp/pos_store_dump.sql" $OutputFile
if ($LASTEXITCODE -ne 0) {
    Write-Host "[LOI] Khong the copy file dump tu container!" -ForegroundColor Red
    docker compose @ComposeArgs exec -T mysql rm -f /tmp/pos_store_dump.sql
    exit 1
}

# 6. Don dep va kiem tra ket qua
docker compose @ComposeArgs exec -T mysql rm -f /tmp/pos_store_dump.sql
$DumpItem = Get-Item $OutputFile
Write-Host "[4/4] Kiem tra ket qua..." -ForegroundColor Yellow
Write-Host "[THANH CONG] Da sao luu co so du lieu vao: $($DumpItem.FullName) ($([math]::Round($DumpItem.Length / 1KB, 2)) KB)" -ForegroundColor Green
