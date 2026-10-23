# Script khởi chạy phpMyAdmin trên PowerShell (Cổng 8081)
# Xử lý đường dẫn chứa khoảng trắng

$phpExe = "C:\xampp\php\php.exe"
$pmaDir = "C:\xampp\phpMyAdmin"
$listenHost = "127.0.0.1"
$listenPort = 8081

if (-not (Test-Path -LiteralPath $phpExe)) {
    Write-Error "[LỖI] Không tìm thấy PHP tại '$phpExe'."
    exit 1
}

if (-not (Test-Path -LiteralPath $pmaDir)) {
    Write-Error "[LỖI] Không tìm thấy phpMyAdmin tại '$pmaDir'."
    exit 1
}

# Kiểm tra cổng 8081 trước khi chạy
$existingConn = Get-NetTCPConnection -LocalPort $listenPort -State Listen -ErrorAction SilentlyContinue
if ($existingConn) {
    Write-Warning "Cổng $listenPort hiện đang được sử dụng bởi PID $($existingConn.OwningProcess)."
    Write-Host "Vui lòng dừng tiến trình cũ trước khi khởi động lại."
    exit 1
}

Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "  KHỞI CHẠY PHPMYADMIN (http://${listenHost}:${listenPort})" -ForegroundColor Green
Write-Host "===================================================" -ForegroundColor Cyan
Write-Host "Kết nối tới MySQL: 127.0.0.1:3306 (MySQL80)"
Write-Host "Đang lắng nghe tại: http://${listenHost}:${listenPort}"

# Khởi chạy PHP Built-in Server
& $phpExe -S "${listenHost}:${listenPort}" -t $pmaDir
