$ErrorActionPreference = 'Stop'

Write-Host "=== RESTART GRAFANA STANDALONE ==="

$grafanaDir = 'C:\grafana'
$grafanaExe = 'C:\grafana\bin\grafana.exe'
$grafanaConfig = 'C:\grafana\conf\custom.ini'

# 1. Tim va dung tien trinh dang chiem cong 3030
$conn = Get-NetTCPConnection -LocalPort 3030 -State Listen -ErrorAction SilentlyContinue
if ($conn) {
    $pids = $conn | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($p in $pids) {
        Write-Host "Dang dung tien trinh Grafana cu (PID: $p)..."
        Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
    }
} else {
    Write-Host "Cong 3030 chua co tien trinh nao chay."
}

# 2. Cho cong 3030 giai phong
Write-Host "Cho cong 3030 giai phong hoan toan..."
for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Milliseconds 500
    $connCheck = Get-NetTCPConnection -LocalPort 3030 -State Listen -ErrorAction SilentlyContinue
    if (-not $connCheck) {
        Write-Host "Cong 3030 da giai phong!"
        break
    }
}

# 3. Khoi dong lai Grafana
Write-Host "Khoi dong lai Grafana Server..."
$grafCmd = ('cmd.exe /c "cd /d "' + $grafanaDir + '" && "' + $grafanaExe + '" server --config="' + $grafanaConfig + '""')

$res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $grafCmd
    CurrentDirectory = $grafanaDir
}

Write-Host "Ket qua tao tien trinh: ReturnValue = $($res.ReturnValue), ProcessId = $($res.ProcessId)"

# 4. Cho Grafana san sang /api/health
Write-Host "Cho Grafana san sang qua /api/health..."
$healthOk = $false
$healthData = $null
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 1
    try {
        $resp = Invoke-WebRequest -Uri 'http://127.0.0.1:3030/api/health' -UseBasicParsing -TimeoutSec 2
        if ($resp.StatusCode -eq 200 -and $resp.Content) {
            $json = $resp.Content | ConvertFrom-Json
            if ($json.database -and ($json.database -ieq 'ok')) {
                $healthOk = $true
                $healthData = $json
                Write-Host "Grafana /api/health OK sau $i giay!"
                break
            }
        }
    } catch {}
}

if (-not $healthOk) {
    Write-Error "Grafana khong phan hoi /api/health hop le sau 20 giay!"
    exit 1
}

$connNew = Get-NetTCPConnection -LocalPort 3030 -State Listen -ErrorAction SilentlyContinue
$newPid = if ($connNew) { ($connNew | Select-Object -ExpandProperty OwningProcess -Unique)[0] } else { 'Unknown' }

Write-Host "Grafana da khoi dong lai thanh cong:"
Write-Host "- HTTP Status: 200"
Write-Host "- Database: $($healthData.database)"
Write-Host "- Version: $($healthData.version)"
Write-Host "- PID moi: $newPid"
