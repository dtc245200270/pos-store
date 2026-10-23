# Script khoi dong he thong giam sat Prometheus & Grafana cho POS Store
# Cong dich vu:
# - Prometheus: 127.0.0.1:9090
# - Grafana: 127.0.0.1:3030
# - Metrics Node.js: 127.0.0.1:9101/metrics

$ErrorActionPreference = 'Stop'

$promDir = 'C:\prometheus'
$promExe = Join-Path $promDir 'prometheus.exe'
$promtoolExe = Join-Path $promDir 'promtool.exe'
$promConfig = Join-Path $promDir 'prometheus.yml'
$promData = Join-Path $promDir 'data'

$grafanaDir = 'C:\grafana'
$grafanaExe1 = Join-Path $grafanaDir 'bin\grafana.exe'
$grafanaExe2 = Join-Path $grafanaDir 'bin\grafana-server.exe'
$grafanaConfig = Join-Path $grafanaDir 'conf\custom.ini'

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

function Get-FileSha256 {
    param([string]$filePath)
    if (Test-Path -LiteralPath $filePath) {
        return (Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash
    }
    return ''
}

function Test-PrometheusReady {
    param([int]$TimeoutSec = 10)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
        try {
            $resp = Invoke-WebRequest -Uri 'http://127.0.0.1:9090/-/ready' -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            if ($resp.StatusCode -eq 200) {
                return $true
            }
        } catch {}
        Start-Sleep -Milliseconds 600
    }
    return $false
}

function Test-GrafanaHealth {
    param([int]$TimeoutSec = 15)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
        try {
            $resp = Invoke-WebRequest -Uri 'http://127.0.0.1:3030/api/health' -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            if ($resp.StatusCode -eq 200 -and $resp.Content) {
                $json = $resp.Content | ConvertFrom-Json
                if ($json.database -and ($json.database -ieq 'ok')) {
                    return $json
                }
            }
        } catch {}
        Start-Sleep -Milliseconds 600
    }
    return $null
}

function Parse-PrometheusYaml {
    param([string]$yamlText)

    $result = @{
        IsValid = $true
        Error = $null
        GlobalScrapeInterval = '1m'
        GlobalScrapeTimeout = '10s'
        ScrapeConfigs = @{}
    }

    if ([string]::IsNullOrWhiteSpace($yamlText)) {
        $result.IsValid = $false
        $result.Error = "Noi dung YAML rong hoac null."
        return $result
    }

    # Doc khoi global:
    if ($yamlText -match '(?ms)global:[ \t]*\r?\n(.*?)(?=\r?\n[a-zA-Z0-9_-]+:|\Z)') {
        $globalBlock = $matches[1]
        if ($globalBlock -match '(?m)^[ \t]*scrape_interval:[ \t]*[''"]?([^''"\r\n\t #]+)') {
            $result.GlobalScrapeInterval = $matches[1].Trim()
        }
        if ($globalBlock -match '(?m)^[ \t]*scrape_timeout:[ \t]*[''"]?([^''"\r\n\t #]+)') {
            $result.GlobalScrapeTimeout = $matches[1].Trim()
        }
    }

    # Tach cac job qua "- job_name:"
    $jobChunks = $yamlText -split '(?m)^[ \t]*-[ \t]+job_name:[ \t]*'
    for ($i = 1; $i -lt $jobChunks.Count; $i++) {
        $chunk = $jobChunks[$i]
        $lines = $chunk -split '\r?\n'

        $rawJobName = ($lines[0] -split '#')[0].Trim().Trim('"').Trim("'")
        if ([string]::IsNullOrWhiteSpace($rawJobName)) { continue }

        $jobData = @{
            JobName = $rawJobName
            Targets = @()
            Labels = @{}
            MetricsPath = '/metrics'
            ScrapeInterval = $result.GlobalScrapeInterval
            ScrapeTimeout = $result.GlobalScrapeTimeout
        }

        # Kiem tra scrape_interval rieng cua job
        if ($chunk -match '(?m)^[ \t]*scrape_interval:[ \t]*[''"]?([^''"\r\n\t #]+)') {
            $jobData.ScrapeInterval = $matches[1].Trim()
        }

        # Kiem tra scrape_timeout rieng cua job
        if ($chunk -match '(?m)^[ \t]*scrape_timeout:[ \t]*[''"]?([^''"\r\n\t #]+)') {
            $jobData.ScrapeTimeout = $matches[1].Trim()
        }

        # Kiem tra metrics_path
        if ($chunk -match '(?m)^[ \t]*metrics_path:[ \t]*[''"]?([^''"\r\n\t #]+)') {
            $jobData.MetricsPath = $matches[1].Trim()
        }

        # Targets dang inline: targets: ['127.0.0.1:9101', ...]
        $inlineTargetMatches = [regex]::Matches($chunk, '(?m)targets:[ \t]*\[([^\]]+)\]')
        foreach ($m in $inlineTargetMatches) {
            $items = $m.Groups[1].Value -split ','
            foreach ($it in $items) {
                $clean = $it.Trim().Trim('"').Trim("'")
                if ($clean) { $jobData.Targets += $clean }
            }
        }

        # Targets dang list:
        $listTargetMatches = [regex]::Matches($chunk, '(?ms)targets:[ \t]*\r?\n([ \t]*-[ \t]+[^\r\n]+(?:\r?\n[ \t]*-[ \t]+[^\r\n]+)*)')
        foreach ($m in $listTargetMatches) {
            $targetLines = $m.Groups[1].Value -split '\r?\n'
            foreach ($tl in $targetLines) {
                if ($tl -match '^[ \t]*-[ \t]+[''"]?([^''"\r\n\t #]+)') {
                    $clean = $matches[1].Trim()
                    if ($clean) { $jobData.Targets += $clean }
                }
            }
        }

        $jobData.Targets = @($jobData.Targets | Select-Object -Unique)

        # Labels block
        $labelsMatches = [regex]::Matches($chunk, '(?ms)labels:[ \t]*\r?\n([ \t]+[a-zA-Z0-9_-]+:[ \t]*[^\r\n]+(?:\r?\n[ \t]+[a-zA-Z0-9_-]+:[ \t]*[^\r\n]+)*)')
        foreach ($m in $labelsMatches) {
            $labelLines = $m.Groups[1].Value -split '\r?\n'
            foreach ($ll in $labelLines) {
                if ($ll -match '^[ \t]+([a-zA-Z0-9_-]+):[ \t]*[''"]?([^''"\r\n#]*)') {
                    $key = $matches[1].Trim()
                    $val = $matches[2].Trim()
                    $jobData.Labels[$key] = $val
                }
            }
        }

        $result.ScrapeConfigs[$rawJobName] = $jobData
    }

    if ($result.ScrapeConfigs.Count -eq 0) {
        $result.IsValid = $false
        $result.Error = "Khong phan tich duoc job nao trong scrape_configs."
    }

    return $result
}

function Compare-PrometheusDesiredVsRuntime {
    param(
        [string]$DesiredYaml,
        [string]$RuntimeYaml
    )

    $desired = Parse-PrometheusYaml $DesiredYaml
    $runtime = Parse-PrometheusYaml $RuntimeYaml

    $diffs = @()

    if (-not $desired.IsValid) {
        $diffs += "Cau hinh desired khong hop le hoac khong the phan tich: $($desired.Error)"
        return @{ IsMatch = $false; Differences = $diffs }
    }
    if (-not $runtime.IsValid) {
        $diffs += "Cau hinh runtime API tra ve khong hop le hoac rong: $($runtime.Error)"
        return @{ IsMatch = $false; Differences = $diffs }
    }

    foreach ($jobName in $desired.ScrapeConfigs.Keys) {
        if (-not $runtime.ScrapeConfigs.ContainsKey($jobName)) {
            $diffs += "Job '$jobName' thieu trong runtime scrape_configs."
            continue
        }

        $desJob = $desired.ScrapeConfigs[$jobName]
        $runJob = $runtime.ScrapeConfigs[$jobName]

        # So sanh scrape_interval hieu luc (co xet ke thua tu global/default)
        if ($desJob.ScrapeInterval -ne $runJob.ScrapeInterval) {
            $diffs += "Job '$jobName' scrape_interval khac nhau (Desired: '$($desJob.ScrapeInterval)', Runtime: '$($runJob.ScrapeInterval)')."
        }

        # So sanh scrape_timeout hieu luc (co xet ke thua tu global/default)
        if ($desJob.ScrapeTimeout -ne $runJob.ScrapeTimeout) {
            $diffs += "Job '$jobName' scrape_timeout khac nhau (Desired: '$($desJob.ScrapeTimeout)', Runtime: '$($runJob.ScrapeTimeout)')."
        }

        if ($desJob.MetricsPath -ne $runJob.MetricsPath) {
            $diffs += "Job '$jobName' metrics_path khac nhau (Desired: $($desJob.MetricsPath), Runtime: $($runJob.MetricsPath))."
        }

        foreach ($tgt in $desJob.Targets) {
            if ($runJob.Targets -notcontains $tgt) {
                $diffs += "Job '$jobName' target '$tgt' khong co trong runtime targets ($($runJob.Targets -join ', '))."
            }
        }
        foreach ($runTgt in $runJob.Targets) {
            if ($desJob.Targets -notcontains $runTgt) {
                $diffs += "Job '$jobName' target '$runTgt' co trong runtime nhung da bi loai bo khoi desired."
            }
        }

        foreach ($lblKey in $desJob.Labels.Keys) {
            $expectedVal = $desJob.Labels[$lblKey]
            if (-not $runJob.Labels.ContainsKey($lblKey)) {
                $diffs += "Job '$jobName' nhan '$lblKey' thieu trong runtime labels."
            } elseif ($runJob.Labels[$lblKey] -ne $expectedVal) {
                $diffs += "Job '$jobName' nhan '$lblKey' khac nhau (Desired: '$expectedVal', Runtime: '$($runJob.Labels[$lblKey])')."
            }
        }
        foreach ($runLblKey in $runJob.Labels.Keys) {
            if (-not $desJob.Labels.ContainsKey($runLblKey)) {
                $diffs += "Job '$jobName' nhan '$runLblKey' co trong runtime nhung da bi loai bo khoi desired."
            }
        }
    }

    foreach ($runJobName in $runtime.ScrapeConfigs.Keys) {
        if (-not $desired.ScrapeConfigs.ContainsKey($runJobName)) {
            $diffs += "Job '$runJobName' co trong runtime nhung da bi loai bo khoi desired."
        }
    }

    return @{
        IsMatch = ($diffs.Count -eq 0)
        Differences = $diffs
    }
}

Write-Host '==========================================================' -ForegroundColor Cyan
Write-Host '   KHOI DONG HE THONG GIAM SAT PROMETHEUS & GRAFANA        ' -ForegroundColor Green
Write-Host '==========================================================' -ForegroundColor Cyan

# 1. Kiem tra su ton tai cua cac file thuc thi
if (-not (Test-Path -LiteralPath $promExe)) {
    Write-Error "[LOI] Khong tim thay Prometheus tai '$promExe'."
    exit 1
}
if (-not (Test-Path -LiteralPath $promtoolExe)) {
    Write-Error "[LOI] Khong tim thay promtool tai '$promtoolExe'."
    exit 1
}
$grafanaExeFound = if (Test-Path -LiteralPath $grafanaExe1) { $grafanaExe1 } elseif (Test-Path -LiteralPath $grafanaExe2) { $grafanaExe2 } else { $null }
if (-not $grafanaExeFound) {
    Write-Error "[LOI] Khong tim thay Grafana tai '$grafanaDir\bin'."
    exit 1
}

# 2. Kiem tra cu phap cau hinh ung vien bang promtool truoc khi thay the file disk
$repoMonitoringDir = $PSScriptRoot
$repoPromCfg = Join-Path $repoMonitoringDir 'prometheus.yml'

if (-not (Test-Path -LiteralPath $repoPromCfg)) {
    Write-Error "[LOI] Khong tim thay file cau hinh goc tai '$repoPromCfg'."
    exit 1
}

Write-Host '-> Kiem tra cu phap file cau hinh ung vien bang promtool...' -ForegroundColor Cyan
$candCheck = & $promtoolExe check config $repoPromCfg 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Error "[LOI CAU HINH CANDIDATE] File '$repoPromCfg' khong hop le theo promtool:`n$candCheck`n=> HUY THAO TAC: Tuyet doi khong thay the file cau hinh tren disk!"
    exit 1
}
Write-Host '[OK] File cau hinh ung vien hop le theo promtool.' -ForegroundColor Green

# 3. Dong bo cac file provisioning va Grafana config
$grafanaConfigChanged = $false
try {
    $repoGrafCfg = Join-Path $repoMonitoringDir 'grafana\custom.ini'
    if (Test-Path -LiteralPath $repoGrafCfg) {
        $oldHash = Get-FileSha256 $grafanaConfig
        $newHash = Get-FileSha256 $repoGrafCfg
        if ($oldHash -and $newHash -and ($oldHash -ne $newHash)) {
            $grafanaConfigChanged = $true
        }
        Copy-Item -LiteralPath $repoGrafCfg -Destination $grafanaConfig -Force
    }

    $repoDsCfg = Join-Path $repoMonitoringDir 'grafana\provisioning\datasources\prometheus.yaml'
    if (Test-Path -LiteralPath $repoDsCfg) {
        New-Item -ItemType Directory -Path (Join-Path $grafanaDir 'conf\provisioning\datasources') -Force | Out-Null
        Copy-Item -LiteralPath $repoDsCfg -Destination (Join-Path $grafanaDir 'conf\provisioning\datasources\prometheus.yaml') -Force
    }

    $repoDbProvider = Join-Path $repoMonitoringDir 'grafana\provisioning\dashboards\dashboards.yaml'
    if (Test-Path -LiteralPath $repoDbProvider) {
        New-Item -ItemType Directory -Path (Join-Path $grafanaDir 'conf\provisioning\dashboards') -Force | Out-Null
        Copy-Item -LiteralPath $repoDbProvider -Destination (Join-Path $grafanaDir 'conf\provisioning\dashboards\dashboards.yaml') -Force
    }

    $repoDashboardJson = Join-Path $repoMonitoringDir 'grafana\dashboards\pos-store-dashboard.json'
    if (Test-Path -LiteralPath $repoDashboardJson) {
        Copy-Item -LiteralPath $repoDashboardJson -Destination (Join-Path $grafanaDir 'conf\provisioning\dashboards\pos-store-dashboard.json') -Force
    }
} catch {
    Write-Error "[LOI SAO CHEP CAU HINH] Khong the sao chep cac file provisioning Grafana: $($_.Exception.Message)"
    exit 1
}

# 4. Kiem tra va khoi dong / reload Prometheus (127.0.0.1:9090)
$promConn = Get-NetTCPConnection -LocalPort 9090 -State Listen -ErrorAction SilentlyContinue
$desiredYaml = Get-Content -LiteralPath $repoPromCfg -Raw

if ($promConn) {
    $procId = ($promConn | Select-Object -ExpandProperty OwningProcess -Unique)[0]
    $procInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $procId" -ErrorAction SilentlyContinue
    $normExec = Normalize-PathStr $procInfo.ExecutablePath
    $expectedNormProm = Normalize-PathStr $promExe

    if ($normExec -and ($normExec -ieq $expectedNormProm)) {
        # Kiem tra readiness co timeout o nhanh dang chay san
        Write-Host "-> Kiem tra HTTP readiness cua Prometheus dang chay san (PID: $procId)..." -ForegroundColor Cyan
        $ready = Test-PrometheusReady -TimeoutSec 10
        if (-not $ready) {
            Write-Error "[LOI PROMETHEUS] Prometheus dang giu cong 9090 (PID: $procId) nhung khong phan hoi HTTP 200 tai /-/ready sau 10 giay!"
            exit 1
        }
        Write-Host "[OK] Prometheus dang chay va san sang tai cong 9090 (PID: $procId, Readiness: HTTP 200)." -ForegroundColor Green

        # Lay cau hinh runtime thuc te de so sanh co cau truc (khong chi dua vao hash disk)
        $runtimeYaml = ''
        try {
            $statusResp = Invoke-WebRequest -Uri 'http://127.0.0.1:9090/api/v1/status/config' -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
            $cfgJson = $statusResp.Content | ConvertFrom-Json
            $runtimeYaml = $cfgJson.data.yaml
        } catch {
            Write-Error "[LOI RUNTIME CONFIG] Khong the lay cau hinh runtime tu /api/v1/status/config: $($_.Exception.Message)"
            exit 1
        }

        if ([string]::IsNullOrWhiteSpace($runtimeYaml)) {
            Write-Error "[LOI RUNTIME CONFIG] Runtime API /api/v1/status/config tra ve cau hinh YAML rong!"
            exit 1
        }

        $cmpResult = Compare-PrometheusDesiredVsRuntime -DesiredYaml $desiredYaml -RuntimeYaml $runtimeYaml
        $diskHashDiff = ((Get-FileSha256 $promConfig) -ne (Get-FileSha256 $repoPromCfg))

        if (-not $cmpResult.IsMatch -or $diskHashDiff) {
            Write-Host '-> Phat hien cau hinh runtime chua dong nhat hoac file disk can cap nhat:' -ForegroundColor Cyan
            if ($cmpResult.Differences.Count -gt 0) {
                $cmpResult.Differences | ForEach-Object { Write-Host "   * $_" -ForegroundColor Yellow }
            }

            # Sao luu file disk hop le truoc khi ghi de
            $promBackup = Join-Path $promDir 'prometheus.yml.bak'
            if (Test-Path -LiteralPath $promConfig) {
                Copy-Item -LiteralPath $promConfig -Destination $promBackup -Force
            }

            # Helper thuc hien rollback an toan khi gap loi o bat ky buoc nao
            $PerformRollback = {
                param([string]$TriggerReason)
                $rollbackFailed = $false
                $rollbackError = ''
                $verifiedRestored = $false

                if (Test-Path -LiteralPath $promBackup) {
                    try {
                        Copy-Item -LiteralPath $promBackup -Destination $promConfig -Force -ErrorAction Stop
                        $diskRestoredHash = Get-FileSha256 $promConfig
                        $backupHash = Get-FileSha256 $promBackup
                        if ($diskRestoredHash -and $backupHash -and ($diskRestoredHash -eq $backupHash)) {
                            $verifiedRestored = $true
                            # Thu reload ve cau hinh cu da khoi phuc
                            try {
                                Invoke-WebRequest -Uri 'http://127.0.0.1:9090/-/reload' -Method Post -UseBasicParsing -TimeoutSec 5 -ErrorAction SilentlyContinue | Out-Null
                            } catch {}
                        } else {
                            $rollbackFailed = $true
                            $rollbackError = "Xac nhan file disk sau khi khoi phuc khong khop hash voi file backup!"
                        }
                    } catch {
                        $rollbackFailed = $true
                        $rollbackError = $_.Exception.Message
                    }
                } else {
                    $rollbackFailed = $true
                    $rollbackError = "Khong tim thay file backup '$promBackup' de khoi phuc!"
                }

                if ($rollbackFailed) {
                    Write-Host "[LOI BAN DAU] $TriggerReason" -ForegroundColor Red
                    Write-Host "[LOI ROLLBACK] Rollback that bai: $rollbackError" -ForegroundColor Red
                    Write-Error "[THAT BAI NGHIEP TRONG] Gap loi khi reload va khong the khoi phuc file hop le cu:`nLoi ban dau: $TriggerReason`nLoi rollback: $rollbackError"
                } else {
                    Write-Host "-> Da xac nhan khoi phuc thanh cong file prometheus.yml hop le cu tren disk." -ForegroundColor Yellow
                    Write-Error "[THAT BAI] $TriggerReason`n=> Da khoi phuc an toan file cau hinh hop le tren disk."
                }
                exit 1
            }

            # Toan bo thao tac thay disk, POST reload va xac nhan runtime nam trong try/catch
            try {
                # 1. Ghi file cau hinh ung vien da qua promtool vao disk
                Copy-Item -LiteralPath $repoPromCfg -Destination $promConfig -Force -ErrorAction Stop

                # 2. Goi endpoint /-/reload de ap dung vao runtime
                Write-Host '-> Dang goi endpoint /-/reload de ap dung cau hinh vao runtime...' -ForegroundColor Cyan
                $reloadUri = if ($env:TEST_MOCK_PROM_RELOAD_URI) { $env:TEST_MOCK_PROM_RELOAD_URI } else { 'http://127.0.0.1:9090/-/reload' }
                $reloadResp = Invoke-WebRequest -Uri $reloadUri -Method Post -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
                if ($reloadResp.StatusCode -ne 200) {
                    throw "Endpoint /-/reload tra ve ma HTTP $($reloadResp.StatusCode) (khac 200)."
                }

                # 3. Doi chieu co cau truc cau hinh runtime sau reload qua /api/v1/status/config
                Write-Host '-> Doi chieu co cau truc cau hinh runtime sau reload qua /api/v1/status/config...' -ForegroundColor Cyan
                Start-Sleep -Seconds 1
                $statusUri = if ($env:TEST_MOCK_PROM_STATUS_CONFIG_URI) { $env:TEST_MOCK_PROM_STATUS_CONFIG_URI } else { 'http://127.0.0.1:9090/api/v1/status/config' }
                $statusRespAfter = Invoke-WebRequest -Uri $statusUri -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
                if ($statusRespAfter.StatusCode -ne 200) {
                    throw "Truy van /api/v1/status/config tra ve ma HTTP $($statusRespAfter.StatusCode) (khac 200)."
                }

                $cfgJsonAfter = $statusRespAfter.Content | ConvertFrom-Json
                $runtimeYamlAfter = $cfgJsonAfter.data.yaml
                if ([string]::IsNullOrWhiteSpace($runtimeYamlAfter)) {
                    throw "Runtime API tra ve YAML rong hoac khong co data.yaml!"
                }

                $cmpAfter = Compare-PrometheusDesiredVsRuntime -DesiredYaml $desiredYaml -RuntimeYaml $runtimeYamlAfter
                if (-not $cmpAfter.IsMatch) {
                    throw "Runtime Prometheus khong phan anh dung cau hinh mong muon:`n$($cmpAfter.Differences -join "`n")"
                }

                Write-Host '[THANH CONG] Da nap lai cau hinh moi va doi chieu co cau truc khop 100% voi runtime!' -ForegroundColor Green
            } catch {
                # TUYET DOI KHONG goi Write-Error truoc khi rollback!
                $exMsg = $_.Exception.Message
                & $PerformRollback -TriggerReason $exMsg
            }
        } else {
            Write-Host '[OK] Runtime Prometheus da khop hoan toan voi cau hinh mong muon. Khong can reload.' -ForegroundColor Green
        }
    } else {
        Write-Error "[XUNG DOT CONG] Cong 9090 dang bi chiem boi chuong trinh khac (PID: $procId, Path: $($procInfo.ExecutablePath)). Khong the khoi dong Prometheus!"
        exit 1
    }
} else {
    # Nhanh khoi dong moi: sao chep file ung vien da kiem tra sang disk
    Copy-Item -LiteralPath $repoPromCfg -Destination $promConfig -Force

    Write-Host '-> Dang khoi dong Prometheus Server (127.0.0.1:9090)...' -ForegroundColor Cyan
    $promCmd = ('cmd.exe /c "cd /d "' + $promDir + '" && prometheus.exe --config.file="' + $promConfig + '" --web.listen-address=127.0.0.1:9090 --storage.tsdb.path="' + $promData + '" --storage.tsdb.retention.time=7d --web.enable-lifecycle"')
    try {
        $resProm = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
            CommandLine = $promCmd
            CurrentDirectory = $promDir
        }
        if ($resProm.ReturnValue -ne 0) {
            Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', $promCmd) -WindowStyle Hidden
        }
    } catch {
        Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', $promCmd) -WindowStyle Hidden
    }

    # Xac nhan HTTP readiness co timeout o nhanh khoi dong moi
    $promReady = Test-PrometheusReady -TimeoutSec 10
    if ($promReady) {
        $promConnCheck = Get-NetTCPConnection -LocalPort 9090 -State Listen -ErrorAction SilentlyContinue
        $pIdNew = if ($promConnCheck) { ($promConnCheck | Select-Object -ExpandProperty OwningProcess -Unique)[0] } else { 'Unknown' }
        Write-Host "[THANH CONG] Prometheus da san sang (HTTP 200 Ready) tai http://127.0.0.1:9090 (PID: $pIdNew)." -ForegroundColor Green

        # Xac nhan runtime khop voi mong muon
        try {
            $statusRespNew = Invoke-WebRequest -Uri 'http://127.0.0.1:9090/api/v1/status/config' -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
            $cfgJsonNew = $statusRespNew.Content | ConvertFrom-Json
            $cmpNew = Compare-PrometheusDesiredVsRuntime -DesiredYaml $desiredYaml -RuntimeYaml $cfgJsonNew.data.yaml
            if (-not $cmpNew.IsMatch) {
                Write-Error "[LOI XAC NHAN RUNTIME] Prometheus khoi dong moi nhung runtime khong khop voi cau hinh mong muon!`n$($cmpNew.Differences -join "`n")"
                exit 1
            }
            Write-Host '[OK] Runtime Prometheus khoi dong moi khop 100% voi cau hinh mong muon.' -ForegroundColor Green
        } catch {
            Write-Error "[LOI XAC NHAN RUNTIME] Khong the truy van /api/v1/status/config sau khi khoi dong moi: $($_.Exception.Message)"
            exit 1
        }
    } else {
        Write-Error "[LOI KHOI DONG] Prometheus khong phan hoi HTTP readiness tai http://127.0.0.1:9090/-/ready sau 10 giay."
        exit 1
    }
}

# 5. Kiem tra va khoi dong Grafana (127.0.0.1:3030)
$grafanaConn = Get-NetTCPConnection -LocalPort 3030 -State Listen -ErrorAction SilentlyContinue
if ($grafanaConn) {
    $procId = ($grafanaConn | Select-Object -ExpandProperty OwningProcess -Unique)[0]
    $procInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $procId" -ErrorAction SilentlyContinue
    $normExec = Normalize-PathStr $procInfo.ExecutablePath
    $expectedNormGraf1 = Normalize-PathStr $grafanaExe1
    $expectedNormGraf2 = Normalize-PathStr $grafanaExe2

    if ($normExec -and (($normExec -ieq $expectedNormGraf1) -or ($normExec -ieq $expectedNormGraf2))) {
        Write-Host "-> Kiem tra /api/health cua Grafana dang chay san (PID: $procId)..." -ForegroundColor Cyan
        $health = Test-GrafanaHealth -TimeoutSec 10
        if ($health) {
            Write-Host "[OK] Grafana dang chay tai cong 3030 (PID: $procId, Exe: $($procInfo.ExecutablePath), Health: HTTP 200, DB: ok, Version: $($health.version))." -ForegroundColor Green
            if ($grafanaConfigChanged) {
                Write-Warning "[CAP NHAT CAU HINH] File custom.ini da duoc cap nhat moi. Can restart Grafana de ap dung."
            }
        } else {
            Write-Error "[LOI GRAFANA HEALTH] Grafana dang giu cong 3030 (PID: $procId, Exe: $($procInfo.ExecutablePath)) nhung khong phan hoi /api/health hop le (HTTP 200 va database = ok) sau 10 giay!"
            exit 1
        }
    } else {
        Write-Error "[XUNG DOT CONG] Cong 3030 dang bi chiem boi chuong trinh khac (PID: $procId, Path: $($procInfo.ExecutablePath)). Khong the khoi dong Grafana!"
        exit 1
    }
} else {
    $grafanaExeFileName = [System.IO.Path]::GetFileName($grafanaExeFound)
    Write-Host "-> Dang khoi dong Grafana tu '$grafanaExeFound' (Thu muc lam viec: '$grafanaDir')..." -ForegroundColor Cyan

    $cmdBody = if ($grafanaExeFileName -ieq 'grafana.exe') {
        ('cd /d "' + $grafanaDir + '" && "' + $grafanaExeFound + '" server --config="' + $grafanaConfig + '"')
    } else {
        ('cd /d "' + $grafanaDir + '" && "' + $grafanaExeFound + '" --config="' + $grafanaConfig + '"')
    }

    $grafCmd = ('cmd.exe /c "' + $cmdBody + '"')
    try {
        $resGraf = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
            CommandLine = $grafCmd
            CurrentDirectory = $grafanaDir
        }
        if ($resGraf.ReturnValue -ne 0) {
            Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', $cmdBody) -WindowStyle Hidden
        }
    } catch {
        Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', $cmdBody) -WindowStyle Hidden
    }

    $health = Test-GrafanaHealth -TimeoutSec 15
    if ($health) {
        $grafConnCheck = Get-NetTCPConnection -LocalPort 3030 -State Listen -ErrorAction SilentlyContinue
        $gIdNew = if ($grafConnCheck) { ($grafConnCheck | Select-Object -ExpandProperty OwningProcess -Unique)[0] } else { 'Unknown' }
        Write-Host "[THANH CONG] Grafana da san sang (HTTP 200 Health, DB: ok, Version: $($health.version)) tai http://127.0.0.1:3030 (PID: $gIdNew, Exe: $grafanaExeFound)." -ForegroundColor Green
    } else {
        Write-Error "[LOI KHOI DONG] Grafana khong phan hoi /api/health hop le (HTTP 200 va database = ok) tai http://127.0.0.1:3030/api/health sau 15 giay."
        exit 1
    }
}

Write-Host "`n[THANH CONG] Ha tang giam sat (Prometheus & Grafana) da khoi dong va san sang." -ForegroundColor Green

# 6. Phan biet: Kiem tra trang thai giam sat ung dung POS Store
Write-Host "`n----------------------------------------------------------" -ForegroundColor DarkGray
Write-Host "KIEM TRA TRANG THAI GIAM SAT UNG DUNG POS STORE:" -ForegroundColor Cyan

$posMetricsOk = $false
$posTargetUp = $false
$posTargetLastError = ''

# A. Kiem tra HTTP metrics endpoint Node.js (127.0.0.1:9101/metrics)
$metricsConn = Get-NetTCPConnection -LocalPort 9101 -State Listen -ErrorAction SilentlyContinue
if ($metricsConn) {
    $procId = ($metricsConn | Select-Object -ExpandProperty OwningProcess -Unique)[0]
    $procInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $procId" -ErrorAction SilentlyContinue
    
    if ($procInfo.Name -match 'node') {
        try {
            $mResp = Invoke-WebRequest -Uri 'http://127.0.0.1:9101/metrics' -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
            if ($mResp.StatusCode -eq 200 -and ($mResp.Content -match '# HELP' -or $mResp.Content -match 'http_requests_total')) {
                $posMetricsOk = $true
                Write-Host " - Metrics Node.js (127.0.0.1:9101/metrics): SAN SANG (HTTP 200 Prometheus format, PID: $procId)." -ForegroundColor Green
            } else {
                Write-Warning " - [CANH BAO METRICS] Cong 9101 mo nhung khong tra dung dinh dang Prometheus metrics (HTTP $($mResp.StatusCode))."
            }
        } catch {
            Write-Warning " - [CANH BAO METRICS] Cong 9101 mo nhung HTTP GET /metrics tra ve loi: $($_.Exception.Message)"
        }
    } else {
        Write-Warning " - [XUNG DOT CONG] Cong 9101 dang duoc su dung boi chuong trinh khong phai Node.js (PID: $procId, Ten: $($procInfo.Name))."
    }
} else {
    Write-Warning " - [LUU Y] Tien trinh POS Store chua mo cong metrics 9101. Vui long chay 'npm start' cho POS Store."
}

# B. Kiem tra target pos_store qua Prometheus API /api/v1/targets (cho toi da 16 giay neu dang khoi tao hoac trang thai unknown)
$swTarget = [System.Diagnostics.Stopwatch]::StartNew()
while ($swTarget.Elapsed.TotalSeconds -lt 16) {
    try {
        $tResp = Invoke-WebRequest -Uri 'http://127.0.0.1:9090/api/v1/targets' -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
        $tData = $tResp.Content | ConvertFrom-Json
        $posT = $tData.data.activeTargets | Where-Object { $_.labels.job -eq 'pos_store' -or $_.scrapePool -eq 'pos_store' }
        if ($posT) {
            if ($posT.health -ieq 'up') {
                $posTargetUp = $true
                Write-Host " - Target 'pos_store' tren Prometheus: UP (Scrape URL: $($posT.scrapeUrl), LastScrape: $($posT.lastScrape))." -ForegroundColor Green
                break
            } elseif ($posT.health -ieq 'unknown') {
                # Neu vua reload hoac moi bat, cho lan scrape dau tien hoan tat
                Start-Sleep -Seconds 2
                continue
            } else {
                $posTargetLastError = $posT.lastError
                Write-Warning " - [TARGET DOWN] Target 'pos_store' tren Prometheus hien dang DOWN! (LastError: '$($posT.lastError)')."
                break
            }
        } else {
            # Prometheus vua bat, scrape manager dang nap danh sach target
            Start-Sleep -Seconds 2
            continue
        }
    } catch {
        Start-Sleep -Seconds 2
        continue
    }
}

if (-not $posTargetUp -and -not $posTargetLastError) {
    Write-Warning " - [TARGET MISSING] Target 'pos_store' khong tim thay trong Prometheus activeTargets sau 16 giay."
}

# C. Ket luan ro rang ve trang thai giam sat POS Store
if ($posMetricsOk -and $posTargetUp) {
    Write-Host "[HOAN TAT] Giam sat POS Store da san sang 100%!" -ForegroundColor Green
} else {
    Write-Warning "[CHU Y - GIAM SAT CHUA HOAN TAT] Ha tang Prometheus/Grafana da hoat dong, nhung viec thu thap chi so POS Store chua san sang day du."
}

Write-Host '----------------------------------------------------------' -ForegroundColor DarkGray
Write-Host 'HUONG DAN TRUY CAP:' -ForegroundColor Cyan
Write-Host '1. Grafana Dashboard : http://127.0.0.1:3030/d/pos-store-monitoring-dashboard' -ForegroundColor White
Write-Host '   (Tai khoan mac dinh: admin / admin - Doi mat khau sau khi vao)' -ForegroundColor DarkYellow
Write-Host '2. Prometheus Web UI : http://127.0.0.1:9090' -ForegroundColor White
Write-Host '3. Prometheus Targets: http://127.0.0.1:9090/targets' -ForegroundColor White
Write-Host '4. Node.js Metrics   : http://127.0.0.1:9101/metrics' -ForegroundColor White
Write-Host '----------------------------------------------------------' -ForegroundColor DarkGray
