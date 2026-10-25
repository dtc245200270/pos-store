# ==============================================================================
# ProcessIdentity.ps1 - Hàm nhận diện tiến trình dùng chung cho Loki và Alloy
# ==============================================================================

function Test-IsTargetLoggingProcess {
    <#
    .SYNOPSIS
        Xác minh danh tính tiến trình logging POS Store (Loki / Alloy).
    .DESCRIPTION
        Yêu cầu thỏa mãn đồng thời cả hai điều kiện (AND, tuyệt đối không dùng OR):
        1. ExecutablePath chuẩn hóa phải khớp chính xác đường dẫn tệp thực thi mong muốn.
        2. CommandLine phải chứa đường dẫn tệp cấu hình chuẩn hóa khớp chính xác tệp cấu hình của POS Store.
        Không chấp nhận so sánh bằng tên tệp chung chung hay chỉ dựa vào số cổng mạng.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        $Process,

        [Parameter(Mandatory = $true)]
        [string]$ExpectedExe,

        [Parameter(Mandatory = $true)]
        [string]$ExpectedConfig
    )

    if (-not $Process) { return $false }
    if ([string]::IsNullOrWhiteSpace($ExpectedExe) -or [string]::IsNullOrWhiteSpace($ExpectedConfig)) {
        return $false
    }

    # 1. Chuan hoa ExecutablePath va so sanh tuyet doi
    $rawExe = if ($Process.ExecutablePath) { 
        $Process.ExecutablePath 
    } elseif ($Process.Path) { 
        $Process.Path 
    } elseif ($Process.PSObject.Properties['MainModule'] -and $Process.MainModule.FileName) { 
        $Process.MainModule.FileName 
    } else { 
        $null 
    }

    if ([string]::IsNullOrWhiteSpace($rawExe)) {
        return $false
    }

    try {
        $cleanRawExe = $rawExe.Trim().Trim('"').Trim("'")
        $cleanExpectedExe = $ExpectedExe.Trim().Trim('"').Trim("'")
        $procExeNorm = [System.IO.Path]::GetFullPath($cleanRawExe).Trim().ToLower()
        $expectedExeNorm = [System.IO.Path]::GetFullPath($cleanExpectedExe).Trim().ToLower()
        if ($procExeNorm -ne $expectedExeNorm) {
            return $false
        }
    } catch {
        return $false
    }

    # 2. Chuan hoa CommandLine va xac minh duong dan config thuc te
    $rawCmd = $Process.CommandLine
    if ([string]::IsNullOrWhiteSpace($rawCmd)) {
        return $false
    }

    try {
        $cleanExpectedConfig = $ExpectedConfig.Trim().Trim('"').Trim("'")
        $expectedConfigNorm = [System.IO.Path]::GetFullPath($cleanExpectedConfig).Trim().ToLower()
        $expectedConfigBackslash = $expectedConfigNorm.Replace('/', '\')
        $expectedConfigSlash = $expectedConfigNorm.Replace('\', '/')

        $escBackslash = [regex]::Escape($expectedConfigBackslash)
        $escSlash = [regex]::Escape($expectedConfigSlash)

        # Mau regex khop chinh xac duong dan config trong CommandLine
        # Yeu cau duong dan phai la mot token rieng biet (duoc bao boi khoang trang, dau ngoac kep/don, dau bang =, hoac dau/cuoi chuoi)
        # Khong chap nhan trung ten file chung chung hay trung so cong
        $pattern = "(?i)(?:^|[\s=`"'\t])(" + $escBackslash + "|" + $escSlash + ")(?:$|[\s`"'\t])"

        if (-not [regex]::IsMatch($rawCmd, $pattern)) {
            return $false
        }
    } catch {
        return $false
    }

    return $true
}

function Get-TargetLoggingProcess {
    <#
    .SYNOPSIS
        Tim kiem danh sach tien trinh dung danh tinh Loki / Alloy tren he thong.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$ProcessName,

        [Parameter(Mandatory = $true)]
        [string]$ExpectedExe,

        [Parameter(Mandatory = $true)]
        [string]$ExpectedConfig
    )

    $allProcs = Get-CimInstance Win32_Process -Filter "Name = '$ProcessName'" -ErrorAction SilentlyContinue
    $targets = @()
    if ($allProcs) {
        foreach ($p in $allProcs) {
            if (Test-IsTargetLoggingProcess -Process $p -ExpectedExe $ExpectedExe -ExpectedConfig $ExpectedConfig) {
                $targets += $p
            }
        }
    }
    return $targets
}

function Assert-PortAvailableOrTargetIdentity {
    <#
    .SYNOPSIS
        Kiem tra cong TCP; neu dang bi chiem, xac minh danh tinh tien trinh chiem cong.
        Neu tien trinh chiem cong khong dung danh tinh -> bao xung dot va nem loi ngay lap tuc.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [int]$Port,

        [Parameter(Mandatory = $true)]
        [string]$ServiceName,

        [Parameter(Mandatory = $true)]
        [string]$ExpectedExe,

        [Parameter(Mandatory = $true)]
        [string]$ExpectedConfig
    )

    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if (-not $conn) {
        return @{
            IsListening = $false
            IsTarget    = $false
            Process     = $null
        }
    }

    $owningPid = ($conn | Select-Object -ExpandProperty OwningProcess -Unique)[0]
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $owningPid" -ErrorAction SilentlyContinue

    if (-not $proc) {
        throw "XUNG DOT: Cong $Port dang bi chiem boi PID $owningPid nhung khong the xac dinh thong tin tien trinh!"
    }

    $isTarget = Test-IsTargetLoggingProcess -Process $proc -ExpectedExe $ExpectedExe -ExpectedConfig $ExpectedConfig

    if (-not $isTarget) {
        throw "XUNG DOT: Cong $Port dang bi chiem boi tien trinh KHONG DUNG DANH TINH $ServiceName POS Store! (PID: $owningPid, Name: $($proc.Name), Exe: $($proc.ExecutablePath), Cmd: $($proc.CommandLine))"
    }

    return @{
        IsListening = $true
        IsTarget    = $true
        Process     = $proc
    }
}
