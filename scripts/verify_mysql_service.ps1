$ErrorActionPreference = 'SilentlyContinue'

Write-Host "=== 1. KIEM TRA DICH VU MYSQL TRAN WINDOWS ==="

$serviceName = 'MySQL80'
$svc = Get-Service -Name $serviceName -ErrorAction SilentlyContinue

if (-not $svc) {
    Write-Host "Khong tim thay dich vu '$serviceName', dang tim cac dich vu MySQL khac..."
    $allMySql = Get-Service | Where-Object { $_.Name -like '*mysql*' -or $_.DisplayName -like '*mysql*' }
    if ($allMySql) {
        $svc = $allMySql[0]
        $serviceName = $svc.Name
        Write-Host "Tim thay dich vu MySQL thay the: $($svc.Name) ($($svc.DisplayName))"
    } else {
        Write-Host "LOI: Khong tim thay bat ky dich vu MySQL nao tren he thong!"
    }
}

if ($svc) {
    Write-Host "Ten dich vu: $($svc.Name)"
    Write-Host "Display Name: $($svc.DisplayName)"
    Write-Host "Trang thai hien tai: $($svc.Status)"
    
    if ($svc.Status -ne 'Running') {
        Write-Host "Dich vu dang dung, dang khoi dong..."
        try {
            Start-Service -Name $svc.Name -ErrorAction Stop
            Start-Sleep -Seconds 2
            $svc.Refresh()
            Write-Host "Trang thai sau khi bat: $($svc.Status)"
        } catch {
            Write-Host "LOI KHOI DONG DICH VU: $($_.Exception.Message)"
            Write-Host "Co the can quyen Administrator de bat Service."
        }
    } else {
        Write-Host "Dich vu da o trang thai Running, giu nguyen khong can khoi dong lai."
    }
}

Write-Host "`n=== 2. KIEM TRA CONG 3306 ==="
$conn = Get-NetTCPConnection -LocalPort 3306 -State Listen -ErrorAction SilentlyContinue
if ($conn) {
    $pids = $conn | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($p in $pids) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $p" -ErrorAction SilentlyContinue
        Write-Host "Cong 3306: DANG LANG NGHE (PID: $p, Process: $($proc.Name))"
    }
} else {
    Write-Host "Cong 3306: CHUA LANG NGHE"
}
