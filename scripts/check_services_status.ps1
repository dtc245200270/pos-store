<#
.SYNOPSIS
    Kịch bản kiểm tra trạng thái hoạt động của toàn bộ 6 dịch vụ hệ thống POS Store trên Windows.
.DESCRIPTION
    Đường dẫn: scripts/check_services_status.ps1
    Mục đích:
    - Quét các cổng mạng TCP đang lắng nghe (Listening Ports):
      + 3306 (MySQL80), 3000 (Backend Express), 9101 (Metrics Server),
      + 8080 (Nginx Reverse Proxy), 9090 (Prometheus), 3030 (Grafana).
    - Phân biệt kiểm tra tiến trình đang chạy và chiếm cổng (LISTENING PID) với việc kết nối logic cơ sở dữ liệu.
#>

$ErrorActionPreference = 'SilentlyContinue'

$services = @(
    @{ Name = "MySQL80"; Port = 3306; ExpectedExe = "mysqld.exe" },
    @{ Name = "Backend"; Port = 3000; ExpectedExe = "node.exe" },
    @{ Name = "Metrics"; Port = 9101; ExpectedExe = "node.exe" },
    @{ Name = "Nginx"; Port = 8080; ExpectedExe = "nginx.exe" },
    @{ Name = "Prometheus"; Port = 9090; ExpectedExe = "prometheus.exe" },
    @{ Name = "Grafana"; Port = 3030; ExpectedExe = "grafana" }
)

Write-Host "=== KIEM TRA TRANG THAI CAC DICH VU ==="
foreach ($svc in $services) {
    $conn = Get-NetTCPConnection -LocalPort $svc.Port -State Listen -ErrorAction SilentlyContinue
    if ($conn) {
        $uniquePids = $conn | Select-Object -ExpandProperty OwningProcess -Unique
        foreach ($pidItem in $uniquePids) {
            $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $pidItem" -ErrorAction SilentlyContinue
            Write-Host "[LISTENING] $($svc.Name) - Port $($svc.Port): PID $pidItem | Process: $($proc.Name) | Path: $($proc.ExecutablePath)"
        }
    } else {
        Write-Host "[STOPPED] $($svc.Name) - Port $($svc.Port): Chua co tien trinh lang nghe"
    }
}
