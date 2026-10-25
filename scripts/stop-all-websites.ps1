<#
.SYNOPSIS
    Kịch bản dừng toàn bộ các website và dịch vụ web đang chạy trong POS Store trên Windows.
.DESCRIPTION
    Đường dẫn: scripts/stop-all-websites.ps1
    Mục đích:
    - Gọi tuần tự các kịch bản dừng an toàn đã xác minh:
      1. phpMyAdmin (cổng 8081).
      2. Prometheus (cổng 9090) và Grafana (cổng 3030).
      3. Nginx Reverse Proxy (cổng 8080).
      4. Node.js Express Backend (cổng 3000 và 9101).
    - Giải phóng toàn bộ cổng mạng sạch sẽ, không ảnh hưởng tới tiến trình hệ thống khác.
#>

$ErrorActionPreference = 'SilentlyContinue'

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "         DỪNG MỌI WEBSITE VÀ DỊCH VỤ WEB POS STORE        " -ForegroundColor Yellow
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Dung phpMyAdmin (Cong 8081)
Write-Host "`n[1/4] Dung phpMyAdmin (Cong 8081)..." -ForegroundColor Cyan
if (Test-Path -LiteralPath 'deploy\phpmyadmin\stop-phpmyadmin.ps1') {
    & powershell -NoProfile -ExecutionPolicy Bypass -File 'deploy\phpmyadmin\stop-phpmyadmin.ps1'
} else {
    Write-Warning "Khong tim thay deploy\phpmyadmin\stop-phpmyadmin.ps1"
}

# 2. Dung he thong giam sat Grafana (3030) va Prometheus (9090)
Write-Host "`n[2/4] Dung Prometheus (9090) va Grafana (3030)..." -ForegroundColor Cyan
if (Test-Path -LiteralPath 'deploy\monitoring\stop-monitoring.ps1') {
    & powershell -NoProfile -ExecutionPolicy Bypass -File 'deploy\monitoring\stop-monitoring.ps1'
} else {
    Write-Warning "Khong tim thay deploy\monitoring\stop-monitoring.ps1"
}

# 3. Dung Nginx Reverse Proxy (Cong 8080)
Write-Host "`n[3/4] Dung Nginx (Cong 8080)..." -ForegroundColor Cyan
if (Test-Path -LiteralPath 'C:\nginx\nginx.exe') {
    cmd.exe /c "cd /d C:\nginx && nginx.exe -s stop" 2>$null
    Start-Sleep -Milliseconds 600
}
# Kiem tra xem con tien trinh nginx.exe nao khong
$nginxProcs = Get-CimInstance Win32_Process -Filter "Name = 'nginx.exe'" -ErrorAction SilentlyContinue
foreach ($p in $nginxProcs) {
    if ($p.ExecutablePath -and ($p.ExecutablePath -ieq 'C:\nginx\nginx.exe')) {
        Write-Host "Dung tien trinh nginx.exe con lai (PID: $($p.ProcessId))..." -ForegroundColor Yellow
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
}
$nginxConn = Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue
if (-not $nginxConn) {
    Write-Host "[DA DUNG] Nginx tai cong 8080 da dung thanh cong." -ForegroundColor Green
} else {
    Write-Warning "[CANH BAO] Cong 8080 van dang mo boi PID $($nginxConn.OwningProcess)."
}

# 4. Dung Website Node.js POS Store (Cong 3000 & Metrics 9101)
Write-Host "`n[4/4] Dung Website Node.js POS Store (Cong 3000 / 9101)..." -ForegroundColor Cyan
$nodeConns = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if ($nodeConns) {
    $nodePids = $nodeConns | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($npId in $nodePids) {
        $procInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $npId" -ErrorAction SilentlyContinue
        if ($procInfo -and $procInfo.CommandLine -and ($procInfo.CommandLine.IndexOf('server.js', [System.StringComparison]::OrdinalIgnoreCase) -ge 0)) {
            Write-Host "Da xac minh hop le Node.js server.js (PID: $npId). Dang dung..." -ForegroundColor Yellow
            Stop-Process -Id $npId -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 500
            $stillAlive = Get-Process -Id $npId -ErrorAction SilentlyContinue
            if (-not $stillAlive) {
                Write-Host "[DA DUNG] Node.js POS Store (PID: $npId) tai cong 3000 da dung thanh cong." -ForegroundColor Green
            } else {
                Write-Warning "[THAT BAI] Khong the dung PID $npId."
            }
        } else {
            Write-Warning "PID $npId tai cong 3000 khong phai server.js cua POS Store. Bo qua de dam bao an toan."
        }
    }
} else {
    Write-Host "Cong 3000 khong co tien trinh nao dang lang nghe." -ForegroundColor DarkGray
}

Write-Host "`n==========================================================" -ForegroundColor Cyan
Write-Host "          KIEM TRA TRANG THAI CAC CONG WEBSITE            " -ForegroundColor Yellow
Write-Host "==========================================================" -ForegroundColor Cyan

$checkPorts = @(
    @{ Port = 8080; Name = "Nginx / POS Store Web" },
    @{ Port = 8081; Name = "phpMyAdmin" },
    @{ Port = 3000; Name = "Node.js Core Backend" },
    @{ Port = 9101; Name = "Node.js Metrics Endpoint" },
    @{ Port = 3030; Name = "Grafana Web Dashboard" },
    @{ Port = 9090; Name = "Prometheus Web UI" }
)

foreach ($cp in $checkPorts) {
    $c = Get-NetTCPConnection -LocalPort $cp.Port -State Listen -ErrorAction SilentlyContinue
    if ($c) {
        Write-Host "[-] $($cp.Name) (Cong $($cp.Port)): DANG MO (PID $($c.OwningProcess))" -ForegroundColor Red
    } else {
        Write-Host "[x] $($cp.Name) (Cong $($cp.Port)): DA DUNG (Dong)" -ForegroundColor Green
    }
}
Write-Host "`nHoan thanh dung toan bo website." -ForegroundColor Cyan
