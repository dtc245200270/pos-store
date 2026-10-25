<#
.SYNOPSIS
    Kịch bản kiểm tra các biểu thức truy vấn PromQL trên Prometheus cho POS Store.
.DESCRIPTION
    Đường dẫn: scripts/check_prom_queries.ps1
    Mục đích:
    - Gửi yêu cầu truy vấn HTTP tới API Prometheus (/api/v1/query).
    - Kiểm tra 4 biểu thức đo lường chính:
      1. Panel 1 (UP): up{job="pos_store"} - Trạng thái tiến trình ứng dụng còn sống (1) hay chết (0).
      2. Panel 2 (RPS): sum(rate(http_requests_total[1m])) - Tần suất yêu cầu trên giây.
      3. Panel 3 (5xx %): Tỷ lệ phần trăm lỗi máy chủ HTTP 5xx trên tổng số yêu cầu.
      4. Panel 4 (<=2s %): Tỷ lệ phần trăm yêu cầu phản hồi nhanh trong 2 giây.
    - Phân biệt rõ: Metric không có dữ liệu (Vector rỗng `result: []`) khác với metric có giá trị bằng số 0.
#>

$queries = @(
    @{ Name = "Panel 1 (UP)"; Expr = 'up{job="pos_store"}' },
    @{ Name = "Panel 2 (RPS)"; Expr = 'sum(rate(http_requests_total{job="pos_store"}[1m]))' },
    @{ Name = "Panel 3 (5xx %)"; Expr = '((sum(rate(http_requests_total{job="pos_store", status_code=~"5.."}[1m])) or (sum(rate(http_requests_total{job="pos_store"}[1m])) * 0)) / (sum(rate(http_requests_total{job="pos_store"}[1m])) > 0)) * 100' },
    @{ Name = "Panel 4 (<=2s %)"; Expr = '(sum(rate(http_request_duration_seconds_bucket{job="pos_store", le=~"2|2[.]0"}[1m])) / (sum(rate(http_request_duration_seconds_count{job="pos_store"}[1m])) > 0)) * 100' }
)

Write-Host "=== KIEM TRA CAC BIEU THUC PROMETHEUS ==="
foreach ($q in $queries) {
    $encoded = [System.Uri]::EscapeDataString($q.Expr)
    $url = "http://127.0.0.1:9090/api/v1/query?query=$encoded"
    try {
        $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5
        $json = $resp.Content | ConvertFrom-Json
        $resultCount = ($json.data.result | Measure-Object).Count
        if ($resultCount -eq 0) {
            Write-Host "$($q.Name): VECTOR RONG (result: [])"
        } else {
            $val = $json.data.result[0].value[1]
            Write-Host "$($q.Name): VALUE = $val"
        }
    } catch {
        Write-Host "$($q.Name): ERROR $_"
    }
}
