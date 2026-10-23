# Kich ban kiem thu doc lap cho logic xac minh tien trinh truoc khi dung
# Su dung du lieu gia dinh (mock), TUYET DOI khong dung tien trinh thuc te cua he thong

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

function Test-ProcessVerification {
    param(
        [string]$ExecPath,
        [string]$CmdLine,
        [string[]]$AllowedPaths,
        [string]$RequiredCmdKeyword
    )

    $normExec = Normalize-PathStr $ExecPath
    $pathMatched = $false
    foreach ($allowed in $AllowedPaths) {
        $normAllowed = Normalize-PathStr $allowed
        if ($normExec -and ($normExec -ieq $normAllowed)) {
            $pathMatched = $true
            break
        }
    }

    $cmdMatched = ($cmdLine -and ($cmdLine.IndexOf($RequiredCmdKeyword, [System.StringComparison]::OrdinalIgnoreCase) -ge 0))

    return ($pathMatched -and $cmdMatched)
}

Write-Host '==========================================================' -ForegroundColor Cyan
Write-Host ' KIEM THU DOC LAP LOGIC XAC MINH TIEN TRINH (DU LIEU GIA) ' -ForegroundColor Green
Write-Host '==========================================================' -ForegroundColor Cyan

$testCases = @(
    @{
        Name = '1. Prometheus hop le chinh xac duong dan va lenh'
        ExecPath = 'C:\prometheus\prometheus.exe'
        CmdLine = 'prometheus.exe --config.file=prometheus.yml --web.listen-address=127.0.0.1:9090'
        AllowedPaths = @($expectedPromPath)
        Keyword = 'prometheus'
        Expected = $true
    },
    @{
        Name = '2. Ung dung la chiem cong 9090 (Tu choi dung)'
        ExecPath = 'C:\Program Files\SomeApp\other.exe'
        CmdLine = 'other.exe -port 9090'
        AllowedPaths = @($expectedPromPath)
        Keyword = 'prometheus'
        Expected = $false
    },
    @{
        Name = '3. Ten file giong nhung sai thu muc cai dat (Tu choi dung)'
        ExecPath = 'C:\Users\Downloads\prometheus.exe'
        CmdLine = 'prometheus.exe --config.file=test.yml'
        AllowedPaths = @($expectedPromPath)
        Keyword = 'prometheus'
        Expected = $false
    },
    @{
        Name = '4. Grafana hop le voi grafana.exe'
        ExecPath = 'C:\grafana\bin\grafana.exe'
        CmdLine = 'grafana.exe server --config=custom.ini'
        AllowedPaths = @($expectedGrafanaPath1, $expectedGrafanaPath2)
        Keyword = 'grafana'
        Expected = $true
    },
    @{
        Name = '5. Grafana hop le voi grafana-server.exe'
        ExecPath = 'C:\grafana\bin\grafana-server.exe'
        CmdLine = 'bin\grafana-server.exe --config=conf\custom.ini'
        AllowedPaths = @($expectedGrafanaPath1, $expectedGrafanaPath2)
        Keyword = 'grafana'
        Expected = $true
    },
    @{
        Name = '6. Node.js hoac chuong trinh khac chiem cong 3030 (Tu choi dung)'
        ExecPath = 'C:\Program Files\nodejs\node.exe'
        CmdLine = 'node some-app.js --port 3030'
        AllowedPaths = @($expectedGrafanaPath1, $expectedGrafanaPath2)
        Keyword = 'grafana'
        Expected = $false
    }
)

$passed = 0
foreach ($tc in $testCases) {
    $res = Test-ProcessVerification -ExecPath $tc.ExecPath -CmdLine $tc.CmdLine -AllowedPaths $tc.AllowedPaths -RequiredCmdKeyword $tc.Keyword
    if ($res -eq $tc.Expected) {
        Write-Host ("[DAT] " + $tc.Name + " -> Ket qua: " + $res + " (Dung ky vong)") -ForegroundColor Green
        $passed++
    } else {
        Write-Host ("[THAT BAI] " + $tc.Name + " -> Nhan: " + $res + ", Ky vong: " + $tc.Expected) -ForegroundColor Red
    }
}

Write-Host '----------------------------------------------------------' -ForegroundColor DarkGray
Write-Host ("Ket qua: $passed / " + $testCases.Count + " bai kiem tra logic dat chuan.") -ForegroundColor Cyan
if ($passed -ne $testCases.Count) {
    exit 1
}
