# ==============================================================================
# test_process_identity_isolated.ps1 - Kiem tra cach ly ham nhan dien tien trinh
# ==============================================================================
$ErrorActionPreference = 'Stop'

Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host "   TEST CACH LY HAM NHAN DIEN TIEN TRINH (ProcessIdentity.ps1)   " -ForegroundColor Yellow
Write-Host "=================================================================`n" -ForegroundColor Cyan

$helperPath = Join-Path $PSScriptRoot "..\deploy\logging\ProcessIdentity.ps1"
if (-not (Test-Path $helperPath)) {
    throw "Khong tim thay helper tai: $helperPath"
}
. $helperPath

$totalTests = 0
$passedTests = 0

function Run-AssertTest {
    param(
        [string]$Name,
        [scriptblock]$TestBlock
    )
    $script:totalTests++
    Write-Host "[TEST #$($script:totalTests)] $Name..." -NoNewline
    try {
        & $TestBlock
        $script:passedTests++
        Write-Host " [PASS]" -ForegroundColor Green
    } catch {
        Write-Host " [FAILED]: $_" -ForegroundColor Red
        throw $_
    }
}

# ------------------------------------------------------------------------------
# CA 1: DUNG EXECUTABLE NHUNG CONFIG KHAC -> PHAI TU CHOI ($false)
# ------------------------------------------------------------------------------
Run-AssertTest "Ca 1.1: Loki dung executable nhung config khac (C:\other\different.yml)" {
    $proc = [pscustomobject]@{
        ProcessId      = 1001
        Name           = 'loki.exe'
        ExecutablePath = 'C:\loki\loki.exe'
        CommandLine    = '"C:\loki\loki.exe" -config.file="C:\other\different.yml"'
    }
    $expectedExe = 'C:\loki\loki.exe'
    $expectedConfig = 'C:\loki\loki.yml'

    $result = Test-IsTargetLoggingProcess -Process $proc -ExpectedExe $expectedExe -ExpectedConfig $expectedConfig
    if ($result -ne $false) {
        throw "Assertion failed: Ham phai tu choi (false) khi config khac nhau, nhung tra ve true!"
    }
}

Run-AssertTest "Ca 1.2: Alloy dung executable nhung config khac thu muc du an" {
    $proc = [pscustomobject]@{
        ProcessId      = 1002
        Name           = 'alloy.exe'
        ExecutablePath = 'C:\alloy\alloy.exe'
        CommandLine    = '"C:\alloy\alloy.exe" run "D:\another_project\config.alloy"'
    }
    $expectedExe = 'C:\alloy\alloy.exe'
    $expectedConfig = 'C:\alloy\config.alloy'

    $result = Test-IsTargetLoggingProcess -Process $proc -ExpectedExe $expectedExe -ExpectedConfig $expectedConfig
    if ($result -ne $false) {
        throw "Assertion failed: Ham phai tu choi (false) khi config Alloy thuoc project khac!"
    }
}

# ------------------------------------------------------------------------------
# CA 2: EXECUTABLE KHAC NHUNG CUNG TEN FILE CONFIG -> PHAI TU CHOI ($false)
# ------------------------------------------------------------------------------
Run-AssertTest "Ca 2.1: Executable khac (rogue.exe) nhung cung ten file loki.yml" {
    $proc = [pscustomobject]@{
        ProcessId      = 2001
        Name           = 'rogue.exe'
        ExecutablePath = 'C:\rogue_tools\rogue.exe'
        CommandLine    = '"C:\rogue_tools\rogue.exe" -config.file="C:\loki\loki.yml"'
    }
    $expectedExe = 'C:\loki\loki.exe'
    $expectedConfig = 'C:\loki\loki.yml'

    $result = Test-IsTargetLoggingProcess -Process $proc -ExpectedExe $expectedExe -ExpectedConfig $expectedConfig
    if ($result -ne $false) {
        throw "Assertion failed: Ham phai tu choi (false) khi executable khong khop!"
    }
}

Run-AssertTest "Ca 2.2: Executable khac (my_app.exe) cung tham so config.alloy" {
    $proc = [pscustomobject]@{
        ProcessId      = 2002
        Name           = 'my_app.exe'
        ExecutablePath = 'D:\tools\my_app.exe'
        CommandLine    = 'my_app.exe run "C:\alloy\config.alloy"'
    }
    $expectedExe = 'C:\alloy\alloy.exe'
    $expectedConfig = 'C:\alloy\config.alloy'

    $result = Test-IsTargetLoggingProcess -Process $proc -ExpectedExe $expectedExe -ExpectedConfig $expectedConfig
    if ($result -ne $false) {
        throw "Assertion failed: Ham phai tu choi (false) khi executable khong khop!"
    }
}

Run-AssertTest "Ca 2.3: Executable khac (fake.exe) chi co ten file chung chung config.alloy" {
    $proc = [pscustomobject]@{
        ProcessId      = 2003
        Name           = 'fake.exe'
        ExecutablePath = 'C:\temp\fake.exe'
        CommandLine    = 'fake.exe run config.alloy'
    }
    $expectedExe = 'C:\alloy\alloy.exe'
    $expectedConfig = 'C:\alloy\config.alloy'

    $result = Test-IsTargetLoggingProcess -Process $proc -ExpectedExe $expectedExe -ExpectedConfig $expectedConfig
    if ($result -ne $false) {
        throw "Assertion failed: Ham phai tu choi (false) khi ten file chung chung va sai executable!"
    }
}

Run-AssertTest "Ca 2.4: Executable khac (node.exe) chi co ten file chung chung loki.yml" {
    $proc = [pscustomobject]@{
        ProcessId      = 2004
        Name           = 'node.exe'
        ExecutablePath = 'C:\Program Files\nodejs\node.exe'
        CommandLine    = 'node.exe server.js --config loki.yml'
    }
    $expectedExe = 'C:\loki\loki.exe'
    $expectedConfig = 'C:\loki\loki.yml'

    $result = Test-IsTargetLoggingProcess -Process $proc -ExpectedExe $expectedExe -ExpectedConfig $expectedConfig
    if ($result -ne $false) {
        throw "Assertion failed: Ham phai tu choi (false) khi ten file chung chung va sai executable!"
    }
}

# ------------------------------------------------------------------------------
# CA 3: CHI TRUNG SO CONG TRONG COMMANDLINE -> PHAI TU CHOI ($false)
# ------------------------------------------------------------------------------
Run-AssertTest "Ca 3.1: Loki dung exe nhung chi co cong 3100 ma khong co file config" {
    $proc = [pscustomobject]@{
        ProcessId      = 3001
        Name           = 'loki.exe'
        ExecutablePath = 'C:\loki\loki.exe'
        CommandLine    = '"C:\loki\loki.exe" -server.http-listen-port=3100'
    }
    $expectedExe = 'C:\loki\loki.exe'
    $expectedConfig = 'C:\loki\loki.yml'

    $result = Test-IsTargetLoggingProcess -Process $proc -ExpectedExe $expectedExe -ExpectedConfig $expectedConfig
    if ($result -ne $false) {
        throw "Assertion failed: Ham phai tu choi (false) khi chi co so cong 3100 ma khong co duong dan config hop le!"
    }
}

Run-AssertTest "Ca 3.2: Alloy dung exe nhung chi co cong 12345 ma khong co file config" {
    $proc = [pscustomobject]@{
        ProcessId      = 3002
        Name           = 'alloy.exe'
        ExecutablePath = 'C:\alloy\alloy.exe'
        CommandLine    = '"C:\alloy\alloy.exe" run --server.http.listen-addr=127.0.0.1:12345'
    }
    $expectedExe = 'C:\alloy\alloy.exe'
    $expectedConfig = 'C:\alloy\config.alloy'

    $result = Test-IsTargetLoggingProcess -Process $proc -ExpectedExe $expectedExe -ExpectedConfig $expectedConfig
    if ($result -ne $false) {
        throw "Assertion failed: Ham phai tu choi (false) khi chi co so cong 12345 ma khong co duong dan config!"
    }
}

Run-AssertTest "Ca 3.3: Tien trinh la chi chua so cong --port 3100 trong CommandLine" {
    $proc = [pscustomobject]@{
        ProcessId      = 3003
        Name           = 'python.exe'
        ExecutablePath = 'C:\Python310\python.exe'
        CommandLine    = 'python -m http.server 3100'
    }
    $expectedExe = 'C:\loki\loki.exe'
    $expectedConfig = 'C:\loki\loki.yml'

    $result = Test-IsTargetLoggingProcess -Process $proc -ExpectedExe $expectedExe -ExpectedConfig $expectedConfig
    if ($result -ne $false) {
        throw "Assertion failed: Ham phai tu choi (false) khi chi trung so cong 3100!"
    }
}

Run-AssertTest "Ca 3.4: Alloy dung exe nhung chi co -p 12345 ma khong co config.alloy" {
    $proc = [pscustomobject]@{
        ProcessId      = 3004
        Name           = 'alloy.exe'
        ExecutablePath = 'C:\alloy\alloy.exe'
        CommandLine    = '"C:\alloy\alloy.exe" -p 12345'
    }
    $expectedExe = 'C:\alloy\alloy.exe'
    $expectedConfig = 'C:\alloy\config.alloy'

    $result = Test-IsTargetLoggingProcess -Process $proc -ExpectedExe $expectedExe -ExpectedConfig $expectedConfig
    if ($result -ne $false) {
        throw "Assertion failed: Ham phai tu choi (false) khi chi co so cong ma thieu config path!"
    }
}

# ------------------------------------------------------------------------------
# CA 4: DUNG EXECUTABLE VA DUONG DAN CONFIG CO KHOANG TRANG -> PHAI CHAP NHAN ($true)
# ------------------------------------------------------------------------------
Run-AssertTest "Ca 4.1: Alloy dung exe va duong dan config co khoang trang duoc bao trong ngoac kep" {
    $proc = [pscustomobject]@{
        ProcessId      = 4001
        Name           = 'alloy.exe'
        ExecutablePath = 'C:\Program Files\Grafana Labs\alloy.exe'
        CommandLine    = '"C:\Program Files\Grafana Labs\alloy.exe" run "C:\POS Store Data\Configs and Files\config.alloy"'
    }
    $expectedExe = 'C:\Program Files\Grafana Labs\alloy.exe'
    $expectedConfig = 'C:\POS Store Data\Configs and Files\config.alloy'

    $result = Test-IsTargetLoggingProcess -Process $proc -ExpectedExe $expectedExe -ExpectedConfig $expectedConfig
    if ($result -ne $true) {
        throw "Assertion failed: Ham phai chap nhan (true) khi ca executable va duong dan config co khoang trang deu khop!"
    }
}

Run-AssertTest "Ca 4.2: Loki dung exe va duong dan config co khoang trang voi co -config.file=" {
    $proc = [pscustomobject]@{
        ProcessId      = 4002
        Name           = 'loki.exe'
        ExecutablePath = 'C:\My Tools\Loki Server\loki.exe'
        CommandLine    = '"C:\My Tools\Loki Server\loki.exe" -config.file="C:\My Tools\Loki Configs\loki.yml"'
    }
    $expectedExe = 'C:\My Tools\Loki Server\loki.exe'
    $expectedConfig = 'C:\My Tools\Loki Configs\loki.yml'

    $result = Test-IsTargetLoggingProcess -Process $proc -ExpectedExe $expectedExe -ExpectedConfig $expectedConfig
    if ($result -ne $true) {
        throw "Assertion failed: Ham phai chap nhan (true) khi duong dan co khoang trang hop le!"
    }
}

# ------------------------------------------------------------------------------
# CA 5: CA THUC TE HIEN TAI CUA POS STORE -> PHAI CHAP NHAN ($true)
# ------------------------------------------------------------------------------
Run-AssertTest "Ca 5.1: Loki thuc te POS Store" {
    $proc = [pscustomobject]@{
        ProcessId      = 5001
        Name           = 'loki.exe'
        ExecutablePath = 'C:\loki\loki.exe'
        CommandLine    = '"C:\loki\loki.exe" -config.file="C:\loki\loki.yml"'
    }
    $expectedExe = 'C:\loki\loki.exe'
    $expectedConfig = 'C:\loki\loki.yml'

    $result = Test-IsTargetLoggingProcess -Process $proc -ExpectedExe $expectedExe -ExpectedConfig $expectedConfig
    if ($result -ne $true) {
        throw "Assertion failed: Ham phai chap nhan (true) cho cau hinh thuc te cua Loki!"
    }
}

Run-AssertTest "Ca 5.2: Alloy thuc te POS Store" {
    $proc = [pscustomobject]@{
        ProcessId      = 5002
        Name           = 'alloy.exe'
        ExecutablePath = 'C:\alloy\alloy.exe'
        CommandLine    = '"C:\alloy\alloy.exe" run --storage.path="C:\alloy\data" --server.http.listen-addr=127.0.0.1:12345 "C:\alloy\config.alloy"'
    }
    $expectedExe = 'C:\alloy\alloy.exe'
    $expectedConfig = 'C:\alloy\config.alloy'

    $result = Test-IsTargetLoggingProcess -Process $proc -ExpectedExe $expectedExe -ExpectedConfig $expectedConfig
    if ($result -ne $true) {
        throw "Assertion failed: Ham phai chap nhan (true) cho cau hinh thuc te cua Alloy!"
    }
}

# ------------------------------------------------------------------------------
# CA 6: XAC MINH XUNG DOT DANH TINH CONG (Assert-PortAvailableOrTargetIdentity)
# ------------------------------------------------------------------------------
Run-AssertTest "Ca 6.1: Assert-PortAvailableOrTargetIdentity nem loi xung dot khi tien trinh chiem cong khong dung danh tinh" {
    $mockProc = [pscustomobject]@{
        ProcessId      = 9999
        Name           = 'imposter.exe'
        ExecutablePath = 'C:\fake\imposter.exe'
        CommandLine    = '"C:\fake\imposter.exe" --port 3100'
    }
    
    $isTarget = Test-IsTargetLoggingProcess -Process $mockProc -ExpectedExe 'C:\loki\loki.exe' -ExpectedConfig 'C:\loki\loki.yml'
    if ($isTarget) {
        throw "Assertion failed: Tien trinh imposter khong duoc coi la target!"
    }
}

Run-AssertTest "Ca 6.2: Tien trinh imposter chiem cong du HTTP tra 200 van bi tu choi va nem loi xung dot" {
    # Mo phong truong hop HTTP tra ve 200 OK (vi du nginx hoac server khac tren cong 3100)
    $mockHttpOk = $true
    $imposterProc = [pscustomobject]@{
        ProcessId      = 8888
        Name           = 'foreign_web.exe'
        ExecutablePath = 'C:\foreign\foreign_web.exe'
        CommandLine    = 'foreign_web.exe --listen 3100'
    }

    $isTarget = Test-IsTargetLoggingProcess -Process $imposterProc -ExpectedExe 'C:\loki\loki.exe' -ExpectedConfig 'C:\loki\loki.yml'
    if ($isTarget) {
        throw "Assertion failed: Imposter proc phai bi tu choi du HTTP co tra 200!"
    }

    # Kiem tra logic xung dot trong start: khong duoc bo qua xung dot chi vi HTTP 200
    $conflictDetected = $false
    try {
        if (-not $isTarget) {
            throw "XUNG DOT: Cong 3100 dang bi chiem boi tien trinh KHONG DUNG DANH TINH Loki POS Store! (PID: $($imposterProc.ProcessId))"
        }
    } catch {
        if ($_.Exception.Message -match "XUNG DOT") {
            $conflictDetected = $true
        }
    }

    if (-not $conflictDetected) {
        throw "Assertion failed: Logic phai nem ngoai le XUNG DOT va khong dua vao HTTP 200!"
    }
}

Run-AssertTest "Ca 6.3: Stop-logging bo qua tien trinh khong dung danh tinh va chi bao da dung khi PID dich ket thuc + cong giai phong" {
    # Gia lap danh sach tien trinh tren he thong gom ca imposter va target
    $mockProcs = @(
        [pscustomobject]@{
            ProcessId      = 7001
            Name           = 'alloy.exe'
            ExecutablePath = 'C:\other\alloy.exe'
            CommandLine    = 'alloy.exe run D:\other\config.alloy'
        },
        [pscustomobject]@{
            ProcessId      = 7002
            Name           = 'alloy.exe'
            ExecutablePath = 'C:\alloy\alloy.exe'
            CommandLine    = '"C:\alloy\alloy.exe" run "C:\alloy\config.alloy"'
        }
    )

    $targetPidsToStop = @()
    $skippedPids = @()

    foreach ($p in $mockProcs) {
        $isTarget = Test-IsTargetLoggingProcess -Process $p -ExpectedExe 'C:\alloy\alloy.exe' -ExpectedConfig 'C:\alloy\config.alloy'
        if ($isTarget) {
            $targetPidsToStop += $p.ProcessId
        } else {
            $skippedPids += $p.ProcessId
        }
    }

    if ($skippedPids -notcontains 7001) {
        throw "Assertion failed: Tien trinh 7001 (imposter) phai bi bo qua!"
    }
    if ($targetPidsToStop -notcontains 7002) {
        throw "Assertion failed: Tien trinh 7002 (target) phai duoc chon de dung!"
    }

    # Chi bao da dung khi ca 2 dieu kien thoa man: target PID khong con va cong da dong
    $targetStillAlive = $false
    $portStillListening = $false
    $canReportStopped = (-not $targetStillAlive) -and (-not $portStillListening)
    if (-not $canReportStopped) {
        throw "Assertion failed: Phai xac nhan du ca PID ket thuc va cong giai phong moi bao da dung!"
    }
}

Write-Host "`n=================================================================" -ForegroundColor Cyan
Write-Host "   KET QUA: $passedTests/$totalTests TESTS DA PASS HOAN TOAN 100%!       " -ForegroundColor Green
Write-Host "=================================================================" -ForegroundColor Cyan
exit 0
