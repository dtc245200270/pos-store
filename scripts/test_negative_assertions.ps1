$ErrorActionPreference = 'Stop'

Write-Host "=== TEST: KIEM TRA CAC ASSERTION BAT BUOC PHAI BAT DUNG LOI (NEGATIVE TESTS) ===" -ForegroundColor Cyan
Write-Host "Kiem tra: goi dung ham assertion chung, xac thuc bat dung mau loi mong doi (expected error pattern)`n"

# Dot-source thu vien assertion chung dung cho ca he thong
$assertionsLibPath = Join-Path $PSScriptRoot "monitoring-test-assertions.ps1"
if (-not (Test-Path -LiteralPath $assertionsLibPath)) {
    throw "Khong tim thay thu vien assertion chung tai '$assertionsLibPath'!"
}
. $assertionsLibPath

$testCount = 0
$passCount = 0

function Verify-AssertionThrowsExpectedError {
    param(
        [string]$ScenarioName,
        [scriptblock]$Action,
        [string]$ExpectedPattern
    )

    $global:testCount++
    Write-Host "-> [$global:testCount] Kiem tra: $ScenarioName..." -ForegroundColor Cyan

    $threw = $false
    $actualError = ''

    try {
        & $Action
    } catch {
        $threw = $true
        $actualError = $_.Exception.Message
    }

    if (-not $threw) {
        Write-Host "   [FAIL] Ham assertion khong nem ra ngoai le nao! (Ket qua khong nhu mong doi)" -ForegroundColor Red
        return $false
    }

    if ($actualError -notmatch $ExpectedPattern) {
        Write-Host "   [FAIL] Ham assertion nem sai loi mong doi!" -ForegroundColor Red
        Write-Host "          Loi thuc te: '$actualError'" -ForegroundColor Red
        Write-Host "          Mau mong doi: '$ExpectedPattern'" -ForegroundColor Red
        return $false
    }

    Write-Host "   [PASS] Bat dung loi mong doi: '$actualError'" -ForegroundColor Green
    $global:passCount++
    return $true
}

# 1. Target pos_store o trang thai DOWN
$downTarget = @(
    @{
        labels = @{ job = 'pos_store' }
        health = 'down'
        lastError = 'connection refused 127.0.0.1:9101'
        scrapeUrl = 'http://127.0.0.1:9101/metrics'
    }
)
[void](Verify-AssertionThrowsExpectedError `
    -ScenarioName "Assert-TargetUp phai nem dung loi khi target DOWN" `
    -Action { Assert-TargetUp -ActiveTargets $downTarget } `
    -ExpectedPattern "Target 'pos_store' khong o trang thai UP! Trang thai thuc te: 'down'")

# 2. Target pos_store bi thieu trong activeTargets
$missingTarget = @(
    @{
        labels = @{ job = 'other_service' }
        health = 'up'
    }
)
[void](Verify-AssertionThrowsExpectedError `
    -ScenarioName "Assert-TargetUp phai nem dung loi khi thieu target pos_store" `
    -Action { Assert-TargetUp -ActiveTargets $missingTarget } `
    -ExpectedPattern "Target 'pos_store' khong tim thay trong Prometheus activeTargets")

# 3. Grafana health tra ve database khong phai 'ok'
$failingDbHealth = @{
    database = 'failing'
    version = '11.5.2'
}
[void](Verify-AssertionThrowsExpectedError `
    -ScenarioName "Assert-GrafanaHealth phai nem dung loi khi database failing" `
    -Action { Assert-GrafanaHealth -HealthJson $failingDbHealth -StatusCode 200 } `
    -ExpectedPattern "Grafana database khong phai 'ok'! Gia tri thuc te: 'failing'")

# 4. Grafana health tra ve HTTP StatusCode khac 200
$health503 = @{ database = 'ok'; version = '11.5.2' }
[void](Verify-AssertionThrowsExpectedError `
    -ScenarioName "Assert-GrafanaHealth phai nem dung loi khi HTTP tra ve 503" `
    -Action { Assert-GrafanaHealth -HealthJson $health503 -StatusCode 503 } `
    -ExpectedPattern "Grafana /api/health tra ve HTTP 503")

# 5. Du lieu lich su Prometheus rong (samples = 0) truoc restart
[void](Verify-AssertionThrowsExpectedError `
    -ScenarioName "Assert-HistoricalSamples phai nem dung loi khi so mau lich su = 0" `
    -Action { Assert-HistoricalSamples -SamplesBefore 0 -SamplesAfter 0 } `
    -ExpectedPattern "Khong co mau lich su nao \(0 mau\) truoc restart")

# 6. Du lieu lich su Prometheus bi sai lech truoc/sau restart trong cung cua so
[void](Verify-AssertionThrowsExpectedError `
    -ScenarioName "Assert-HistoricalSamples phai nem dung loi khi mau truoc va sau khac nhau" `
    -Action { Assert-HistoricalSamples -SamplesBefore 40 -SamplesAfter 38 -TimeWindowDesc "[tEnd-600, tEnd]" } `
    -ExpectedPattern "Du lieu lich su Prometheus bi sai lech sau restart! Truoc=40, Sau=38")

# 7. Dich vu ngoai monitoring bi thay doi PID
[void](Verify-AssertionThrowsExpectedError `
    -ScenarioName "Assert-ServicePidsUnchanged phai nem dung loi khi PID thay doi" `
    -Action { Assert-ServicePidsUnchanged -PidsBefore @{ MySQL=6652 } -PidsAfter @{ MySQL=9999 } -Context "Dich vu" } `
    -ExpectedPattern "Dich vu 'MySQL' bi thay doi PID! Truoc=6652, Sau=9999")

# 8. Dashboard Panel bi sua doi bieu thuc PromQL (expr)
$panelBeforeExpr = @(
    @{
        id = 3
        title = 'Ty le phan hoi HTTP 5xx (%)'
        type = 'stat'
        targets = @(@{ expr = 'old_expr_pos_store' })
        fieldConfig = @{ defaults = @{ noValue = 'Chua co du lieu'; mappings = @(); thresholds = @{} } }
    }
)
$panelAfterTampered = @(
    @{
        id = 3
        title = 'Ty le phan hoi HTTP 5xx (%)'
        type = 'stat'
        targets = @(@{ expr = 'tampered_expr_pos_store' })
        fieldConfig = @{ defaults = @{ noValue = 'Chua co du lieu'; mappings = @(); thresholds = @{} } }
    }
)
[void](Verify-AssertionThrowsExpectedError `
    -ScenarioName "Assert-DashboardPanelsMatch phai nem dung loi khi Panel bi doi bieu thuc" `
    -Action { Assert-DashboardPanelsMatch -PanelsBefore $panelBeforeExpr -PanelsAfter $panelAfterTampered } `
    -ExpectedPattern "Panel ID 3 .* sai bieu thuc! Truoc: 'old_expr_pos_store', Sau: 'tampered_expr_pos_store'")

# 9. Dashboard Panel bi thay doi so luong
$panelsCountBefore = @(@{ id=1 }, @{ id=2 }, @{ id=3 })
$panelsCountAfter  = @(@{ id=1 }, @{ id=2 })
[void](Verify-AssertionThrowsExpectedError `
    -ScenarioName "Assert-DashboardPanelsMatch phai nem dung loi khi so luong panel thay doi" `
    -Action { Assert-DashboardPanelsMatch -PanelsBefore $panelsCountBefore -PanelsAfter $panelsCountAfter } `
    -ExpectedPattern "So luong panel thay doi! Truoc: 3, Sau: 2")

# 10. Cong chua duoc giai phong (kiem tra voi cong 9090 dang mo boi Prometheus)
[void](Verify-AssertionThrowsExpectedError `
    -ScenarioName "Assert-PortsReleased phai nem dung loi khi cong 9090 chua giai phong" `
    -Action { Assert-PortsReleased -Ports @(9090) } `
    -ExpectedPattern "Cong 9090 chua duoc giai phong sau khi stop-monitoring")

Write-Host "`n----------------------------------------------------------"
Write-Host "Ket qua: $passCount/$testCount khao sat negative assertions bat dung loi mong doi." -ForegroundColor Cyan

if ($passCount -ne $testCount) {
    Write-Error "Co it nhat mot assertion khong bat dung loi mong doi!"
    exit 1
}

Write-Host "`n=> TOAN BO CAC KIEM TRA NEGATIVE ASSERTIONS (GOI DUNG HAM CHUNG VA BAT DUNG LOI): PASS 100%!" -ForegroundColor Green
exit 0
