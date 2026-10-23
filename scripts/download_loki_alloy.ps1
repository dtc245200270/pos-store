$ErrorActionPreference = 'Stop'

Write-Host "=== CAI DAT LOKI & GRAFANA ALLOY CHO WINDOWS ===" -ForegroundColor Cyan

$lokiDir = "C:\loki"
$alloyDir = "C:\alloy"

if (-not (Test-Path $lokiDir)) {
    New-Item -ItemType Directory -Path $lokiDir -Force | Out-Null
}
if (-not (Test-Path "$lokiDir\data")) {
    New-Item -ItemType Directory -Path "$lokiDir\data" -Force | Out-Null
}

if (-not (Test-Path $alloyDir)) {
    New-Item -ItemType Directory -Path $alloyDir -Force | Out-Null
}
if (-not (Test-Path "$alloyDir\data")) {
    New-Item -ItemType Directory -Path "$alloyDir\data" -Force | Out-Null
}

# 1. Download Loki v3.7.8
$lokiExe = "$lokiDir\loki.exe"
if (-not (Test-Path $lokiExe)) {
    $lokiUrl = "https://github.com/grafana/loki/releases/download/v3.7.8/loki-windows-amd64.exe.zip"
    $lokiZip = "$lokiDir\loki.zip"
    Write-Host "Dang tai Loki v3.7.8 tu $lokiUrl..." -ForegroundColor Yellow
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $lokiUrl -OutFile $lokiZip -UseBasicParsing
    Write-Host "Dang giai nen Loki..." -ForegroundColor Yellow
    Expand-Archive -Path $lokiZip -DestinationPath $lokiDir -Force
    Remove-Item -Path $lokiZip -Force
    
    $extracted = Get-ChildItem -Path $lokiDir -Filter "loki-windows-amd64*.exe" | Select-Object -First 1
    if ($extracted) {
        Move-Item -Path $extracted.FullName -Destination $lokiExe -Force
    }
}
Write-Host "[OK] Loki executable tai: $lokiExe" -ForegroundColor Green
& $lokiExe --version

# 2. Download Alloy v1.20.1
$alloyExe = "$alloyDir\alloy.exe"
if (-not (Test-Path $alloyExe)) {
    $alloyUrl = "https://github.com/grafana/alloy/releases/download/v1.20.1/alloy-windows-amd64.exe.zip"
    $alloyZip = "$alloyDir\alloy.zip"
    Write-Host "Dang tai Alloy v1.20.1 tu $alloyUrl..." -ForegroundColor Yellow
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $alloyUrl -OutFile $alloyZip -UseBasicParsing
    Write-Host "Dang giai nen Alloy..." -ForegroundColor Yellow
    Expand-Archive -Path $alloyZip -DestinationPath $alloyDir -Force
    Remove-Item -Path $alloyZip -Force
    
    $extractedAlloy = Get-ChildItem -Path $alloyDir -Filter "alloy-windows-amd64*.exe" | Select-Object -First 1
    if ($extractedAlloy) {
        Move-Item -Path $extractedAlloy.FullName -Destination $alloyExe -Force
    }
}
Write-Host "[OK] Alloy executable tai: $alloyExe" -ForegroundColor Green
& $alloyExe --version

Write-Host "`n[HOAN TAT] Cai dat thanh cong Loki va Grafana Alloy!" -ForegroundColor Green
