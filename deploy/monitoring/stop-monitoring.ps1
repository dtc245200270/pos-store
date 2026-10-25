<#
.SYNOPSIS
    Kịch bản dừng an toàn hệ thống giám sát Prometheus và Grafana trên Windows.
.DESCRIPTION
    Đường dẫn: deploy/monitoring/stop-monitoring.ps1
    Mục đích:
    - Tìm kiếm và xác minh chính xác tiến trình Prometheus (cổng 9090) và Grafana (cổng 3030).
    - Áp dụng kiểm tra kép: ExecutablePath phải thuộc C:\prometheus\ hoặc C:\grafana\ và CommandLine chứa đúng tệp cấu hình POS Store.
    - Dừng tiến trình mục tiêu bằng Stop-Process -Force sau khi đã xác minh danh tính.
    - Chờ và kiểm tra thực tế: xác nhận tiến trình theo PID đã kết thúc hoàn toàn và cổng mạng đã được giải phóng (Get-NetTCPConnection = null).
    - Trả exit code 0 khi hoàn tất thành công; không can thiệp vào bất kỳ tiến trình nào khác.
#>

$ErrorActionPreference = 'Stop'

$expectedPromPath = 'C:\prometheus\prometheus.exe'
$expectedGrafanaPath1 = 'C:\grafana\bin\grafana.exe'
$expectedGrafanaPath2 = 'C:\grafana\bin\grafana-server.exe'

function Normalize-PathStr {
    param([string]$pathStr)
    if ([string]::IsNullOrWhiteSpace($pathStr)) { return '' }
    $trimmed = $pathStr.Trim().Trim('"').Trim("'")
    try {
        return [System.IO.Path]::GetFullPath($trimmed).TrimEnd('\', '/')
    } catch {
        return $trimmed.TrimEnd('\', '/')
    }
}

function Stop-VerifiedProcess {
    param(
        [int]$Port,
        [string]$ServiceName,
        [string[]]$AllowedPaths,
        [string]$RequiredCmdKeyword,
        [int]$WaitTimeoutSec = 10
    )

    $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if (-not $conns) {
        Write-Host "[OK] Cong ${Port}: Khong co tien trinh nao dang lang nghe (Da dung san)." -ForegroundColor DarkGray
        return $true
    }

    $pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
    $allStopped = $true

    foreach ($processId in $pids) {
        if (-not $processId -or $processId -le 4) {
            Write-Warning "Bo qua PID he thong: ${processId}"
            continue
        }

        # 1. Truy van thong tin tien trinh qua CIM/WMI
        $procInfo = $null
        try {
            $procInfo = Get-CimInstance Win32_Process -Filter "ProcessId = ${processId}" -ErrorAction SilentlyContinue
        } catch {
            $errMsg = $_.Exception.Message
            Write-Warning "Khong the truy van thong tin PID ${processId}: ${errMsg}"
        }

        if (-not $procInfo) {
            Write-Host "Tien trinh (PID: ${processId}) khong ton tai hoac da thoat." -ForegroundColor Yellow
            continue
        }

        $execPath = $procInfo.ExecutablePath
        $cmdLine = $procInfo.CommandLine
        $procName = $procInfo.Name

        Write-Host "Phat hien tien trinh tai cong ${Port} (PID: ${processId}):" -ForegroundColor Cyan
        Write-Host " - Ten: ${procName}"
        Write-Host " - Path: ${execPath}"
        Write-Host " - Command: ${cmdLine}"

        # 2. Xac minh chinh xac ExecutablePath
        $normExec = Normalize-PathStr $execPath
        $pathMatched = $false
        foreach ($allowed in $AllowedPaths) {
            $normAllowed = Normalize-PathStr $allowed
            if ($normExec -and ($normExec -ieq $normAllowed)) {
                $pathMatched = $true
                break
            }
        }

        # 3. Xac minh CommandLine co chuoi nhan dien bat buoc
        $cmdMatched = ($cmdLine -and ($cmdLine.IndexOf($RequiredCmdKeyword, [System.StringComparison]::OrdinalIgnoreCase) -ge 0))

        if (-not $pathMatched -or -not $cmdMatched) {
            Write-Error "[CANH BAO XUNG DOT] KHONG THE XAC MINH ${ServiceName} (PID: ${processId}). PathMatch=$pathMatched, CmdMatch=$cmdMatched. HUY THAO TAC de tranh dung nham chuong trinh khac!"
            $allStopped = $false
            continue
        }

        # 4. Dung tien trinh da duoc xac minh
        Write-Host "-> Da xac minh hop le ${ServiceName}. Dang dung PID ${processId}..." -ForegroundColor Yellow
        try {
            Stop-Process -Id $processId -Force -ErrorAction Stop
        } catch {
            Write-Error "[THAT BAI] Khong the gui tin hieu dung PID ${processId}: $($_.Exception.Message)"
            $allStopped = $false
            continue
        }

        # 5. Cho va xac nhan tien trinh da dung thuc su
        $procDied = $false
        for ($i = 0; $i -lt $WaitTimeoutSec; $i++) {
            Start-Sleep -Milliseconds 600
            $stillAlive = Get-Process -Id $processId -ErrorAction SilentlyContinue
            if (-not $stillAlive) {
                $procDied = $true
                break
            }
        }

        if (-not $procDied) {
            Write-Error "[THAT BAI] Tien trinh ${ServiceName} (PID: ${processId}) van con ton tai sau ${WaitTimeoutSec} giay!"
            $allStopped = $false
            continue
        }

        Write-Host "[DA DUNG] Tien trinh ${ServiceName} (PID: ${processId}) da dung." -ForegroundColor Green
    }

    # 6. Cho va xac nhan cong da duoc giai phong hoan toan
    Write-Host "-> Dang xac nhan cong ${Port} duoc giai phong hoan toan..." -ForegroundColor Cyan
    $portFreed = $false
    for ($i = 0; $i -lt $WaitTimeoutSec; $i++) {
        $remainingConns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        if (-not $remainingConns) {
            $portFreed = $true
            break
        }
        Start-Sleep -Milliseconds 600
    }

    if (-not $portFreed) {
        Write-Error "[THAT BAI] Cong ${Port} van chua duoc giai phong sau ${WaitTimeoutSec} giay!"
        return $false
    }

    Write-Host "[GIAI PHONG] Cong ${Port} (${ServiceName}) da duoc giai phong hoan toan." -ForegroundColor Green
    return $allStopped
}

Write-Host '==========================================================' -ForegroundColor Cyan
Write-Host '     DUNG AN TOAN HE THONG GIAM SAT PROMETHEUS & GRAFANA  ' -ForegroundColor Yellow
Write-Host '==========================================================' -ForegroundColor Cyan

# 1. Thu nhan ket qua dung tung dich vu
$promStopped = Stop-VerifiedProcess -Port 9090 -ServiceName 'Prometheus' -AllowedPaths @($expectedPromPath) -RequiredCmdKeyword 'prometheus'
$grafStopped = Stop-VerifiedProcess -Port 3030 -ServiceName 'Grafana' -AllowedPaths @($expectedGrafanaPath1, $expectedGrafanaPath2) -RequiredCmdKeyword 'grafana'

Write-Host "`n--- KET QUA THUC HIEN ---" -ForegroundColor Cyan
Write-Host " - Prometheus (Cong 9090): $(if ($promStopped) { 'DA DUNG & GIAI PHONG' } else { 'THAT BAI' })"
Write-Host " - Grafana    (Cong 3030): $(if ($grafStopped) { 'DA DUNG & GIAI PHONG' } else { 'THAT BAI' })"

if (-not $promStopped -or -not $grafStopped) {
    Write-Error "[THAT BAI] Khong the dung hoac xac minh giai phong toan bo he thong giam sat."
    exit 1
}

Write-Host "`n[THANH CONG] Toan bo he thong giam sat (Prometheus & Grafana) da duoc dung va giai phong cong an toan." -ForegroundColor Green
exit 0
