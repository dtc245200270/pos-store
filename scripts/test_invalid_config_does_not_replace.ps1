$ErrorActionPreference = 'Stop'

Write-Host "=== TEST: CAU HINH LOI KHONG THAY FILE HOP LE ===" -ForegroundColor Cyan

$promDiskPath = "C:\prometheus\prometheus.yml"
$repoPromPath = "deploy\monitoring\prometheus.yml"

if (-not (Test-Path -LiteralPath $promDiskPath)) {
    throw "File tren disk '$promDiskPath' khong ton tai truoc khi bat dau test!"
}
if (-not (Test-Path -LiteralPath $repoPromPath)) {
    throw "File trong repo '$repoPromPath' khong ton tai truoc khi bat dau test!"
}

$origRepoContent = Get-Content -LiteralPath $repoPromPath -Raw
$origRepoHash = (Get-FileHash -LiteralPath $repoPromPath -Algorithm SHA256).Hash
$origDiskHash = (Get-FileHash -LiteralPath $promDiskPath -Algorithm SHA256).Hash

Write-Host "SHA256 disk truoc test : $origDiskHash"
Write-Host "SHA256 repo truoc test : $origRepoHash"

try {
    # 1. Ghi noi dung cau hinh sai cu phap vao candidate (repo)
    Write-Host "`n1. Tao cau hinh loi cu phap vao '$repoPromPath'..." -ForegroundColor Cyan
    $invalidYaml = @"
global:
  scrape_interval: 15s
  [invalid_yaml_syntax_here:::
scrape_configs:
  - job_name: 'corrupted_job
"@
    Set-Content -LiteralPath $repoPromPath -Value $invalidYaml -NoNewline

    # 2. Chay start-monitoring.ps1
    Write-Host "2. Chay start-monitoring.ps1 voi candidate loi..." -ForegroundColor Cyan
    $proc = Start-Process -FilePath "powershell.exe" `
        -ArgumentList @("-ExecutionPolicy", "Bypass", "-File", "deploy\monitoring\start-monitoring.ps1") `
        -NoNewWindow -PassThru -Wait

    $exitCode = $proc.ExitCode
    Write-Host "Exit code thuc te: $exitCode"

    # 3. Kiem tra exit code phai la 1 (that bai)
    if ($exitCode -eq 0) {
        throw "ASSERTION FAILED: start-monitoring.ps1 tra ve exit code 0 khi candidate bi loi cu phap! Phai tra ve 1."
    }
    Write-Host "[ASSERTION OK] start-monitoring.ps1 tu choi candidate va thoat voi exit code $exitCode (khac 0)." -ForegroundColor Green

    # 4. Kiem tra file C:\prometheus\prometheus.yml tren disk khong bi thay the
    $currentDiskHash = (Get-FileHash -LiteralPath $promDiskPath -Algorithm SHA256).Hash
    Write-Host "SHA256 disk sau khi chay: $currentDiskHash"

    if ($currentDiskHash -ne $origDiskHash) {
        throw "ASSERTION FAILED: File '$promDiskPath' da bi thay doi! Truoc: $origDiskHash, Sau: $currentDiskHash"
    }
    Write-Host "[ASSERTION OK] File tren disk '$promDiskPath' duoc giu nguyen 100%, khong bi ghi de boi candidate loi!" -ForegroundColor Green

} finally {
    # Luon luon phuc hoi file repo goc
    Write-Host "`n[FINALLY] Phuc hoi file '$repoPromPath' ve nguyen ban..." -ForegroundColor Yellow
    Set-Content -LiteralPath $repoPromPath -Value $origRepoContent -NoNewline
    $restoredHash = (Get-FileHash -LiteralPath $repoPromPath -Algorithm SHA256).Hash
    if ($restoredHash -ne $origRepoHash) {
        Write-Error "Khong the phuc hoi file '$repoPromPath' ve nguyen ban!"
    } else {
        Write-Host "[FINALLY OK] Da phuc hoi file repo hop le ve SHA256 ban dau." -ForegroundColor Green
    }
}

Write-Host "`n=> TEST CAU HINH LOI KHONG THAY FILE HOP LE: PASS HOAN TOAN!" -ForegroundColor Green
exit 0
