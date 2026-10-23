$files = @(
    "deploy\monitoring\start-monitoring.ps1",
    "deploy\monitoring\stop-monitoring.ps1"
)

$hasError = $false

foreach ($f in $files) {
    $fullPath = [System.IO.Path]::GetFullPath($f)
    $tokens = $null
    $errors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile($fullPath, [ref]$tokens, [ref]$errors)

    if ($errors.Count -eq 0) {
        Write-Host "[AST PARSE OK] ${f} - Khong co loi cu phap nao." -ForegroundColor Green
    } else {
        $hasError = $true
        Write-Host "[AST ERROR] ${f} co $($errors.Count) loi:" -ForegroundColor Red
        foreach ($e in $errors) {
            Write-Host "  Line $($e.Extent.StartLineNumber): $($e.Message)" -ForegroundColor Red
        }
    }
}

if ($hasError) { exit 1 } else { exit 0 }
