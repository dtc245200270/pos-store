# Script dừng an toàn tiến trình phpMyAdmin tại cổng 8081
# Chỉ dừng đúng tiến trình PHP phục vụ phpMyAdmin đã xác minh đầy đủ

$port = 8081
$expectedPhpPath = "C:\xampp\php\php.exe"
$expectedDocRoot = "C:\xampp\phpMyAdmin"
$expectedListen = "127.0.0.1:8081"

function Normalize-PathStr {
    param([string]$pathStr)
    if ([string]::IsNullOrWhiteSpace($pathStr)) { return "" }
    $trimmed = $pathStr.Trim().Trim('"').Trim("'")
    try {
        return [System.IO.Path]::GetFullPath($trimmed).TrimEnd('\', '/')
    } catch {
        return $trimmed.TrimEnd('\', '/')
    }
}

function Parse-CommandLineArgs {
    param([string]$cmdLine)
    $argsList = [System.Collections.Generic.List[string]]::new()
    if ([string]::IsNullOrWhiteSpace($cmdLine)) { return $argsList }

    $regex = [regex]'"([^"]*)"|(\S+)'
    $matches = $regex.Matches($cmdLine)
    foreach ($m in $matches) {
        $val = if ($m.Groups[1].Success) { $m.Groups[1].Value } else { $m.Groups[2].Value }
        $argsList.Add($val.Trim().Trim('"').Trim("'"))
    }
    return $argsList
}

Write-Host "Kiểm tra cổng ${port}..." -ForegroundColor Cyan

$connections = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue

if (-not $connections) {
    Write-Host "Không có tiến trình nào đang lắng nghe tại cổng ${port}." -ForegroundColor Yellow
    exit 0
}

# Lấy danh sách PID duy nhất (tránh lặp khi có nhiều kết nối TCP)
$pids = $connections | Select-Object -ExpandProperty OwningProcess -Unique

$expectedPhpNorm = Normalize-PathStr $expectedPhpPath
$expectedDocRootNorm = Normalize-PathStr $expectedDocRoot

foreach ($processId in $pids) {
    if (-not $processId -or $processId -le 4) {
        Write-Warning "Bỏ qua PID hệ thống không hợp lệ: ${processId}"
        continue
    }

    # Lấy thông tin tiến trình qua CIM/WMI
    $procInfo = $null
    try {
        $procInfo = Get-CimInstance Win32_Process -Filter "ProcessId = ${processId}" -ErrorAction SilentlyContinue
    } catch {
        $errMsg = $_.Exception.Message
        Write-Warning "Không thể truy vấn thông tin PID ${processId}: ${errMsg}"
    }

    if (-not $procInfo) {
        Write-Host "Tiến trình (PID: ${processId}) không còn tồn tại hoặc đã thoát." -ForegroundColor Yellow
        continue
    }

    $execPath = $procInfo.ExecutablePath
    $cmdLine = $procInfo.CommandLine
    $procName = $procInfo.Name

    Write-Host "Phát hiện tiến trình đang giữ cổng ${port} (PID: ${processId}):"
    Write-Host " - Tên: ${procName}"
    Write-Host " - File thực thi: ${execPath}"
    Write-Host " - Lệnh khởi chạy: ${cmdLine}"

    # 1. Kiểm tra ExecutablePath: Khớp chính xác C:\xampp\php\php.exe sau chuẩn hóa, không phân biệt hoa/thường
    $normExec = Normalize-PathStr $execPath
    $isPhp = ($normExec -and ($normExec -ieq $expectedPhpNorm))

    # 2. Phân tích tham số command line có xử lý dấu ngoặc kép
    $tokens = Parse-CommandLineArgs $cmdLine
    $serverValue = $null
    $docRootValue = $null

    for ($i = 0; $i -lt $tokens.Count; $i++) {
        $tok = $tokens[$i]
        if ($tok -ieq "-S" -and ($i + 1) -lt $tokens.Count) {
            $serverValue = $tokens[$i + 1]
        } elseif ($tok.Length -gt 2 -and $tok.Substring(0, 2) -ieq "-S") {
            $serverValue = $tok.Substring(2)
        }

        if ($tok -ieq "-t" -and ($i + 1) -lt $tokens.Count) {
            $docRootValue = $tokens[$i + 1]
        } elseif ($tok.Length -gt 2 -and $tok.Substring(0, 2) -ieq "-t") {
            $docRootValue = $tok.Substring(2)
        }
    }

    # 3. Giá trị sau -S phải đúng 127.0.0.1:8081
    $isCorrectServer = ($serverValue -and ($serverValue.Trim().Trim('"').Trim("'") -ieq $expectedListen))

    # 4. Giá trị sau -t phải khớp chính xác C:\xampp\phpMyAdmin sau khi chuẩn hóa (Không dùng Contains)
    $isCorrectDocRoot = $false
    if ($docRootValue) {
        $normDocRoot = Normalize-PathStr $docRootValue
        $isCorrectDocRoot = ($normDocRoot -ieq $expectedDocRootNorm)
    }

    # Xác minh tính hợp lệ
    if ($isPhp -and $isCorrectServer -and $isCorrectDocRoot) {
        Write-Host "-> Xác minh THÀNH CÔNG: Đây chính xác là tiến trình phpMyAdmin dự kiến." -ForegroundColor Green
        try {
            Stop-Process -Id $processId -Force -ErrorAction Stop
            Write-Host "-> Đã dừng tiến trình phpMyAdmin (PID: ${processId}) an toàn." -ForegroundColor Green
        } catch {
            $stopErr = $_.Exception.Message
            Write-Error "Không thể dừng tiến trình PID ${processId}: ${stopErr}"
        }
    } else {
        Write-Warning "CẢNH BÁO: Tiến trình PID ${processId} KHÔNG khớp thông tin phpMyAdmin dự kiến!"
        if (-not $isPhp) {
            Write-Warning " - File thực thi không khớp '${expectedPhpNorm}' (thực tế: '${normExec}')"
        }
        if (-not $isCorrectServer) {
            Write-Warning " - Tham số -S không đúng '${expectedListen}' (thực tế: '${serverValue}')"
        }
        if (-not $isCorrectDocRoot) {
            Write-Warning " - Tham số -t không khớp '${expectedDocRootNorm}' (thực tế: '${docRootValue}')"
        }
        Write-Host "-> QUYẾT ĐỊNH: BỎ QUA, KHÔNG DỪNG TIẾN TRÌNH NÀY để bảo vệ hệ thống." -ForegroundColor Yellow
    }
}