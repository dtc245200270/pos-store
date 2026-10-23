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
