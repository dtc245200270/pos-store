$ErrorActionPreference = 'Stop'

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   CHAY TOAN BO BO KIEM TRA VAN HANH HE THONG GIAM SAT    " -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Cyan

$testList = @(
    @{ Name = "AST Syntax Parse"; Script = "scripts\test_ast_syntax.ps1"; Description = "Kiem tra cu phap PowerShell AST cua start va stop scripts" },
    @{ Name = "Invalid Config Rejection"; Script = "scripts\test_invalid_config_does_not_replace.ps1"; Description = "Cau hinh ung vien loi bi promtool chan, khong thay the file disk" },
    @{ Name = "Reload Failure & Retry"; Script = "scripts\test_reload_retry_not_skipped.ps1"; Description = "Khong bo qua ap dung khi reload lai hoac khi disk hash trung repo hash" },
    @{ Name = "Runtime Mismatch Detection"; Script = "scripts\test_runtime_mismatch_detection.ps1"; Description = "Phat hien sai khac giua runtime va desired, xu ly cac gia tri mac dinh" },
    @{ Name = "Negative Assertions"; Script = "scripts\test_negative_assertions.ps1"; Description = "Bat buoc exit 1 khi target DOWN, database loi, thieu du lieu lich su" },
    @{ Name = "Start Idempotency"; Script = "scripts\test_start_idempotency.ps1"; Description = "Start khi dang chay giu nguyen PID, assertion HTTP 200, target UP, DB ok" },
    @{ Name = "Stop & Restart Monitoring"; Script = "scripts\test_stop_and_restart_monitoring.ps1"; Description = "Dung va mo lai, kiem tra bao toan mau lich su tuyet doi va noi dung tat ca panel" }
)

$results = @()
$fullLog = ""

foreach ($t in $testList) {
    Write-Host "`n>>> [RUNNING] $($t.Name)..." -ForegroundColor Yellow
    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    $p = Start-Process -FilePath "powershell.exe" `
        -ArgumentList @("-ExecutionPolicy", "Bypass", "-File", $t.Script) `
        -NoNewWindow -PassThru -Wait

    $sw.Stop()
    $exitCode = $p.ExitCode

    $status = if ($exitCode -eq 0) { "PASS" } else { "FAIL" }
    $color = if ($exitCode -eq 0) { "Green" } else { "Red" }

    Write-Host ">>> [RESULT] $($t.Name): $status (ExitCode: $exitCode, Thoi gian: $($sw.ElapsedMilliseconds)ms)" -ForegroundColor $color

    $results += [PSCustomObject]@{
        Name = $t.Name
        Script = $t.Script
        Description = $t.Description
        Status = $status
        ExitCode = $exitCode
        DurationMs = $sw.ElapsedMilliseconds
        Timestamp = (Get-Date -Format "yyyy-MM-ddTHH:mm:sszzz")
    }

    if ($exitCode -ne 0) {
        Write-Error "Test '$($t.Name)' that bai voi exit code $exitCode!"
    }
}

$evidenceDir = "deploy\monitoring\artifacts"
if (-not (Test-Path -LiteralPath $evidenceDir)) {
    New-Item -ItemType Directory -Path $evidenceDir -Force | Out-Null
}

$reportPath = Join-Path $evidenceDir "test_execution_report.json"
$summaryObj = @{
    TotalTests = $results.Count
    Passed = ($results | Where-Object { $_.Status -eq "PASS" }).Count
    Failed = ($results | Where-Object { $_.Status -eq "FAIL" }).Count
    AllPassed = (($results | Where-Object { $_.Status -ne "PASS" }).Count -eq 0)
    ExecutedAt = (Get-Date -Format "yyyy-MM-ddTHH:mm:sszzz")
    Tests = $results
}

$summaryObj | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $reportPath -Encoding utf8
Write-Host "`n[OK] Da luu bao cao ket qua kiem tra JSON tai: $reportPath" -ForegroundColor Green

Write-Host "`n==========================================================" -ForegroundColor Cyan
Write-Host "   TONG KET: $($summaryObj.Passed)/$($summaryObj.TotalTests) BAI TEST DAT CHUAN PASS 100%           " -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Cyan
