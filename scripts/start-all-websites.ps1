# Script khoi dong toan bo cac website va dich vu web trong he thong POS Store
$ErrorActionPreference = 'SilentlyContinue'

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "       KHOI DONG TOAN BO DICH VU WEB LOCAL POS STORE      " -ForegroundColor Yellow
Write-Host "==========================================================" -ForegroundColor Cyan

# 1. Kiem tra MySQL Service (MySQL80)
Write-Host "`n[1/5] Kiem tra dich vu MySQL80 (Cong 3306)..." -ForegroundColor Cyan
$mysqlService = Get-Service -Name MySQL80 -ErrorAction SilentlyContinue
if ($mysqlService) {
    if ($mysqlService.Status -ne 'Running') {
        Write-Host "Dang khoi dong service MySQL80..." -ForegroundColor Yellow
        Start-Service MySQL80 -ErrorAction SilentlyContinue
    }
    Write-Host "[OK] MySQL80 dang chay." -ForegroundColor Green
} else {
    Write-Warning "Khong tim thay Windows Service MySQL80. Vui long dam bao MySQL 3306 dang mo."
}

# 2. Khoi dong Node.js Core Backend (Cong 3000 & Metrics 9101)
Write-Host "`n[2/5] Khoi dong Node.js POS Store (Cong 3000 / 9101)..." -ForegroundColor Cyan
$nodeConn = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if (-not $nodeConn) {
    $repoRoot = (Resolve-Path "$PSScriptRoot\..").Path
    Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $repoRoot -WindowStyle Hidden
    Start-Sleep -Seconds 2
    $nodeConnCheck = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
    if ($nodeConnCheck) {
        Write-Host "[THANH CONG] Node.js backend dang chay tai http://127.0.0.1:3000." -ForegroundColor Green
    } else {
        Write-Warning "Node.js dang khoi dong, vui long kiem tra lai sau giay lat."
    }
} else {
    Write-Host "[OK] Node.js da dang chay tai cong 3000 (PID: $($nodeConn.OwningProcess))." -ForegroundColor Green
}

# 3. Khoi dong Nginx Reverse Proxy (Cong 8080)
Write-Host "`n[3/5] Khoi dong Nginx Reverse Proxy (Cong 8080)..." -ForegroundColor Cyan
$nginxConn = Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue
if (-not $nginxConn) {
    if (Test-Path 'C:\nginx\nginx.exe') {
        Start-Process -FilePath "C:\nginx\nginx.exe" -WorkingDirectory "C:\nginx" -WindowStyle Hidden
        Start-Sleep -Milliseconds 800
        $nginxConnCheck = Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue
        if ($nginxConnCheck) {
            Write-Host "[THANH CONG] Nginx dang chay tai http://127.0.0.1:8080." -ForegroundColor Green
        } else {
            Write-Warning "Khong the khoi dong Nginx tai cong 8080."
        }
    } else {
        Write-Warning "Khong tim thay C:\nginx\nginx.exe."
    }
} else {
    Write-Host "[OK] Nginx da dang chay tai cong 8080 (PID: $($nginxConn.OwningProcess))." -ForegroundColor Green
}

# 4. Khoi dong phpMyAdmin (Cong 8081)
Write-Host "`n[4/5] Khoi dong phpMyAdmin (Cong 8081)..." -ForegroundColor Cyan
$pmaConn = Get-NetTCPConnection -LocalPort 8081 -State Listen -ErrorAction SilentlyContinue
if (-not $pmaConn) {
    $phpExe = "C:\xampp\php\php.exe"
    $pmaDir = "C:\xampp\phpMyAdmin"
    if ((Test-Path $phpExe) -and (Test-Path $pmaDir)) {
        Start-Process -FilePath $phpExe -ArgumentList "-S 127.0.0.1:8081 -t `"$pmaDir`"" -WindowStyle Hidden
        Start-Sleep -Milliseconds 800
        $pmaConnCheck = Get-NetTCPConnection -LocalPort 8081 -State Listen -ErrorAction SilentlyContinue
        if ($pmaConnCheck) {
            Write-Host "[THANH CONG] phpMyAdmin dang chay tai http://127.0.0.1:8081." -ForegroundColor Green
        } else {
            Write-Warning "Khong the khoi dong phpMyAdmin tai cong 8081."
        }
    } else {
        Write-Warning "Khong tim thay PHP hoac phpMyAdmin tai C:\xampp."
    }
} else {
    Write-Host "[OK] phpMyAdmin da dang chay tai cong 8081 (PID: $($pmaConn.OwningProcess))." -ForegroundColor Green
}

# 5. Khoi dong Prometheus (9090) va Grafana (3030)
Write-Host "`n[5/5] Khoi dong Prometheus (9090) va Grafana (3030)..." -ForegroundColor Cyan
$repoMonitoringScript = "$PSScriptRoot\..\deploy\monitoring\start-monitoring.ps1"
if (Test-Path $repoMonitoringScript) {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $repoMonitoringScript
} else {
    Write-Warning "Khong tim thay deploy\monitoring\start-monitoring.ps1."
}

Write-Host "`n==========================================================" -ForegroundColor Cyan
Write-Host "       BANG TRANG THAI CAC DICH VU WEB LOCAL POS STORE     " -ForegroundColor Yellow
Write-Host "==========================================================" -ForegroundColor Cyan

$services = @(
    @{ Name = "MySQL 8.0 Database"; Port = 3306; Url = "tcp://127.0.0.1:3306" },
    @{ Name = "Nginx Web Gateway (Recom.)"; Port = 8080; Url = "http://127.0.0.1:8080" },
    @{ Name = "Node.js Core Backend"; Port = 3000; Url = "http://127.0.0.1:3000" },
    @{ Name = "phpMyAdmin Web GUI"; Port = 8081; Url = "http://127.0.0.1:8081" },
    @{ Name = "Node.js Prometheus Metrics"; Port = 9101; Url = "http://127.0.0.1:9101/metrics" },
    @{ Name = "Prometheus Web UI"; Port = 9090; Url = "http://127.0.0.1:9090" },
    @{ Name = "Grafana Web Dashboard"; Port = 3030; Url = "http://127.0.0.1:3030/d/pos-store-monitoring-dashboard" }
)

foreach ($s in $services) {
    $conn = Get-NetTCPConnection -LocalPort $s.Port -State Listen -ErrorAction SilentlyContinue
    if ($conn) {
        Write-Host "  [OK] $($s.Name.PadRight(30)) | Port $($s.Port.ToString().PadRight(5)) | $($s.Url)" -ForegroundColor Green
    } else {
        Write-Host "  [X]  $($s.Name.PadRight(30)) | Port $($s.Port.ToString().PadRight(5)) | KHONG HOAT DONG" -ForegroundColor Red
    }
}

Write-Host "`nHoan tat khoi dong toan bo he thong local POS Store!`n" -ForegroundColor Cyan
