<#
.SYNOPSIS
    Kịch bản tự động khôi phục cơ sở dữ liệu POS Store vào MySQL Docker container.
.DESCRIPTION
    Đường dẫn: scripts/restore-database.ps1
    Mục đích:
    - Nạp lại toàn bộ cấu trúc và dữ liệu từ tệp sao lưu SQL vào cơ sở dữ liệu pos_store.
    - Kiểm tra sự tồn tại và tính hợp lệ của tệp SQL sao lưu trước khi thực hiện.
    - Đọc mật khẩu quản trị từ file .env hoặc biến môi trường một cách an toàn.
    - Kiểm tra container MySQL đang chạy trong dự án Docker Compose.
    - Sao chép tệp sao lưu trực tiếp vào trong container rồi thực thi qua lệnh `source /tmp/restore_backup.sql`
      với bảng mã utf8mb4 nhằm bảo toàn toàn vẹn tiếng Việt, tránh lỗi chuyển đổi mã hóa pipeline của PowerShell trên Windows.
    - Đếm lại tổng số bảng trong cơ sở dữ liệu pos_store sau khi khôi phục để xác minh kết quả.
.PARAMETER BackupFile
    Đường dẫn tệp SQL sao lưu cần nạp (mặc định: database/backups/pos_store_backup.sql).
.PARAMETER ProjectName
    Tên dự án Docker Compose (nếu sử dụng cờ -p, mặc định rỗng).
#>

param (
    [string]$BackupFile = "database/backups/pos_store_backup.sql",
    [string]$ProjectName = ""
)

$ErrorActionPreference = "Stop"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "POS STORE - PHỤC HỒI CƠ SỞ DỮ LIỆU (RESTORE DATABASE)" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Kiểm tra sự tồn tại và kích thước của tệp sao lưu nguồn
$ResolvedPath = Resolve-Path -Path $BackupFile -ErrorAction SilentlyContinue
if (-not $ResolvedPath -or -not (Test-Path -Path $ResolvedPath -PathType Leaf)) {
    Write-Host ""
    Write-Host "[LỖI]: Không tìm thấy file sao lưu tại đường dẫn: '$BackupFile'" -ForegroundColor Red
    Write-Host "Vui lòng kiểm tra lại đường dẫn hoặc đặt file backup vào database/backups/pos_store_backup.sql" -ForegroundColor Yellow
    Write-Host "Bản sao lưu dữ liệu thật được giữ ngoài Git vì lý do an toàn." -ForegroundColor Yellow
    exit 1
}

$FileInfo = Get-Item $ResolvedPath
Write-Host "[OK] Tìm thấy file sao lưu: $($FileInfo.FullName) ($([math]::Round($FileInfo.Length / 1KB, 2)) KB)" -ForegroundColor Green

# 2. Đọc cấu hình mật khẩu quản trị từ tệp .env (ưu tiên MYSQL_ROOT_PASSWORD, dự phòng DB_PASSWORD)
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
    Write-Host "[CẢNH BÁO] Không tìm thấy MYSQL_ROOT_PASSWORD trong môi trường hoặc .env, thử tìm DB_PASSWORD..." -ForegroundColor Yellow
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
    Write-Host "[LỖI] Không tìm thấy mật khẩu kết nối MySQL. Vui lòng kiểm tra file .env" -ForegroundColor Red
    exit 1
}

# 3. Kiểm tra trạng thái tiến trình sống của container MySQL trong Docker Compose
Write-Host "[1/4] Kiểm tra trạng thái container MySQL..." -ForegroundColor Yellow
$RunningContainers = docker compose @ComposeArgs ps --services --filter "status=running"
if ($RunningContainers -notcontains "mysql") {
    Write-Host "[LỖI] Container 'mysql' chưa khởi chạy trong project Compose!" -ForegroundColor Red
    Write-Host "Vui lòng chạy: docker compose up -d mysql" -ForegroundColor Yellow
    exit 1
}

$ContainerId = (docker compose @ComposeArgs ps -q mysql).Trim()
Write-Host "[OK] Container MySQL ID: $ContainerId" -ForegroundColor Green

# 4. Sao chép tệp backup vào container để bảo đảm tính toàn vẹn mã hóa UTF-8 (tránh lỗi chuyển đổi của PowerShell Windows)
Write-Host "[2/4] Sao chép file backup vào container..." -ForegroundColor Yellow
docker cp $FileInfo.FullName "${ContainerId}:/tmp/restore_backup.sql"
if ($LASTEXITCODE -ne 0) {
    Write-Host "[LỖI] Không thể sao chép file backup vào container MySQL!" -ForegroundColor Red
    exit 1
}

# 5. Thực thi lệnh nạp dữ liệu (source SQL) bên trong container với bảng mã utf8mb4
Write-Host "[3/4] Nạp dữ liệu vào cơ sở dữ liệu pos_store (bảng mã utf8mb4)..." -ForegroundColor Yellow
docker compose @ComposeArgs exec -T mysql mysql -u root "-p$RootPassword" --default-character-set=utf8mb4 pos_store -e "source /tmp/restore_backup.sql"
if ($LASTEXITCODE -ne 0) {
    Write-Host "[LỖI] Thực thi restore SQL thất bại!" -ForegroundColor Red
    docker compose @ComposeArgs exec -T mysql rm -f /tmp/restore_backup.sql
    exit 1
}

# 6. Dọn dẹp tệp tạm trong container và đếm số lượng bảng sau khi phục hồi để xác minh
docker compose @ComposeArgs exec -T mysql rm -f /tmp/restore_backup.sql
Write-Host "[4/4] Kiểm tra số lượng bảng sau restore..." -ForegroundColor Yellow
$Tables = docker compose @ComposeArgs exec -T mysql mysql -u root "-p$RootPassword" -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'pos_store';"
Write-Host "[THÀNH CÔNG] Phục hồi cơ sở dữ liệu thành công! Tổng số bảng trong pos_store: $($Tables.Trim())" -ForegroundColor Green
