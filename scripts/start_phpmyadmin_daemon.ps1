$ErrorActionPreference = 'Stop'

$phpExe = "C:\xampp\php\php.exe"
$pmaDir = "C:\xampp\phpMyAdmin"
$cmdLine = "`"$phpExe`" -S 127.0.0.1:8081 -t `"$pmaDir`""

$res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $cmdLine
    CurrentDirectory = $pmaDir
}

Write-Host "Khoi tao tien trinh: ReturnValue = $($res.ReturnValue), ProcessId = $($res.ProcessId)"

Start-Sleep -Seconds 2

$conn = Get-NetTCPConnection -LocalPort 8081 -State Listen -ErrorAction SilentlyContinue
if ($conn) {
    Write-Host "phpMyAdmin dang lang nghe tai http://127.0.0.1:8081 (PID: $($conn.OwningProcess))"
} else {
    Write-Host "Chua thay lang nghe tai cong 8081"
}
