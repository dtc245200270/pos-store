# Kịch bản kiểm thử độc lập cho hàm xác minh trong stop-phpmyadmin.ps1
# Không dừng tiến trình thực tế, chỉ kiểm tra tính đúng đắn của logic

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

function Test-ProcessMatch {
    param(
        [string]$execPath,
        [string]$cmdLine
    )

    $expectedPhpNorm = Normalize-PathStr $expectedPhpPath
    $expectedDocRootNorm = Normalize-PathStr $expectedDocRoot

    # 1. ExecutablePath phải khớp chính xác C:\xampp\php\php.exe sau chuẩn hóa, không phân biệt hoa/thường
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

    $isValid = ($isPhp -and $isCorrectServer -and $isCorrectDocRoot)

    return [PSCustomObject]@{
        Valid = $isValid
        IsPhp = $isPhp
        IsCorrectServer = $isCorrectServer
        IsCorrectDocRoot = $isCorrectDocRoot
        ParsedServer = $serverValue
        ParsedDocRoot = $docRootValue
    }
}

Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host "  KIỂM THỬ 5 TRƯỜNG HỢP XÁC MINH TIẾN TRÌNH TRONG STOP SCRIPT   " -ForegroundColor Green
Write-Host "=================================================================" -ForegroundColor Cyan

# 1. Đúng executable, địa chỉ và document root: chấp nhận
$t1 = Test-ProcessMatch -execPath "c:\xampp\php\php.exe" -cmdLine "C:\xampp\php\php.exe -S 127.0.0.1:8081 -t C:\xampp\phpMyAdmin"
Write-Host "Test 1: Đúng executable, địa chỉ và document root"
Write-Host " -> Kết quả: Valid = $($t1.Valid) (Kỳ vọng: True)" -ForegroundColor $(if ($t1.Valid) { "Green" } else { "Red" })

# 2. PHP ở thư mục khác: từ chối
$t2 = Test-ProcessMatch -execPath "C:\custom_php\php.exe" -cmdLine "C:\custom_php\php.exe -S 127.0.0.1:8081 -t C:\xampp\phpMyAdmin"
Write-Host "`nTest 2: PHP ở thư mục khác ('C:\custom_php\php.exe')"
Write-Host " -> Kết quả: Valid = $($t2.Valid) (Kỳ vọng: False)" -ForegroundColor $(if (-not $t2.Valid) { "Green" } else { "Red" })

# 3. Document root phpMyAdmin-old: từ chối
$t3 = Test-ProcessMatch -execPath "C:\xampp\php\php.exe" -cmdLine "C:\xampp\php\php.exe -S 127.0.0.1:8081 -t C:\xampp\phpMyAdmin-old"
Write-Host "`nTest 3: Document root là 'C:\xampp\phpMyAdmin-old' (Không dùng Contains)"
Write-Host " -> Kết quả: Valid = $($t3.Valid) (Kỳ vọng: False)" -ForegroundColor $(if (-not $t3.Valid) { "Green" } else { "Red" })

# 4a. Thiếu -t: từ chối
$t4a = Test-ProcessMatch -execPath "C:\xampp\php\php.exe" -cmdLine "C:\xampp\php\php.exe -S 127.0.0.1:8081"
Write-Host "`nTest 4a: Thiếu tham số -t"
Write-Host " -> Kết quả: Valid = $($t4a.Valid) (Kỳ vọng: False)" -ForegroundColor $(if (-not $t4a.Valid) { "Green" } else { "Red" })

# 4b. Sai địa chỉ: từ chối
$t4b = Test-ProcessMatch -execPath "C:\xampp\php\php.exe" -cmdLine "C:\xampp\php\php.exe -S 127.0.0.1:8080 -t C:\xampp\phpMyAdmin"
Write-Host "`nTest 4b: Sai địa chỉ sau -S (127.0.0.1:8080)"
Write-Host " -> Kết quả: Valid = $($t4b.Valid) (Kỳ vọng: False)" -ForegroundColor $(if (-not $t4b.Valid) { "Green" } else { "Red" })

# 5. Đường dẫn có ngoặc kép: phân tích đúng
$t5 = Test-ProcessMatch -execPath '"C:\xampp\php\php.exe"' -cmdLine '"C:\xampp\php\php.exe" -S "127.0.0.1:8081" -t "C:\xampp\phpMyAdmin"'
Write-Host "`nTest 5: Đường dẫn và tham số đều có dấu ngoặc kép"
Write-Host " -> Kết quả: Valid = $($t5.Valid) (Kỳ vọng: True)" -ForegroundColor $(if ($t5.Valid) { "Green" } else { "Red" })
Write-Host " -> ParsedServer: '$($t5.ParsedServer)', ParsedDocRoot: '$($t5.ParsedDocRoot)'"

# Kiểm tra tổng kết
$allPassed = ($t1.Valid -and (-not $t2.Valid) -and (-not $t3.Valid) -and (-not $t4a.Valid) -and (-not $t4b.Valid) -and $t5.Valid)
Write-Host "`n=================================================================" -ForegroundColor Cyan
if ($allPassed) {
    Write-Host "TẤT CẢ 5 BÀI TEST LOGIC ĐÃ VƯỢT QUA 100%!" -ForegroundColor Green
} else {
    Write-Error "CÓ BÀI TEST CHƯA ĐẠT!"
}
Write-Host "=================================================================" -ForegroundColor Cyan