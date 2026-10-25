<#
.SYNOPSIS
    Kịch bản dừng an toàn hệ thống logging Loki và Grafana Alloy trên Windows.
.DESCRIPTION
    Đường dẫn: deploy/logging/stop-logging.ps1
    Mục đích:
    - Tìm kiếm và xác minh tiến trình Grafana Alloy (cổng 12345) và Loki (cổng 3100).
    - Sử dụng hàm Test-IsTargetLoggingProcess trong ProcessIdentity.ps1 để kiểm tra kép đường dẫn tệp thực thi và tham số cấu hình.
    - Dừng tiến trình mục tiêu bằng Stop-Process -Force sau khi đã xác minh đúng danh tính POS Store.
    - Chờ và kiểm tra thực tế: xác nhận tiến trình theo PID đã kết thúc hoàn toàn và cổng mạng đã được giải phóng (Listen connection = null).
#>

$ErrorActionPreference = 'Stop'

try {
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "     DỪNG AN TOÀN HỆ THỐNG LOGGING LOKI & GRAFANA ALLOY   " -ForegroundColor Yellow
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
$lokiConfigDisk = "$lokiDir\loki.yml"
$alloyConfigDisk = "$alloyDir\config.alloy"

$hasError = $false

# ------------------------------------------------------------------------------
# 1. DUNG GRAFANA ALLOY DUNG DANH TINH (CONG 12345)
# ------------------------------------------------------------------------------
Write-Host "-> Tim kiem tien trinh Grafana Alloy theo danh tinh POS Store..." -ForegroundColor Cyan

$conn12345 = Get-NetTCPConnection -LocalPort 12345 -State Listen -ErrorAction SilentlyContinue
$targetAlloyProcs = @()
$foreignAlloyPortPid = $null

if ($conn12345) {
    $portPid = ($conn12345 | Select-Object -ExpandProperty OwningProcess -Unique)[0]
    $portProc = Get-CimInstance Win32_Process -Filter "ProcessId = $portPid" -ErrorAction SilentlyContinue
    if ($portProc) {
        if (Test-IsTargetLoggingProcess -Process $portProc -ExpectedExe $alloyExe -ExpectedConfig $alloyConfigDisk) {
            $targetAlloyProcs += $portProc
        } else {
            $foreignAlloyPortPid = $portPid
            Write-Host "[BO QUA] Cong 12345 dang bi chiem boi PID $portPid khong dung danh tinh POS Store (Name: $($portProc.Name)). Bo qua khong can thiep." -ForegroundColor Yellow
        }
    }
}

$allAlloyProcs = Get-CimInstance Win32_Process -Filter "Name = 'alloy.exe'" -ErrorAction SilentlyContinue
if ($allAlloyProcs) {
    foreach ($p in $allAlloyProcs) {
        if (Test-IsTargetLoggingProcess -Process $p -ExpectedExe $alloyExe -ExpectedConfig $alloyConfigDisk) {
            if (-not ($targetAlloyProcs | Where-Object { $_.ProcessId -eq $p.ProcessId })) {
                $targetAlloyProcs += $p
            }
        } else {
            Write-Host "[BO QUA] Tien trinh alloy.exe khong dung danh tinh (PID: $($p.ProcessId), Exe: $($p.ExecutablePath)) vi khong khop POS Store." -ForegroundColor DarkGray
        }
    }
}

$stoppedAlloyPids = @()
if ($targetAlloyProcs.Count -gt 0) {
    foreach ($p in $targetAlloyProcs) {
        $procId = $p.ProcessId
        Write-Host "Phat hien tien trinh Alloy POS Store dung danh tinh (PID: $procId, Cmd: $($p.CommandLine)). Dang dung..." -ForegroundColor Yellow
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        $stoppedAlloyPids += $procId
    }

    # Chi bao da dung khi PID dich ket thuc va cong duoc giai phong
    $alloyFreed = $false
    $retries = 25
    while ($retries -gt 0) {
        $anyPidAlive = $false
        foreach ($pidToCheck in $stoppedAlloyPids) {
            if (Get-Process -Id $pidToCheck -ErrorAction SilentlyContinue) {
                $anyPidAlive = $true
                break
            }
        }

        $connCheck = Get-NetTCPConnection -LocalPort 12345 -State Listen -ErrorAction SilentlyContinue
        if (-not $anyPidAlive -and -not $connCheck) {
            $alloyFreed = $true
            break
        }
        Start-Sleep -Milliseconds 300
        $retries--
    }

    if ($alloyFreed) {
        Write-Host "[DA DUNG & GIAI PHONG] Grafana Alloy (PID: $($stoppedAlloyPids -join ', ')) da ket thuc va cong 12345 da duoc giai phong." -ForegroundColor Green
    } else {
        $connCheck = Get-NetTCPConnection -LocalPort 12345 -State Listen -ErrorAction SilentlyContinue
        $holdingPid = if ($connCheck) { $connCheck.OwningProcess } else { "None" }
        Write-Host "[THAT BAI] Khong the giai phong cong 12345 hoac PID dich chua ket thuc (PID chiem cong: $holdingPid)." -ForegroundColor Red
        $hasError = $true
    }
} else {
    if ($foreignAlloyPortPid) {
        Write-Host "[BO QUA] Khong co tien trinh Grafana Alloy POS Store can dung. Tien trinh khong dung danh tinh tai cong 12345 duoc bo qua." -ForegroundColor Yellow
    } else {
        Write-Host "[OK] Khong co tien trinh Alloy POS Store nao dang chay va cong 12345 da giai phong san." -ForegroundColor Green
    }
}

# ------------------------------------------------------------------------------
# 2. DUNG LOKI DUNG DANH TINH (CONG 3100)
# ------------------------------------------------------------------------------
Write-Host "`n-> Tim kiem tien trinh Loki theo danh tinh POS Store..." -ForegroundColor Cyan

$conn3100 = Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue
$targetLokiProcs = @()
$foreignLokiPortPid = $null

if ($conn3100) {
    $portPid = ($conn3100 | Select-Object -ExpandProperty OwningProcess -Unique)[0]
    $portProc = Get-CimInstance Win32_Process -Filter "ProcessId = $portPid" -ErrorAction SilentlyContinue
    if ($portProc) {
        if (Test-IsTargetLoggingProcess -Process $portProc -ExpectedExe $lokiExe -ExpectedConfig $lokiConfigDisk) {
            $targetLokiProcs += $portProc
        } else {
            $foreignLokiPortPid = $portPid
            Write-Host "[BO QUA] Cong 3100 dang bi chiem boi PID $portPid khong dung danh tinh POS Store (Name: $($portProc.Name)). Bo qua khong can thiep." -ForegroundColor Yellow
        }
    }
}

$allLokiProcs = Get-CimInstance Win32_Process -Filter "Name = 'loki.exe'" -ErrorAction SilentlyContinue
if ($allLokiProcs) {
    foreach ($p in $allLokiProcs) {
        if (Test-IsTargetLoggingProcess -Process $p -ExpectedExe $lokiExe -ExpectedConfig $lokiConfigDisk) {
            if (-not ($targetLokiProcs | Where-Object { $_.ProcessId -eq $p.ProcessId })) {
                $targetLokiProcs += $p
            }
        } else {
            Write-Host "[BO QUA] Tien trinh loki.exe khong dung danh tinh (PID: $($p.ProcessId), Exe: $($p.ExecutablePath)) vi khong khop POS Store." -ForegroundColor DarkGray
        }
    }
}

$stoppedLokiPids = @()
if ($targetLokiProcs.Count -gt 0) {
    foreach ($p in $targetLokiProcs) {
        $procId = $p.ProcessId
        Write-Host "Phat hien tien trinh Loki POS Store dung danh tinh (PID: $procId, Cmd: $($p.CommandLine)). Dang dung..." -ForegroundColor Yellow
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
        $stoppedLokiPids += $procId
    }

    # Chi bao da dung khi PID dich ket thuc va cong duoc giai phong
    $lokiFreed = $false
    $retries = 25
    while ($retries -gt 0) {
        $anyPidAlive = $false
        foreach ($pidToCheck in $stoppedLokiPids) {
            if (Get-Process -Id $pidToCheck -ErrorAction SilentlyContinue) {
                $anyPidAlive = $true
                break
            }
        }

        $connCheck = Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue
        if (-not $anyPidAlive -and -not $connCheck) {
            $lokiFreed = $true
            break
        }
        Start-Sleep -Milliseconds 300
        $retries--
    }

    if ($lokiFreed) {
        Write-Host "[DA DUNG & GIAI PHONG] Loki (PID: $($stoppedLokiPids -join ', ')) da ket thuc va cong 3100 da duoc giai phong." -ForegroundColor Green
    } else {
        $connCheck = Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue
        $holdingPid = if ($connCheck) { $connCheck.OwningProcess } else { "None" }
        Write-Host "[THAT BAI] Khong the giai phong cong 3100 hoac PID dich chua ket thuc (PID chiem cong: $holdingPid)." -ForegroundColor Red
        $hasError = $true
    }
} else {
    if ($foreignLokiPortPid) {
        Write-Host "[BO QUA] Khong co tien trinh Loki POS Store can dung. Tien trinh khong dung danh tinh tai cong 3100 duoc bo qua." -ForegroundColor Yellow
    } else {
        Write-Host "[OK] Khong co tien trinh Loki POS Store nao dang chay va cong 3100 da giai phong san." -ForegroundColor Green
    }
}

if ($hasError) {
    Write-Error "Co loi xay ra khi dung he thong logging Loki & Alloy POS Store."
    exit 1
}

Write-Host "`n[THANH CONG] Toan bo he thong logging POS Store da duoc xac minh danh tinh va dung an toan!" -ForegroundColor Green
exit 0
} catch {
    Write-Host "`n[LOI HE THONG KHI DUNG]" -ForegroundColor Red
    Write-Host "$($_.Exception.Message)" -ForegroundColor Red
    Write-Error $_
    exit 1
}
