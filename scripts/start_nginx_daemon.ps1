$ErrorActionPreference = 'Stop'

$nginxDir = "C:\nginx"
$nginxExe = "C:\nginx\nginx.exe"

$res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $nginxExe
    CurrentDirectory = $nginxDir
}

Write-Host "Create result ReturnValue: $($res.ReturnValue), ProcessId: $($res.ProcessId)"

Start-Sleep -Seconds 2

$conn = Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue
if ($conn) {
    Write-Host "Nginx is now LISTENING on port 8080!"
} else {
    Write-Host "Nginx not listening on 8080. Checking processes:"
    Get-Process nginx -ErrorAction SilentlyContinue
}
