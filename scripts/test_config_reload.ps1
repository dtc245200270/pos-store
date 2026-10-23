$ErrorActionPreference = 'Stop'

Write-Host "=== TEST: KIEM TRA NHANH RELOAD CAU HINH PROMETHEUS ==="

$promConfigFile = "deploy\monitoring\prometheus.yml"
$originalContent = Get-Content -LiteralPath $promConfigFile -Raw
$originalHash = (Get-FileHash -LiteralPath $promConfigFile -Algorithm SHA256).Hash

try {
    # 1. Tao thay doi cau hinh hop le: them label reload_test: 'verified_active'
    Write-Host "1. Them nhan reload_test: 'verified_active' vao prometheus.yml..."
    $modifiedContent = $originalContent.Replace("env: 'development'", "env: 'development'`n          reload_test: 'verified_active'")
    Set-Content -LiteralPath $promConfigFile -Value $modifiedContent -NoNewline

    # 2. Chay start-monitoring.ps1 de kich hoat reload
    Write-Host "2. Chay start-monitoring.ps1 de thuc hien reload..."
    $startProc = Start-Process -FilePath "powershell.exe" -ArgumentList @("-ExecutionPolicy", "Bypass", "-File", "deploy\monitoring\start-monitoring.ps1") -NoNewWindow -PassThru -Wait
    $exitCode1 = $startProc.ExitCode
    Write-Host "Exit code lan 1: $exitCode1"

    if ($exitCode1 -ne 0) {
        throw "start-monitoring.ps1 tra ve exit code $exitCode1 (khac 0) khi reload!"
    }

    # 3. Kiem tra runtime qua /api/v1/status/config
    Write-Host "3. Kiem tra runtime qua /api/v1/status/config..."
    $statusResp = Invoke-WebRequest -Uri 'http://127.0.0.1:9090/api/v1/status/config' -UseBasicParsing -TimeoutSec 5
    if ($statusResp.StatusCode -ne 200) {
        throw "Status config tra ve HTTP $($statusResp.StatusCode) (khac 200)!"
    }
    $cfgJson = $statusResp.Content | ConvertFrom-Json
    $yamlContent = $cfgJson.data.yaml

    # Kiem tra gia tri nhan chinh xac
    $labelMatched = $yamlContent -match '(?m)[ \t]*reload_test:[ \t]*[''"]?verified_active[''"]?'
    Write-Host "Xac nhan label reload_test co gia tri dung 'verified_active': $(if ($labelMatched) { 'PASS' } else { 'FAIL' })"
    if (-not $labelMatched) {
        throw "Runtime Prometheus chua nhan label reload_test='verified_active'!"
    }

    Write-Host "`n=> GIAI DOAN RELOAD CAU HINH MOI: PASS" -ForegroundColor Green
} finally {
    Write-Host "`n[FINALLY] Luon khoi phuc file goc va runtime ve nguyen ban..."
    Set-Content -LiteralPath $promConfigFile -Value $originalContent -NoNewline

    $restoreProc = Start-Process -FilePath "powershell.exe" -ArgumentList @("-ExecutionPolicy", "Bypass", "-File", "deploy\monitoring\start-monitoring.ps1") -NoNewWindow -PassThru -Wait
    $exitCodeRestore = $restoreProc.ExitCode
    Write-Host "Exit code khi khoi phuc: $exitCodeRestore"

    # Kiem tra runtime da thuc su go bo label reload_test
    $statusResp2 = Invoke-WebRequest -Uri 'http://127.0.0.1:9090/api/v1/status/config' -UseBasicParsing -TimeoutSec 5
    $yamlContent2 = ($statusResp2.Content | ConvertFrom-Json).data.yaml
    $hasReloadTest = $yamlContent2 -match 'reload_test'
    Write-Host "Xac nhan runtime da xoa bo reload_test: $(if (-not $hasReloadTest) { 'PASS' } else { 'FAIL' })"

    if ($exitCodeRestore -ne 0 -or $hasReloadTest) {
        Write-Error "Khoi phuc cau hinh ve runtime that bai!"
        exit 1
    }
}

Write-Host "`n=> TOAN BO TEST RELOAD: PASS HOAN TOAN!" -ForegroundColor Green
exit 0
