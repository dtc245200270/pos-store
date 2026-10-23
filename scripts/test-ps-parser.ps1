$scripts = @(
    'deploy\monitoring\stop-monitoring.ps1',
    'deploy\monitoring\start-monitoring.ps1'
)

$allPassed = $true

foreach ($s in $scripts) {
    $fullPath = Join-Path $PSScriptRoot "..\$s"
    $errs = $null
    $toks = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($fullPath, [ref]$toks, [ref]$errs)
    if ($errs.Count -eq 0) {
        Write-Host "PARSER OK (0 errors): $s" -ForegroundColor Green
    } else {
        Write-Host "PARSER ERRORS ($($errs.Count)): $s" -ForegroundColor Red
        $errs | ForEach-Object { Write-Host " - Line $($_.Extent.StartLineNumber): $($_.Message)" -ForegroundColor Red }
        $allPassed = $false
    }
}

if (-not $allPassed) {
    exit 1
}
