<#
.SYNOPSIS
    Kịch bản khởi động hệ thống ghi nhận nhật ký tập trung Grafana Loki và Grafana Alloy trên Windows.
.DESCRIPTION
    Đường dẫn: deploy/logging/start-logging.ps1
    Mục đích:
    - Kiểm tra tính hợp lệ của tệp cấu hình Loki qua lệnh `loki.exe -verify-config`.
    - Kiểm tra tính hợp lệ của cú pháp pipeline Alloy qua lệnh `alloy.exe validate`.
    - Khởi chạy tiến trình Loki lắng nghe tại 127.0.0.1:3100 và Alloy tại 127.0.0.1:12345.
    - Xác nhận trạng thái sẵn sàng của dịch vụ trước khi kết thúc kịch bản.
#>

$ErrorActionPreference = 'Stop'

try {
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   KHỞI ĐỘNG HỆ THỐNG LOGGING LOKI & GRAFANA ALLOY        " -ForegroundColor Yellow
Write-Host "==========================================================" -ForegroundColor Cyan

$repoRoot = (Resolve-Path "$PSScriptRoot\..\..").Path
$deployLogging = Join-Path $repoRoot "deploy\logging"
$identityHelper = Join-Path $deployLogging "ProcessIdentity.ps1"

if (-not (Test-Path $identityHelper)) {
    throw "Loi: Khong tim thay ProcessIdentity.ps1 tai $identityHelper"
}
. $identityHelper

$lokiDir = "C:\loki"
$alloyDir = "C:\alloy"
$lokiExe = "$lokiDir\loki.exe"
$alloyExe = "$alloyDir\alloy.exe"

$lokiConfigRepo = Join-Path $deployLogging "loki.yml"
$alloyConfigRepo = Join-Path $deployLogging "config.alloy"
$lokiConfigDisk = "$lokiDir\loki.yml"
$alloyConfigDisk = "$alloyDir\config.alloy"

# 1. Kiem tra thu muc va file thuc thi
if (-not (Test-Path $lokiExe)) {
    throw "Loi: Khong tim thay Loki tai $lokiExe. Vui long chay scripts\download_loki_alloy.ps1 truoc."
}
if (-not (Test-Path $alloyExe)) {
    throw "Loi: Khong tim thay Alloy tai $alloyExe. Vui long chay scripts\download_loki_alloy.ps1 truoc."
}

if (-not (Test-Path "$lokiDir\data")) {
    New-Item -ItemType Directory -Path "$lokiDir\data" -Force | Out-Null
}
if (-not (Test-Path "$alloyDir\data")) {
    New-Item -ItemType Directory -Path "$alloyDir\data" -Force | Out-Null
}

# 2. Dong bo file cau hinh tu repo sang disk
Copy-Item $lokiConfigRepo $lokiConfigDisk -Force
Copy-Item $alloyConfigRepo $alloyConfigDisk -Force

# 3. Kiem tra tinh hop le cua cau hinh truoc khi khoi dong
Write-Host "-> Kiem tra cau hinh Loki bang -verify-config..." -ForegroundColor Cyan
$lokiCheckProc = Start-Process -FilePath $lokiExe -ArgumentList @("-config.file=$lokiConfigDisk", "-verify-config") -NoNewWindow -PassThru -Wait
if ($lokiCheckProc.ExitCode -ne 0) {
    throw "Loi: Cau hinh Loki tai $lokiConfigDisk khong hop le (ExitCode: $($lokiCheckProc.ExitCode))!"
}
Write-Host "[OK] Cau hinh Loki hop le." -ForegroundColor Green

Write-Host "-> Kiem tra cau hinh Alloy bang alloy validate..." -ForegroundColor Cyan
$alloyCheckProc = Start-Process -FilePath $alloyExe -ArgumentList @("validate", $alloyConfigDisk) -NoNewWindow -PassThru -Wait
if ($alloyCheckProc.ExitCode -ne 0) {
    throw "Loi: Cau hinh Alloy tai $alloyConfigDisk khong hop le (ExitCode: $($alloyCheckProc.ExitCode))!"
}
Write-Host "[OK] Cau hinh Alloy hop le." -ForegroundColor Green

# ------------------------------------------------------------------------------
# 4. XAC MINH DANH TINH CONG 3100 VA KHOI DONG LOKI
# ------------------------------------------------------------------------------
Write-Host "-> Kiem tra cong 3100 va xac minh danh tinh Loki..." -ForegroundColor Cyan
$lokiPortStatus = Assert-PortAvailableOrTargetIdentity -Port 3100 -ServiceName "Loki" -ExpectedExe $lokiExe -ExpectedConfig $lokiConfigDisk

if (-not $lokiPortStatus.IsListening) {
    Write-Host "-> Dang khoi dong Loki (127.0.0.1:3100)..." -ForegroundColor Cyan
    $lokiCmd = "`"$lokiExe`" -config.file=`"$lokiConfigDisk`""
    $resLoki = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = $lokiCmd
        CurrentDirectory = $lokiDir
    }
    if ($resLoki.ReturnValue -ne 0) {
        Start-Process -FilePath $lokiExe -ArgumentList @("-config.file=$lokiConfigDisk") -WorkingDirectory $lokiDir -WindowStyle Hidden
    }
    
    # Cho Loki san sang /ready
    $lokiReady = $false
    $timeoutSec = 30
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $timeoutSec) {
        try {
            $resp = Invoke-WebRequest -Uri 'http://127.0.0.1:3100/ready' -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            if ($resp.StatusCode -eq 200 -and $resp.Content.Trim() -eq 'ready') {
                $lokiReady = $true
                break
            }
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
    if (-not $lokiReady) {
        throw "Loi: Loki khoi dong nhung khong dat trang thai Ready (HTTP 200) sau $timeoutSec giay!"
    }
    $lokiConn = Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue
    Write-Host "[THANH CONG] Loki da khoi dong va san sang (HTTP 200 /ready) tai http://127.0.0.1:3100 (PID: $($lokiConn.OwningProcess))." -ForegroundColor Green
} else {
    # Nhanh Loki da chay san: DA XAC MINH DUNG DANH TINH (ExecutablePath + CommandLine config)
    $targetProc = $lokiPortStatus.Process
    Write-Host "-> Phat hien Loki POS Store DUNG DANH TINH dang chay tai cong 3100 (PID: $($targetProc.ProcessId))." -ForegroundColor Green
    Write-Host "   Exe: $($targetProc.ExecutablePath)" -ForegroundColor DarkGray
    Write-Host "   Cmd: $($targetProc.CommandLine)" -ForegroundColor DarkGray

    # BAT BUOC kiem tra health HTTP /ready
    $lokiReady = $false
    $timeoutSec = 10
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $timeoutSec) {
        try {
            $resp = Invoke-WebRequest -Uri 'http://127.0.0.1:3100/ready' -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            if ($resp.StatusCode -eq 200 -and $resp.Content.Trim() -eq 'ready') {
                $lokiReady = $true
                break
            }
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
    if (-not $lokiReady) {
        throw "Loi: Tien trinh dung danh tinh Loki POS Store dang chiem cong 3100 nhung khong dat trang thai Ready (HTTP 200) sau $timeoutSec giay!"
    }
    Write-Host "[OK] Loki POS Store dang chay san va xac nhan Health san sang tai cong 3100 (PID: $($targetProc.ProcessId), HTTP 200 /ready)." -ForegroundColor Green
}

# ------------------------------------------------------------------------------
# 5. XAC MINH DANH TINH CONG 12345 VA KHOI DONG GRAFANA ALLOY
# ------------------------------------------------------------------------------
Write-Host "`n-> Kiem tra cong 12345 va xac minh danh tinh Grafana Alloy..." -ForegroundColor Cyan
$alloyPortStatus = Assert-PortAvailableOrTargetIdentity -Port 12345 -ServiceName "Grafana Alloy" -ExpectedExe $alloyExe -ExpectedConfig $alloyConfigDisk

if (-not $alloyPortStatus.IsListening) {
    Write-Host "-> Dang khoi dong Grafana Alloy (127.0.0.1:12345)..." -ForegroundColor Cyan
    $alloyCmd = "`"$alloyExe`" run --storage.path=`"$alloyDir\data`" --server.http.listen-addr=127.0.0.1:12345 `"$alloyConfigDisk`""
    $resAlloy = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine = $alloyCmd
        CurrentDirectory = $alloyDir
    }
    if ($resAlloy.ReturnValue -ne 0) {
        Start-Process -FilePath $alloyExe -ArgumentList @("run", "--storage.path=$alloyDir\data", "--server.http.listen-addr=127.0.0.1:12345", $alloyConfigDisk) -WorkingDirectory $alloyDir -WindowStyle Hidden
    }
    
    # Cho Alloy san sang
    $alloyReady = $false
    $timeoutSec = 15
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $timeoutSec) {
        try {
            $resp = Invoke-WebRequest -Uri 'http://127.0.0.1:12345/' -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            if ($resp.StatusCode -eq 200) {
                $alloyReady = $true
                break
            }
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
    if (-not $alloyReady) {
        throw "Loi: Grafana Alloy khoi dong nhung khong dat trang thai Ready (HTTP 200) sau $timeoutSec giay!"
    }
    $alloyConn = Get-NetTCPConnection -LocalPort 12345 -State Listen -ErrorAction SilentlyContinue
    Write-Host "[THANH CONG] Grafana Alloy da khoi dong va san sang tai http://127.0.0.1:12345 (PID: $($alloyConn.OwningProcess))." -ForegroundColor Green
} else {
    # Nhanh Alloy da chay san: DA XAC MINH DUNG DANH TINH (ExecutablePath + CommandLine config)
    $targetProc = $alloyPortStatus.Process
    Write-Host "-> Phat hien Grafana Alloy POS Store DUNG DANH TINH dang chay tai cong 12345 (PID: $($targetProc.ProcessId))." -ForegroundColor Green
    Write-Host "   Exe: $($targetProc.ExecutablePath)" -ForegroundColor DarkGray
    Write-Host "   Cmd: $($targetProc.CommandLine)" -ForegroundColor DarkGray

    # BAT BUOC kiem tra health HTTP UI
    $alloyReady = $false
    $timeoutSec = 10
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $timeoutSec) {
        try {
            $resp = Invoke-WebRequest -Uri 'http://127.0.0.1:12345/' -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            if ($resp.StatusCode -eq 200) {
                $alloyReady = $true
                break
            }
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
    if (-not $alloyReady) {
        throw "Loi: Tien trinh dung danh tinh Grafana Alloy POS Store dang chiem cong 12345 nhung khong phan hoi HTTP 200 sau $timeoutSec giay!"
    }
    Write-Host "[OK] Grafana Alloy POS Store dang chay san va xac nhan Health san sang tai cong 12345 (PID: $($targetProc.ProcessId), HTTP 200)." -ForegroundColor Green
}

Write-Host "`n----------------------------------------------------------" -ForegroundColor Cyan
Write-Host "TRANG THAI HE THONG LOGGING POS STORE:" -ForegroundColor Yellow
Write-Host " - Loki Server  : http://127.0.0.1:3100 (Health: HTTP 200 /ready)" -ForegroundColor Green
Write-Host " - Alloy Agent  : http://127.0.0.1:12345 (UI / Metrics: HTTP 200)" -ForegroundColor Green
Write-Host " - Nguon thu thap:"
Write-Host "   * Node.js JSON: logs\app.log (UTF-8, sensitive data redacted)"
Write-Host "   * Nginx Access: C:\nginx\logs\access.log"
Write-Host "   * Nginx Error : C:\nginx\logs\error.log"
    Write-Host "----------------------------------------------------------" -ForegroundColor Cyan
    exit 0
} catch {
    Write-Host "`n[LOI HE THONG / XUNG DOT TIEN TRINH]" -ForegroundColor Red
    Write-Host "$($_.Exception.Message)" -ForegroundColor Red
    Write-Error $_
    exit 1
}
