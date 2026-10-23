$ErrorActionPreference = 'Stop'

Write-Host "=== TEST: RELOAD THAT BAI ROI CHAY LAI - KHONG DUOC BO QUA VIEC AP DUNG ===" -ForegroundColor Cyan

$promDiskPath = "C:\prometheus\prometheus.yml"
$repoPromPath = "deploy\monitoring\prometheus.yml"

$origRepoContent = Get-Content -LiteralPath $repoPromPath -Raw
$origDiskContent = Get-Content -LiteralPath $promDiskPath -Raw
$origDiskHash    = (Get-FileHash -LiteralPath $promDiskPath -Algorithm SHA256).Hash

try {
    # -------------------------------------------------------------------------
    # KICH BAN 1: MO PHONG THUC TE POST /-/reload THAT BAI TREN LUONG SAN XUAT
    # -------------------------------------------------------------------------
    Write-Host "`n--- KICH BAN 1: MO PHONG POST /-/reload THAT BAI ---" -ForegroundColor Cyan
    Write-Host "1. Them nhan canary_retry: 'post_fail' vao prometheus.yml..."
    $postFailContent = $origRepoContent.Replace("env: 'development'", "env: 'development'`n          canary_retry: 'post_fail'")
    Set-Content -LiteralPath $repoPromPath -Value $postFailContent -NoNewline

    # Dat bien moi truong de start-monitoring.ps1 goi reload toi port loi 9999 tren luong that
    $env:TEST_MOCK_PROM_RELOAD_URI = 'http://127.0.0.1:9999/-/reload'

    Write-Host "2. Chay start-monitoring.ps1 voi POST reload bi loi ket noi..."
    $proc1 = Start-Process -FilePath "powershell.exe" `
        -ArgumentList @("-ExecutionPolicy", "Bypass", "-File", "deploy\monitoring\start-monitoring.ps1") `
        -NoNewWindow -PassThru -Wait

    $exitCode1 = $proc1.ExitCode
    Write-Host "Exit code khi POST reload loi: $exitCode1"
    if ($exitCode1 -eq 0) {
        throw "ASSERTION FAILED: start-monitoring.ps1 phai thoat khac 0 khi POST reload that bai!"
    }
    Write-Host "[ASSERTION OK] start-monitoring.ps1 thoat voi exit code $exitCode1 (khac 0) khi POST reload that bai." -ForegroundColor Green

    # Kiem tra disk hash da duoc rollback ve file hop le ban dau
    $diskHashAfterFail1 = (Get-FileHash -LiteralPath $promDiskPath -Algorithm SHA256).Hash
    Write-Host "Xac nhan disk hash sau khi rollback: $diskHashAfterFail1 (Goc: $origDiskHash)"
    if ($diskHashAfterFail1 -ne $origDiskHash) {
        throw "ASSERTION FAILED: File tren disk khong duoc rollback ve file hop le ban dau! Disk: $diskHashAfterFail1, Goc: $origDiskHash"
    }
    Write-Host "[ASSERTION OK] File disk da duoc rollback va xac nhan khop 100% hash hop le cu!" -ForegroundColor Green

    # Go bo mock reload uri
    $env:TEST_MOCK_PROM_RELOAD_URI = $null

    # Chay lai start-monitoring.ps1 binh thuong: phai tu dong ap dung cau hinh con thieu
    Write-Host "3. Chay lai start-monitoring.ps1 lan tiep theo (moi truong binh thuong)..."
    $proc1Retry = Start-Process -FilePath "powershell.exe" `
        -ArgumentList @("-ExecutionPolicy", "Bypass", "-File", "deploy\monitoring\start-monitoring.ps1") `
        -NoNewWindow -PassThru -Wait

    if ($proc1Retry.ExitCode -ne 0) {
        throw "ASSERTION FAILED: Chay lai sau reload loi that bai voi exit code $($proc1Retry.ExitCode)!"
    }

    # Kiem tra runtime da nhan canary_retry='post_fail'
    $statusResp1 = Invoke-WebRequest -Uri 'http://127.0.0.1:9090/api/v1/status/config' -UseBasicParsing -TimeoutSec 5
    $yamlRuntime1 = ($statusResp1.Content | ConvertFrom-Json).data.yaml
    if ($yamlRuntime1 -notmatch 'canary_retry:[ \t]*[''"]?post_fail[''"]?') {
        throw "ASSERTION FAILED: Runtime Prometheus chua duoc cap nhat canary_retry='post_fail' o lan chay tiep theo!"
    }
    Write-Host "[ASSERTION OK] Lan chay tiep theo da khong bo qua va ap dung thanh cong canary_retry='post_fail'!" -ForegroundColor Green

    # -------------------------------------------------------------------------
    # KICH BAN 2: MO PHONG THUC TE GET /api/v1/status/config THAT BAI SAU RELOAD
    # -------------------------------------------------------------------------
    Write-Host "`n--- KICH BAN 2: MO PHONG GET /api/v1/status/config THAT BAI SAU RELOAD ---" -ForegroundColor Cyan
    Write-Host "1. Doi nhan sang canary_retry: 'status_fail'..."
    $statusFailContent = $origRepoContent.Replace("env: 'development'", "env: 'development'`n          canary_retry: 'status_fail'")
    Set-Content -LiteralPath $repoPromPath -Value $statusFailContent -NoNewline

    # Ghi nhan disk hash hop le truoc khi bat dau kich ban 2
    $validDiskHash2 = (Get-FileHash -LiteralPath $promDiskPath -Algorithm SHA256).Hash

    # Dat bien moi truong mock status config uri toi port loi
    $env:TEST_MOCK_PROM_STATUS_CONFIG_URI = 'http://127.0.0.1:9999/api/v1/status/config'

    Write-Host "2. Chay start-monitoring.ps1 voi GET status/config bi loi..."
    $proc2 = Start-Process -FilePath "powershell.exe" `
        -ArgumentList @("-ExecutionPolicy", "Bypass", "-File", "deploy\monitoring\start-monitoring.ps1") `
        -NoNewWindow -PassThru -Wait

    $exitCode2 = $proc2.ExitCode
    Write-Host "Exit code khi GET status/config loi: $exitCode2"
    if ($exitCode2 -eq 0) {
        throw "ASSERTION FAILED: start-monitoring.ps1 phai thoat khac 0 khi GET status/config that bai!"
    }
    Write-Host "[ASSERTION OK] start-monitoring.ps1 thoat voi exit code $exitCode2 (khac 0) khi GET status/config that bai." -ForegroundColor Green

    # Kiem tra disk hash da duoc rollback ve file hop le
    $diskHashAfterFail2 = (Get-FileHash -LiteralPath $promDiskPath -Algorithm SHA256).Hash
    Write-Host "Xac nhan disk hash sau khi rollback: $diskHashAfterFail2 (Goc: $validDiskHash2)"
    if ($diskHashAfterFail2 -ne $validDiskHash2) {
        throw "ASSERTION FAILED: File tren disk khong duoc rollback ve file hop le! Disk: $diskHashAfterFail2, Goc: $validDiskHash2"
    }
    Write-Host "[ASSERTION OK] File disk da duoc rollback va xac nhan khop 100% hash hop le cu!" -ForegroundColor Green

    # Go bo mock status config uri
    $env:TEST_MOCK_PROM_STATUS_CONFIG_URI = $null

    # Chay lai start-monitoring.ps1 binh thuong
    Write-Host "3. Chay lai start-monitoring.ps1 lan tiep theo (moi truong binh thuong)..."
    $proc2Retry = Start-Process -FilePath "powershell.exe" `
        -ArgumentList @("-ExecutionPolicy", "Bypass", "-File", "deploy\monitoring\start-monitoring.ps1") `
        -NoNewWindow -PassThru -Wait

    if ($proc2Retry.ExitCode -ne 0) {
        throw "ASSERTION FAILED: Chay lai sau status loi that bai voi exit code $($proc2Retry.ExitCode)!"
    }

    # Kiem tra runtime da nhan canary_retry='status_fail'
    $statusResp2 = Invoke-WebRequest -Uri 'http://127.0.0.1:9090/api/v1/status/config' -UseBasicParsing -TimeoutSec 5
    $yamlRuntime2 = ($statusResp2.Content | ConvertFrom-Json).data.yaml
    if ($yamlRuntime2 -notmatch 'canary_retry:[ \t]*[''"]?status_fail[''"]?') {
        throw "ASSERTION FAILED: Runtime Prometheus chua duoc cap nhat canary_retry='status_fail' o lan chay tiep theo!"
    }
    Write-Host "[ASSERTION OK] Lan chay tiep theo da khong bo qua va ap dung thanh cong canary_retry='status_fail'!" -ForegroundColor Green

    # -------------------------------------------------------------------------
    # KICH BAN 3: DISK TRUNG HASH NHUNG RUNTIME CHUA AP DUNG
    # -------------------------------------------------------------------------
    Write-Host "`n--- KICH BAN 3: DISK TRUNG HASH NHUNG RUNTIME CHUA AP DUNG ---" -ForegroundColor Cyan
    Write-Host "1. File disk va repo cung ghi canary_retry: 'v3', nhung runtime chua duoc reload..."
    $canaryContentV3 = $origRepoContent.Replace("env: 'development'", "env: 'development'`n          canary_retry: 'v3'")
    Set-Content -LiteralPath $repoPromPath -Value $canaryContentV3 -NoNewline
    Set-Content -LiteralPath $promDiskPath -Value $canaryContentV3 -NoNewline

    $dHash = (Get-FileHash -LiteralPath $promDiskPath -Algorithm SHA256).Hash
    $rHash = (Get-FileHash -LiteralPath $repoPromPath -Algorithm SHA256).Hash
    Write-Host "Xac nhan disk hash == repo hash: ($dHash == $rHash)"
    if ($dHash -ne $rHash) { throw "Loi setup: hash disk va repo khac nhau!" }

    Write-Host "2. Chay start-monitoring.ps1..."
    $proc3 = Start-Process -FilePath "powershell.exe" `
        -ArgumentList @("-ExecutionPolicy", "Bypass", "-File", "deploy\monitoring\start-monitoring.ps1") `
        -NoNewWindow -PassThru -Wait

    $exitCode3 = $proc3.ExitCode
    Write-Host "Exit code: $exitCode3"
    if ($exitCode3 -ne 0) {
        throw "ASSERTION FAILED: start-monitoring.ps1 that bai voi exit code $exitCode3!"
    }

    $statusRespV3 = Invoke-WebRequest -Uri 'http://127.0.0.1:9090/api/v1/status/config' -UseBasicParsing -TimeoutSec 5
    $yamlRuntimeV3 = ($statusRespV3.Content | ConvertFrom-Json).data.yaml
    if ($yamlRuntimeV3 -notmatch 'canary_retry:[ \t]*[''"]?v3[''"]?') {
        throw "ASSERTION FAILED: Script bo qua reload! Runtime van chua co canary_retry='v3'."
    }
    Write-Host "[ASSERTION OK] Du disk hash == repo hash, start-monitoring.ps1 van phat hien runtime chua co 'v3' va reload thanh cong!" -ForegroundColor Green

} finally {
    Write-Host "`n[FINALLY] Don dep bien moi truong, phuc hoi file goc ve disk va repo..." -ForegroundColor Yellow
    $env:TEST_MOCK_PROM_RELOAD_URI = $null
    $env:TEST_MOCK_PROM_STATUS_CONFIG_URI = $null

    Set-Content -LiteralPath $repoPromPath -Value $origRepoContent -NoNewline
    Set-Content -LiteralPath $promDiskPath -Value $origDiskContent -NoNewline

    # Chay start-monitoring de runtime tro ve ban goc
    $restoreProc = Start-Process -FilePath "powershell.exe" `
        -ArgumentList @("-ExecutionPolicy", "Bypass", "-File", "deploy\monitoring\start-monitoring.ps1") `
        -NoNewWindow -PassThru -Wait

    # Xac nhan runtime khong con canary
    $statusRespClean = Invoke-WebRequest -Uri 'http://127.0.0.1:9090/api/v1/status/config' -UseBasicParsing -TimeoutSec 5
    $yamlClean = ($statusRespClean.Content | ConvertFrom-Json).data.yaml
    $stillHasCanary = $yamlClean -match 'canary_retry'
    if ($stillHasCanary) {
        Write-Error "Chua xoa bo duoc canary_retry khoi runtime!"
    } else {
        Write-Host "[FINALLY OK] Runtime da duoc phuc hoi sach se ve nguyen ban." -ForegroundColor Green
    }
}

Write-Host "`n=> TOAN BO TEST RELOAD RETRY & KHONG BO QUA AP DUNG: PASS HOAN TOAN!" -ForegroundColor Green
exit 0
