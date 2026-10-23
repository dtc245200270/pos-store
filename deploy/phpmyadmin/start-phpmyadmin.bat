@echo off
chcp 65001 >nul
echo ===================================================
echo   KHỞI CHẠY PHPMYADMIN CHO POS STORE (CỔNG 8081)
echo ===================================================

set "PHP_EXE=C:\xampp\php\php.exe"
set "PMA_DIR=C:\xampp\phpMyAdmin"

if not exist "%PHP_EXE%" (
    echo [LỖI] Không tìm thấy PHP tại "%PHP_EXE%".
    pause
    exit /b 1
)

if not exist "%PMA_DIR%" (
    echo [LỖI] Không tìm thấy thư mục phpMyAdmin tại "%PMA_DIR%".
    pause
    exit /b 1
)

echo Đang khởi chạy phpMyAdmin tại http://127.0.0.1:8081 ...
echo Nhấn Ctrl+C để dừng tiến trình khi không sử dụng.
echo.

"%PHP_EXE%" -S 127.0.0.1:8081 -t "%PMA_DIR%"
