$ErrorActionPreference = 'Stop'
Write-Host "Testing start alloy with cmd start..."

$alloyExe = "C:\alloy\alloy.exe"
$alloyData = "C:\alloy\data"
$alloyConfig = "C:\alloy\config.alloy"

$cmdLine = "start `"`" /B `"$alloyExe`" run --storage.path=`"$alloyData`" --server.http.listen-addr=127.0.0.1:12345 `"$alloyConfig`""
cmd.exe /c $cmdLine

Start-Sleep -Seconds 2

$conn = Get-NetTCPConnection -LocalPort 12345 -State Listen -ErrorAction SilentlyContinue
if ($conn) {
    Write-Host "[SUCCESS] Alloy is listening on 12345 (PID: $($conn.OwningProcess))!" -ForegroundColor Green
} else {
    Write-Host "[FAIL] Alloy not listening!" -ForegroundColor Red
}
