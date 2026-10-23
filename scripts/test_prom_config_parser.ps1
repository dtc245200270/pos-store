function Parse-PrometheusYaml {
    param([string]$yamlText)

    $result = @{
        ScrapeConfigs = @{}
    }

    # Split into jobs by '- job_name:'
    $jobChunks = $yamlText -split '(?m)^[ \t]*-[ \t]+job_name:[ \t]*'
    for ($i = 1; $i -lt $jobChunks.Count; $i++) {
        $chunk = $jobChunks[$i]
        $lines = $chunk -split '\r?\n'

        # First line is the job name
        $rawJobName = ($lines[0] -split '#')[0].Trim().Trim('"').Trim("'")
        if ([string]::IsNullOrWhiteSpace($rawJobName)) { continue }

        $jobData = @{
            JobName = $rawJobName
            Targets = @()
            Labels = @{}
            MetricsPath = '/metrics'
        }

        # Check metrics_path
        if ($chunk -match '(?m)^[ \t]*metrics_path:[ \t]*[''"]?([^''"\r\n\t #]+)') {
            $jobData.MetricsPath = $matches[1].Trim()
        }

        # Check targets in inline format: targets: ['127.0.0.1:9101', ...]
        $inlineTargetMatches = [regex]::Matches($chunk, '(?m)targets:[ \t]*\[([^\]]+)\]')
        foreach ($m in $inlineTargetMatches) {
            $items = $m.Groups[1].Value -split ','
            foreach ($it in $items) {
                $clean = $it.Trim().Trim('"').Trim("'")
                if ($clean) { $jobData.Targets += $clean }
            }
        }

        # Check targets in list format:
        # targets:
        #   - 127.0.0.1:9101
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

        # Deduplicate targets
        $jobData.Targets = @($jobData.Targets | Select-Object -Unique)

        # Check labels block
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

    foreach ($jobName in $desired.ScrapeConfigs.Keys) {
        if (-not $runtime.ScrapeConfigs.ContainsKey($jobName)) {
            $diffs += "Job '$jobName' thieu trong runtime scrape_configs."
            continue
        }

        $desJob = $desired.ScrapeConfigs[$jobName]
        $runJob = $runtime.ScrapeConfigs[$jobName]

        # Kiem tra metrics_path
        if ($desJob.MetricsPath -ne $runJob.MetricsPath) {
            $diffs += "Job '$jobName' metrics_path khac nhau (Desired: $($desJob.MetricsPath), Runtime: $($runJob.MetricsPath))."
        }

        # Kiem tra targets
        foreach ($tgt in $desJob.Targets) {
            if ($runJob.Targets -notcontains $tgt) {
                $diffs += "Job '$jobName' target '$tgt' khong co trong runtime targets ($($runJob.Targets -join ', '))."
            }
        }

        # Kiem tra labels
        foreach ($lblKey in $desJob.Labels.Keys) {
            $expectedVal = $desJob.Labels[$lblKey]
            if (-not $runJob.Labels.ContainsKey($lblKey)) {
                $diffs += "Job '$jobName' nhan '$lblKey' thieu trong runtime labels."
            } elseif ($runJob.Labels[$lblKey] -ne $expectedVal) {
                $diffs += "Job '$jobName' nhan '$lblKey' khac nhau (Desired: '$expectedVal', Runtime: '$($runJob.Labels[$lblKey])')."
            }
        }
    }

    return @{
        IsMatch = ($diffs.Count -eq 0)
        Differences = $diffs
        DesiredParsed = $desired
        RuntimeParsed = $runtime
    }
}

# Test against active repo and runtime
$repoYaml = Get-Content 'deploy\monitoring\prometheus.yml' -Raw
$runtimeResp = Invoke-WebRequest -Uri 'http://127.0.0.1:9090/api/v1/status/config' -UseBasicParsing
$runtimeYaml = ($runtimeResp.Content | ConvertFrom-Json).data.yaml

$cmp = Compare-PrometheusDesiredVsRuntime -DesiredYaml $repoYaml -RuntimeYaml $runtimeYaml

Write-Host "IsMatch: $($cmp.IsMatch)"
Write-Host "Differences count: $($cmp.Differences.Count)"
if ($cmp.Differences.Count -gt 0) {
    Write-Host "Differences:"
    $cmp.Differences | ForEach-Object { Write-Host " - $_" }
} else {
    Write-Host "Desired parsed job 'pos_store':"
    $cmp.DesiredParsed.ScrapeConfigs['pos_store'] | Out-String | Write-Host
    Write-Host "Runtime parsed job 'pos_store':"
    $cmp.RuntimeParsed.ScrapeConfigs['pos_store'] | Out-String | Write-Host
}
