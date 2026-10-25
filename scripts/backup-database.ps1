<#
.SYNOPSIS
    Kịch bản tự động sao lưu cơ sở dữ liệu POS Store từ MySQL Docker container.
.DESCRIPTION
    Đường dẫn: scripts/backup-database.ps1
    Mục đích:
    - Xuất bản sao lưu dữ liệu toàn vẹn (bảng, dữ liệu, khóa ngoại) của cơ sở dữ liệu pos_store.
    - Đọc mật khẩu quản trị từ file .env hoặc biến môi trường một cách an toàn.
    - Kiểm tra container MySQL đang chạy trong dự án Docker Compose trước khi thao tác.
    - Sử dụng mysqldump với tùy chọn --single-transaction và --quick để đảm bảo tính nhất quán
      dữ liệu mà không làm khóa các bảng đang phục vụ bán hàng trực tiếp.
    - Xuất file dump trực tiếp bên trong container với --result-file để bảo toàn mã hóa UTF-8 tiếng Việt,
      sau đó sao chép tệp ra máy trạm Windows qua lệnh `docker cp` và dọn dẹp file tạm.
.PARAMETER OutputFile
    Đường dẫn tệp SQL sao lưu trên máy trạm Windows (mặc định: database/backups/pos_store_backup.sql).
.PARAMETER ProjectName
    Tên dự án Docker Compose (nếu sử dụng cờ -p, mặc định rỗng).
#>

param (
    [string]$OutputFile = "database/backups/pos_store_backup.sql",
    [string]$ProjectName = ""
)

$ErrorActionPreference = "Stop"

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "POS STORE - SAO LƯU CƠ SỞ DỮ LIỆU (BACKUP DATABASE)" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Kiểm tra thư mục lưu bản sao lưu và tạo mới nếu chưa tồn tại
$TargetDir = Split-Path -Parent $OutputFile
if ($TargetDir -and -not (Test-Path $TargetDir)) {
    New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
    Write-Host "[OK] Đã tạo thư mục sao lưu: $TargetDir" -ForegroundColor Green
}

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
    Write-Host "[CẢNH BÁO] Không tìm thấy MYSQL_ROOT_PASSWORD, thử tìm DB_PASSWORD..." -ForegroundColor Yellow
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
Write-Host "[1/4] Kiểm tra container MySQL..." -ForegroundColor Yellow
$RunningContainers = docker compose @ComposeArgs ps --services --filter "status=running"
if ($RunningContainers -notcontains "mysql") {
    Write-Host "[LỖI] Container 'mysql' chưa khởi chạy trong project Compose!" -ForegroundColor Red
    Write-Host "Vui lòng chạy: docker compose up -d mysql" -ForegroundColor Yellow
    exit 1
}

$ContainerId = (docker compose @ComposeArgs ps -q mysql).Trim()
Write-Host "[OK] Container MySQL ID: $ContainerId" -ForegroundColor Green

# 4. Xuất dump bên trong container bằng --result-file để bảo đảm mã hóa UTF-8 tiếng Việt nguyên vẹn
#    - --single-transaction: Đảm bảo tính toàn vẹn dữ liệu nhất quán tại một thời điểm (InnoDB).
#    - --quick: Đọc từng dòng dữ liệu từ máy chủ thay vì đệm toàn bộ vào bộ nhớ RAM.
Write-Host "[2/4] Xuất dump cơ sở dữ liệu pos_store (bảng mã utf8mb4)..." -ForegroundColor Yellow
docker compose @ComposeArgs exec -T mysql mysqldump -u root "-p$RootPassword" `
    --default-character-set=utf8mb4 `
    --single-transaction `
    --quick `
    --result-file=/tmp/pos_store_dump.sql `
    pos_store

if ($LASTEXITCODE -ne 0) {
    Write-Host "[LỖI] Lệnh mysqldump thất bại!" -ForegroundColor Red
    docker compose @ComposeArgs exec -T mysql rm -f /tmp/pos_store_dump.sql
    exit 1
}

# 5. Sao chép tệp bản sao lưu từ container ra thư mục đích trên hệ điều hành Windows
Write-Host "[3/4] Sao chép bản dump ra hệ thống tệp Windows..." -ForegroundColor Yellow
docker cp "${ContainerId}:/tmp/pos_store_dump.sql" $OutputFile
if ($LASTEXITCODE -ne 0) {
    Write-Host "[LỖI] Không thể sao chép file dump từ container ra Windows!" -ForegroundColor Red
    docker compose @ComposeArgs exec -T mysql rm -f /tmp/pos_store_dump.sql
    exit 1
}

# 6. Dọn dẹp tệp tạm trong container và xác minh kích thước bản sao lưu đầu ra
docker compose @ComposeArgs exec -T mysql rm -f /tmp/pos_store_dump.sql
$DumpItem = Get-Item $OutputFile
Write-Host "[4/4] Kiểm tra kết quả sao lưu..." -ForegroundColor Yellow
Write-Host "[THÀNH CÔNG] Đã sao lưu cơ sở dữ liệu vào: $($DumpItem.FullName) ($([math]::Round($DumpItem.Length / 1KB, 2)) KB)" -ForegroundColor Green

