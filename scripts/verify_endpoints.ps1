$ErrorActionPreference = 'SilentlyContinue'

Write-Host "=== 1. KIEM TRA CAC ENDPOINT THUC TE ==="

# Backend /login
try {
    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:3000/login" -UseBasicParsing -TimeoutSec 5
    Write-Host "Backend /login (http://127.0.0.1:3000/login): HTTP $($resp.StatusCode)"
} catch {
    Write-Host "Backend /login ERROR: $_"
}

# Website http://localhost:8080/login
try {
    $resp = Invoke-WebRequest -Uri "http://localhost:8080/login" -UseBasicParsing -TimeoutSec 5
    Write-Host "Website (http://localhost:8080/login): HTTP $($resp.StatusCode)"
} catch {
    Write-Host "Website ERROR: $_"
}

# Metrics /metrics
try {
    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:9101/metrics" -UseBasicParsing -TimeoutSec 5
    Write-Host "Metrics /metrics (http://127.0.0.1:9101/metrics): HTTP $($resp.StatusCode)"
} catch {
    Write-Host "Metrics ERROR: $_"
}

# Prometheus /-/ready
try {
    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:9090/-/ready" -UseBasicParsing -TimeoutSec 5
    Write-Host "Prometheus /-/ready (http://127.0.0.1:9090/-/ready): HTTP $($resp.StatusCode)"
} catch {
    Write-Host "Prometheus ERROR: $_"
}

# Target pos_store status via Prometheus API
try {
    $targetsResp = Invoke-WebRequest -Uri "http://127.0.0.1:9090/api/v1/targets" -UseBasicParsing -TimeoutSec 5
    $targetsJson = $targetsResp.Content | ConvertFrom-Json
    $posTarget = $targetsJson.data.activeTargets | Where-Object { $_.labels.job -eq 'pos_store' -or $_.scrapePool -eq 'pos_store' }
    if ($posTarget) {
        Write-Host "Target pos_store: $(($posTarget.health).ToUpper()) (URL: $($posTarget.scrapeUrl), LastScrape: $($posTarget.lastScrape), LastError: '$($posTarget.lastError)')"
    } else {
        Write-Host "Target pos_store: NOT FOUND in activeTargets"
    }
} catch {
    Write-Host "Prometheus Target check ERROR: $_"
}

# Grafana /api/health
try {
    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:3030/api/health" -UseBasicParsing -TimeoutSec 5
    $gJson = $resp.Content | ConvertFrom-Json
    Write-Host "Grafana /api/health (http://127.0.0.1:3030/api/health): HTTP $($resp.StatusCode), database = '$($gJson.database)', version = '$($gJson.version)'"
} catch {
    Write-Host "Grafana ERROR: $_"
}

Write-Host "`n=== 2. THONG TIN TIEN TRINH (PID VA DUONG DAN EXECUTABLE) ==="

$ports = @(
    @{ Name = "MySQL80"; Port = 3306 },
    @{ Name = "Backend (Node.js)"; Port = 3000 },
    @{ Name = "Metrics Server"; Port = 9101 },
    @{ Name = "Nginx"; Port = 8080 },
    @{ Name = "Prometheus"; Port = 9090 },
    @{ Name = "Grafana"; Port = 3030 }
)

foreach ($item in $ports) {
    $conn = Get-NetTCPConnection -LocalPort $item.Port -State Listen -ErrorAction SilentlyContinue
    if ($conn) {
        $pids = $conn | Select-Object -ExpandProperty OwningProcess -Unique
        foreach ($pidItem in $pids) {
            $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $pidItem" -ErrorAction SilentlyContinue
            $exePath = if ($proc.ExecutablePath) { 
                $proc.ExecutablePath 
            } else { 
                $svc = Get-CimInstance Win32_Service -Filter "ProcessId = $pidItem" -ErrorAction SilentlyContinue
                if ($svc) { $svc.PathName } else { (Get-Process -Id $pidItem -ErrorAction SilentlyContinue).Path }
            }
            Write-Host "$($item.Name) (Port $($item.Port)): PID $pidItem | Process: $($proc.Name) | Executable: $exePath"
        }
    } else {
        Write-Host "$($item.Name) (Port $($item.Port)): NOT LISTENING"
    }
}

$nginxList = Get-Process -Name nginx -ErrorAction SilentlyContinue
if ($nginxList) {
    Write-Host "`nChi tiet cac tien trinh Nginx dang chay:"
    foreach ($nx in $nginxList) {
        Write-Host "  - PID $($nx.Id) | $($nx.Path)"
    }
}
