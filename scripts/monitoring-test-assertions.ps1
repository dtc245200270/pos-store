# Thu vien Assertion chung cho cac bai test he thong giam sat POS Store
# File nay duoc dot-source boi cac bai test van hanh va test negative assertions.

function Assert-TargetUp {
    param(
        $ActiveTargets,
        [string]$JobName = 'pos_store'
    )
    if (-not $ActiveTargets) {
        throw "ASSERTION_ERROR: Danh sach activeTargets tu Prometheus rong hoac null!"
    }
    $posT = $ActiveTargets | Where-Object { $_.labels.job -eq $JobName -or $_.scrapePool -eq $JobName }
    if (-not $posT) {
        throw "ASSERTION_ERROR: Target '$JobName' khong tim thay trong Prometheus activeTargets!"
    }
    if ($posT.health -ine 'up') {
        throw "ASSERTION_ERROR: Target '$JobName' khong o trang thai UP! Trang thai thuc te: '$($posT.health)', LastError: '$($posT.lastError)'"
    }
    Write-Host "[ASSERTION OK] Target '$JobName' UP (Scrape URL: $($posT.scrapeUrl))." -ForegroundColor Green
    return $posT
}

function Assert-GrafanaHealth {
    param(
        $HealthJson,
        [int]$StatusCode = 200
    )
    if ($StatusCode -ne 200) {
        throw "ASSERTION_ERROR: Grafana /api/health tra ve HTTP $StatusCode (khac 200)!"
    }
    if (-not $HealthJson) {
        throw "ASSERTION_ERROR: Du lieu phan hoi tu Grafana /api/health rong!"
    }
    if ($HealthJson.database -ine 'ok') {
        throw "ASSERTION_ERROR: Grafana database khong phai 'ok'! Gia tri thuc te: '$($HealthJson.database)'"
    }
    Write-Host "[ASSERTION OK] Grafana /api/health HTTP 200 va database = ok (Version: $($HealthJson.version))." -ForegroundColor Green
}

function Assert-PrometheusReady {
    param([int]$StatusCode = 200)
    if ($StatusCode -ne 200) {
        throw "ASSERTION_ERROR: Prometheus /-/ready tra ve HTTP $StatusCode (khac 200)!"
    }
    Write-Host "[ASSERTION OK] Prometheus /-/ready HTTP 200." -ForegroundColor Green
}

function Assert-HistoricalSamples {
    param(
        [int]$SamplesBefore,
        [int]$SamplesAfter,
        [string]$TimeWindowDesc = ""
    )
    if ($SamplesBefore -le 0) {
        throw "ASSERTION_ERROR: Khong co mau lich su nao ($SamplesBefore mau) truoc restart de kiem tra tinh bao toan!"
    }
    if ($SamplesBefore -ne $SamplesAfter) {
        throw "ASSERTION_ERROR: Du lieu lich su Prometheus bi sai lech sau restart! Truoc=$SamplesBefore, Sau=$SamplesAfter $TimeWindowDesc"
    }
    Write-Host "[ASSERTION OK] Du lieu lich su Prometheus trong khoang tuyet doi duoc bao toan 100% ($SamplesBefore == $SamplesAfter)." -ForegroundColor Green
}

function Assert-PortsReleased {
    param([int[]]$Ports)
    foreach ($port in $Ports) {
        $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        if ($conn) {
            throw "ASSERTION_ERROR: Cong $port chua duoc giai phong sau khi stop-monitoring!"
        }
    }
    Write-Host "[ASSERTION OK] Cac cong ($($Ports -join ', ')) da duoc giai phong hoan toan." -ForegroundColor Green
}

function Assert-ServicePidsUnchanged {
    param(
        [hashtable]$PidsBefore,
        [hashtable]$PidsAfter,
        [string]$Context = "Dich vu"
    )
    foreach ($name in $PidsBefore.Keys) {
        $b = $PidsBefore[$name]
        $a = $PidsAfter[$name]
        if (-not $a) {
            throw "ASSERTION_ERROR: $Context '$name' khong con chay sau thao tac!"
        }
        if ($b -ne $a) {
            throw "ASSERTION_ERROR: $Context '$name' bi thay doi PID! Truoc=$b, Sau=$a (Bi restart ngoai y muon hoac tao tien trinh trung)"
        }
    }
    Write-Host "[ASSERTION OK] $Context ($($PidsBefore.Keys -join ', ')) ton tai va giu nguyen PID." -ForegroundColor Green
}

function Assert-DashboardPanelsMatch {
    param($PanelsBefore, $PanelsAfter)
    if ($PanelsBefore.Count -ne $PanelsAfter.Count) {
        throw "ASSERTION_ERROR: So luong panel thay doi! Truoc: $($PanelsBefore.Count), Sau: $($PanelsAfter.Count)"
    }

    foreach ($pB in $PanelsBefore) {
        $pA = $PanelsAfter | Where-Object { $_.id -eq $pB.id }
        if (-not $pA) {
            throw "ASSERTION_ERROR: Panel ID $($pB.id) ('$($pB.title)') bi thieu sau restart!"
        }

        if ($pB.title -ne $pA.title) { throw "ASSERTION_ERROR: Panel ID $($pB.id) sai tieu de!" }
        if ($pB.type -ne $pA.type)   { throw "ASSERTION_ERROR: Panel ID $($pB.id) sai type!" }

        if ($pB.type -eq 'text') {
            if ($pB.options.content -ne $pA.options.content) {
                throw "ASSERTION_ERROR: Panel ID $($pB.id) ('$($pB.title)') sai noi dung text options!"
            }
        } else {
            if ($pB.targets -and $pB.targets.Count -gt 0) {
                $exprBefore = $pB.targets[0].expr
                $exprAfter  = $pA.targets[0].expr
                if ($exprBefore -ne $exprAfter) {
                    throw "ASSERTION_ERROR: Panel ID $($pB.id) ('$($pB.title)') sai bieu thuc! Truoc: '$exprBefore', Sau: '$exprAfter'"
                }
            }

            $noValBefore = if ($pB.fieldConfig.defaults.noValue) { $pB.fieldConfig.defaults.noValue } else { '' }
            $noValAfter  = if ($pA.fieldConfig.defaults.noValue) { $pA.fieldConfig.defaults.noValue } else { '' }
            if ($noValBefore -ne $noValAfter) {
                throw "ASSERTION_ERROR: Panel ID $($pB.id) sai noValue! Truoc: '$noValBefore', Sau: '$noValAfter'"
            }

            $mapJsonBefore = if ($pB.fieldConfig.defaults.mappings) { ($pB.fieldConfig.defaults.mappings | ConvertTo-Json -Compress) } else { '' }
            $mapJsonAfter  = if ($pA.fieldConfig.defaults.mappings) { ($pA.fieldConfig.defaults.mappings | ConvertTo-Json -Compress) } else { '' }
            if ($mapJsonBefore -ne $mapJsonAfter) {
                throw "ASSERTION_ERROR: Panel ID $($pB.id) sai mappings!"
            }

            $threshJsonBefore = if ($pB.fieldConfig.defaults.thresholds) { ($pB.fieldConfig.defaults.thresholds | ConvertTo-Json -Compress) } else { '' }
            $threshJsonAfter  = if ($pA.fieldConfig.defaults.thresholds) { ($pA.fieldConfig.defaults.thresholds | ConvertTo-Json -Compress) } else { '' }
            if ($threshJsonBefore -ne $threshJsonAfter) {
                throw "ASSERTION_ERROR: Panel ID $($pB.id) sai thresholds!"
            }
        }
    }
    Write-Host "[ASSERTION OK] Toan bo $($PanelsBefore.Count) panels duoc doi chieu noi dung chi tiet (expr, noValue, mappings, thresholds) va khop 100%!" -ForegroundColor Green
}
