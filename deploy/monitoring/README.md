# Hướng dẫn Vận hành Giám sát POS Store với Prometheus & Grafana (Windows Native)

Tài liệu hướng dẫn vận hành, giám sát hiệu năng thời gian thực cho ứng dụng POS Store chạy trực tiếp trên Windows (không dùng Docker, WSL hay máy ảo).

---

## 1. Thông tin kiến trúc và Cổng dịch vụ

| Dịch vụ | Địa chỉ & Cổng | Mục đích | Quyền truy cập & Bảo mật |
| :--- | :--- | :--- | :--- |
| **Node.js Application** | `127.0.0.1:3000` | Backend API & Session | Nội bộ / Chuyển tiếp qua Nginx |
| **Node.js Metrics Endpoint** | `127.0.0.1:9101/metrics` | Xuất Prometheus metrics | Máy chủ HTTP riêng, **không qua Nginx**, không session |
| **Nginx Reverse Proxy** | `127.0.0.1:8080` | Cổng truy cập Web chính | `http://localhost:8080` |
| **Prometheus Server** | `127.0.0.1:9090` | Thu thập (scrape) & Lưu trữ số liệu | Nội bộ, scrape cổng 9101 mỗi 15s |
| **Grafana Dashboard** | `127.0.0.1:3030` | Trực quan hóa số liệu | `http://127.0.0.1:3030` (Không dùng cổng 3000) |
| **phpMyAdmin** | `127.0.0.1:8081` | Quản trị cơ sở dữ liệu MySQL | Phục vụ kết nối tới MySQL80 |
| **MySQL80** | `127.0.0.1:3306` | Cơ sở dữ liệu chính | Lưu trữ dữ liệu nghiệp vụ |

---

## 2. Vị trí cài đặt và Cấu hình

- **Prometheus:**
  - Thư mục cài đặt: `C:\prometheus`
  - File thực thi: `C:\prometheus\prometheus.exe`, `C:\prometheus\promtool.exe`
  - File cấu hình gốc dự án: `deploy/monitoring/prometheus.yml` (tự động đồng bộ sang `C:\prometheus\prometheus.yml`)
  - Thư mục dữ liệu: `C:\prometheus\data` (Giới hạn lưu 7 ngày: `--storage.tsdb.retention.time=7d`, lifecycle enabled: `--web.enable-lifecycle`)
- **Grafana:**
  - Thư mục cài đặt: `C:\grafana`
  - File thực thi: `C:\grafana\bin\grafana.exe` (hoặc `grafana-server.exe`)
  - File cấu hình gốc dự án: `deploy/monitoring/grafana/custom.ini` (tự động đồng bộ sang `C:\grafana\conf\custom.ini`)
  - Thư mục cấu hình provisioning:
    - Datasource Prometheus: `C:\grafana\conf\provisioning\datasources\prometheus.yaml`
    - Dashboard Provider: `C:\grafana\conf\provisioning\dashboards\dashboards.yaml`
    - Dashboard JSON: `C:\grafana\conf\provisioning\dashboards\pos-store-dashboard.json`
  - Thư mục dữ liệu & nhật ký: `C:\grafana\data`

---

## 3. Các lệnh vận hành hệ thống giám sát (PowerShell)

Mở PowerShell tại thư mục gốc dự án `c:\Users\Dell Precision 5550\Documents\pos-store`:

### 3.1. Khởi động / Kiểm tra hệ thống (Start & Health Check)
```powershell
powershell -ExecutionPolicy Bypass -File deploy\monitoring\start-monitoring.ps1
```
* **Cơ chế hoạt động:**
  - Đồng bộ các file cấu hình và dashboard mới nhất từ repo sang thư mục cài đặt `C:\prometheus` và `C:\grafana`.
  - Kiểm tra cú pháp cấu hình bằng `promtool check config`.
  - Khởi động an toàn Prometheus (9090) và Grafana (3030) nếu chưa chạy; nếu đã chạy thì giữ nguyên PID (không sinh tiến trình trùng).
  - Kiểm tra HTTP readiness `/-/ready` (timeout 10s) cho Prometheus và `/api/health` (timeout 15s, `database = ok`) cho Grafana.
  - Phân biệt rõ:
    + **Hạ tầng giám sát:** Trạng thái sẵn sàng của Prometheus và Grafana.
    + **Giám sát POS Store:** Trạng thái endpoint metrics (`127.0.0.1:9101/metrics`) và target `pos_store` trên Prometheus (UP/DOWN).

### 3.2. Dừng an toàn hệ thống (Stop)
```powershell
powershell -ExecutionPolicy Bypass -File deploy\monitoring\stop-monitoring.ps1
```
* **Cơ chế hoạt động:**
  - Quét đúng cổng `9090` (Prometheus) và `3030` (Grafana).
  - Xác minh chính xác đường dẫn thực thi (`ExecutablePath`) và dòng lệnh (`CommandLine`) để **tuyệt đối không dừng nhầm chương trình khác**.
  - Không làm ảnh hưởng tới MySQL (3306), Node.js (3000, 9101) hay Nginx (8080).
  - Chờ và xác nhận cổng mạng được giải phóng hoàn toàn.
  - Trả về **exit code 0** khi thành công và **exit code 1** nếu có lỗi/không thể dừng.

### 3.3. Nạp lại cấu hình Prometheus không gián đoạn (Hot-Reload)

#### Cách 1 (Khuyến nghị - Tự động đồng bộ):
Chỉnh sửa file cấu hình tại `deploy/monitoring/prometheus.yml`, sau đó chạy:
```powershell
powershell -ExecutionPolicy Bypass -File deploy\monitoring\start-monitoring.ps1
```
Script sẽ tự động:
1. Phát hiện sự thay đổi thông qua mã băm SHA256.
2. Kiểm tra tính hợp lệ bằng `promtool check config`. Nếu có lỗi cú pháp, script lập tức **hủy reload**, báo lỗi chi tiết và không làm gián đoạn tiến trình đang chạy.
3. Nếu hợp lệ, gửi yêu cầu HTTP POST tới `http://127.0.0.1:9090/-/reload`.
4. Xác nhận cấu hình mới đã được nạp qua `/api/v1/status/config` và target qua `/api/v1/targets`.

#### Cách 2 (Thủ công qua dòng lệnh):
```powershell
# 1. Kiểm tra cú pháp trước khi nạp
& "C:\prometheus\promtool.exe" check config "C:\prometheus\prometheus.yml"

# 2. Gửi tín hiệu nạp lại cấu hình tới Prometheus
Invoke-WebRequest -Uri "http://127.0.0.1:9090/-/reload" -Method Post -UseBasicParsing
```

---

## 4. Địa chỉ truy cập & Đăng nhập

1. **Dashboard Grafana:**
   - URL: **`http://127.0.0.1:3030/d/pos-store-monitoring-dashboard`**
   - Tài khoản đăng nhập: `admin` / `admin`
   - *Lưu ý:* Hệ thống tắt anonymous access theo yêu cầu bảo mật. Bạn có thể đổi mật khẩu quản trị sau khi đăng nhập.
2. **Prometheus Targets & Truy vấn:**
   - Quản lý Targets: **`http://127.0.0.1:9090/targets`** (xác nhận target `pos_store` có trạng thái `UP`).
   - Bảng điều khiển biểu thức PromQL: **`http://127.0.0.1:9090/graph`**.
   - Cấu hình đang chạy thực tế: **`http://127.0.0.1:9090/api/v1/status/config`**.
3. **Endpoint Metrics nội bộ:**
   - **`http://127.0.0.1:9101/metrics`** (chỉ lắng nghe cục bộ `127.0.0.1`, không bị lộ ra ngoài).

---

## 5. Hướng dẫn xử lý sự cố thường gặp (Troubleshooting)

### Sự cố 1: Lỗi cú pháp khi nạp cấu hình mới cho Prometheus
* **Hiện tượng:** `start-monitoring.ps1` báo lỗi `[LOI CAU HINH PROMETHEUS]` kèm thông điệp từ promtool.
* **Nguyên nhân:** File YAML bị sai định dạng thụt dòng, sai từ khóa hoặc sai tên metric.
* **Cách xử lý:** 
  - Script tự động hủy reload để giữ nguyên phiên bản cấu hình runtime an toàn trước đó.
  - Sửa lại lỗi cú pháp trong `deploy/monitoring/prometheus.yml`.
  - Chạy `& "C:\prometheus\promtool.exe" check config deploy\monitoring\prometheus.yml` để kiểm tra trước khi chạy lại `start-monitoring.ps1`.

### Sự cố 2: Cổng 9090 hoặc 3030 bị chiếm bởi chương trình khác (`XUNG DOT CONG`)
* **Hiện tượng:** Script báo lỗi `[XUNG DOT CONG] Cong đang bi chiem boi chuong trinh khac...` và dừng lại.
* **Nguyên nhân:** Có phần mềm khác đang lắng nghe tại cổng `9090` hoặc `3030`.
* **Cách xử lý:**
  - Kiểm tra PID hiển thị trong thông báo lỗi bằng lệnh:
    ```powershell
    Get-Process -Id <PID> | Select-Object Id, ProcessName, Path
    ```
  - Nếu là tiến trình không cần thiết, đóng tiến trình đó hoặc cấu hình đổi cổng tương ứng trong file `.ini` / `.yml`.

### Sự cố 3: Hạ tầng chạy nhưng target `pos_store` báo `DOWN` hoặc `Metrics chưa mở`
* **Hiện tượng:** Prometheus và Grafana chạy bình thường, nhưng target `pos_store` hiển thị màu đỏ (DOWN) hoặc panel RPS = 0 khi đang có khách.
* **Nguyên nhân:** Ứng dụng Node.js POS Store chưa được khởi động hoặc máy chủ HTTP metrics (cổng 9101) bị lỗi.
* **Cách xử lý:**
  - Kiểm tra ứng dụng POS Store:
    ```powershell
    cd "c:\Users\Dell Precision 5550\Documents\pos-store"
    npm start
    ```
  - Kiểm tra trực tiếp endpoint metrics bằng yêu cầu HTTP GET:
    ```powershell
    curl.exe http://127.0.0.1:9101/metrics
    ```
  - Sau khi Node.js mở cổng 9101, Prometheus sẽ tự động chuyển trạng thái target sang `UP` trong vòng tối đa 15 giây.

### Sự cố 4: Grafana báo lỗi cơ sở dữ liệu (`database != ok`)
* **Hiện tượng:** Script báo lỗi `[LOI GRAFANA HEALTH] ... khong phan hoi /api/health hop le`.
* **Nguyên nhân:** File SQLite `C:\grafana\data\grafana.db` bị khóa bởi tiến trình treo hoặc bị mất quyền ghi.
* **Cách xử lý:**
  - Dừng Grafana bằng `deploy\monitoring\stop-monitoring.ps1`.
  - Kiểm tra phân quyền tại thư mục `C:\grafana\data`.
  - Khởi động lại bằng `deploy\monitoring\start-monitoring.ps1`.

---

## 6. Các chỉ số được hiển thị trên Dashboard

Dashboard **“POS Store – Giám sát ứng dụng”** được cấu hình tự động gồm các panel:
1. **Trạng thái Target pos_store:** Hiển thị `UP` (màu xanh) hoặc `DOWN` (màu đỏ).
2. **Số yêu cầu mỗi giây (RPS):** Tính toán từ metric Counter `http_requests_total`.
3. **Tỷ lệ phản hồi HTTP 5xx (%):** Cảnh báo khi có lỗi máy chủ nội bộ.
4. **Tỷ lệ yêu cầu hoàn thành trong 2 giây (%):** Đo tỷ lệ yêu cầu nằm trong bucket `<= 2s`.
5. **Thời gian phản hồi p95 (giây):** Tính từ Histogram `http_request_duration_seconds` với đơn vị giây.
6. **Lưu lượng yêu cầu HTTP theo thời gian (RPS):** Phân tích mã trạng thái (2xx, 4xx, 5xx).
7. **Bộ nhớ tiến trình Node.js:** Biểu đồ Resident Memory (RSS), Heap Used, Heap Total.
8. **Tỷ lệ sử dụng CPU (%):** Tính từ `process_cpu_seconds_total` của tiến trình Node.js.

> **Lưu ý nghiệp vụ:**
> - Hai panel **Tỷ lệ lỗi 5xx** và **Tỷ lệ hoàn thành <= 2s** hiển thị chuỗi **`Chưa có dữ liệu` trên nền xám** khi hệ thống không có lưu lượng, bảo đảm không tạo báo động giả.
> - Dashboard này phản ánh các chỉ số vận hành thực tế của ứng dụng; **không coi biểu đồ này là bằng chứng đạt mục tiêu 10 người dùng đồng thời**. Các bài kiểm thử tải định lượng được thực hiện riêng bằng kịch bản chuyên biệt.
