$p = Start-Process -FilePath "C:\nginx\nginx.exe" -WorkingDirectory "C:\nginx" -PassThru
Start-Sleep -Seconds 1
$nginxProcs = Get-Process -Name nginx -ErrorAction SilentlyContinue
foreach ($np in $nginxProcs) {
    Write-Host "Nginx running PID: $($np.Id) | $($np.Path)"
}
$conn = Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue
if ($conn) {
    Write-Host "Nginx listening on port 8080 successfully!"
} else {
    Write-Host "Port 8080 not listening yet."
}
