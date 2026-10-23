param (
    [string]$BackupFile = "database/backups/pos_store_backup.sql",
    [string]$ProjectName = ""
)

$ErrorActionPreference = "Stop"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "POS STORE - PHUC HOI CO SO DU LIEU (RESTORE DATABASE)" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Kiem tra su ton tai cua file sao luu
$ResolvedPath = Resolve-Path -Path $BackupFile -ErrorAction SilentlyContinue
if (-not $ResolvedPath -or -not (Test-Path -Path $ResolvedPath -PathType Leaf)) {
    Write-Host ""
    Write-Host "[LOI]: Khong tim thay file sao luu tai duong dan: '$BackupFile'" -ForegroundColor Red
    Write-Host "Vui long kiem tra lai duong dan hoac dat file backup vao database/backups/pos_store_backup.sql" -ForegroundColor Yellow
    Write-Host "Ban sao luu du lieu that duoc giu ngoai Git vi ly do an toan." -ForegroundColor Yellow
    exit 1
}

$FileInfo = Get-Item $ResolvedPath
Write-Host "[OK] Tim thay file sao luu: $($FileInfo.FullName) ($([math]::Round($FileInfo.Length / 1KB, 2)) KB)" -ForegroundColor Green

# 2. Doc thong tin mat khau tu .env neu khong co bien moi truong
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
    Write-Host "[CANH BAO] Khong tim thay MYSQL_ROOT_PASSWORD trong moi truong hoac .env, su dung DB_PASSWORD de thu..." -ForegroundColor Yellow
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
Write-Host "[1/4] Kiem tra trang thai container MySQL..." -ForegroundColor Yellow
$RunningContainers = docker compose @ComposeArgs ps --services --filter "status=running"
if ($RunningContainers -notcontains "mysql") {
    Write-Host "[LOI] Container 'mysql' chua khoi chay trong project Compose!" -ForegroundColor Red
    Write-Host "Vui long chay: docker compose up -d mysql" -ForegroundColor Yellow
    exit 1
}

$ContainerId = (docker compose @ComposeArgs ps -q mysql).Trim()
Write-Host "[OK] Container MySQL ID: $ContainerId" -ForegroundColor Green

# 4. Sao chep file backup vao container de dam bao nguyen ven UTF-8 (tranh loi pipeline encoding tren Windows)
Write-Host "[2/4] Sao chep file backup vao container..." -ForegroundColor Yellow
docker cp $FileInfo.FullName "${ContainerId}:/tmp/restore_backup.sql"
if ($LASTEXITCODE -ne 0) {
    Write-Host "[LOI] Khong the copy file backup vao container MySQL!" -ForegroundColor Red
    exit 1
}

# 5. Thuc thi restore ben trong container
Write-Host "[3/4] Nap du lieu vao co so du lieu pos_store (UTF-8)..." -ForegroundColor Yellow
docker compose @ComposeArgs exec -T mysql mysql -u root "-p$RootPassword" --default-character-set=utf8mb4 pos_store -e "source /tmp/restore_backup.sql"
if ($LASTEXITCODE -ne 0) {
    Write-Host "[LOI] Thuc thi restore SQL that bai!" -ForegroundColor Red
    docker compose @ComposeArgs exec -T mysql rm -f /tmp/restore_backup.sql
    exit 1
}

# 6. Don dep file tam trong container va kiem tra ket qua
docker compose @ComposeArgs exec -T mysql rm -f /tmp/restore_backup.sql
Write-Host "[4/4] Kiem tra so luong bang sau restore..." -ForegroundColor Yellow
$Tables = docker compose @ComposeArgs exec -T mysql mysql -u root "-p$RootPassword" -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'pos_store';"
Write-Host "[THANH CONG] Phuc hoi co so du lieu thanh cong! Tong so bang trong pos_store: $($Tables.Trim())" -ForegroundColor Green
