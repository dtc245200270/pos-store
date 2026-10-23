# HỆ THỐNG GIÁM SÁT NHẬT KÝ (LOGGING) POS STORE: LOKI + GRAFANA ALLOY

Tài liệu hướng dẫn vận hành, kiến trúc và tra cứu truy vấn LogQL cho hệ thống POS Store trên môi trường Windows.

---

## 1. PHIÊN BẢN & NGUỒN TẢI CHÍNH THỨC

Hệ thống sử dụng các bản phát hành ổn định (Stable Release) chính thức dành cho Windows x64 từ Grafana Labs:

- **Grafana Loki**: `v3.7.8` (Commit/Revision: `09e6ce2f`, `windows/amd64`)
  - Nguồn tải: `https://github.com/grafana/loki/releases/download/v3.7.8/loki-windows-amd64.exe.zip`
  - Vị trí cài đặt: `C:\loki\loki.exe`
  - Thư mục dữ liệu: `C:\loki\data` (TSDB v13 + Chunk filesystem)
- **Grafana Alloy**: `v1.20.1` (Commit/Revision: `95e12cf`, `windows/amd64`)
  - Nguồn tải: `https://github.com/grafana/alloy/releases/download/v1.20.1/alloy-windows-amd64.zip`
  - Vị trí cài đặt: `C:\alloy\alloy.exe`
  - Thư mục dữ liệu: `C:\alloy\data` (Lưu vị trí offset đọc file bền vững)

Các thành phần giám sát liên quan giữ nguyên hiện trạng:
- **Prometheus**: `v3.2.1` (`127.0.0.1:9090`, Datasource mặc định)
- **Grafana Server**: `v11.5.2` (`127.0.0.1:3030`)
- **Nginx Reverse Proxy**: `1.29.1` (`127.0.0.1:8080`)
- **Node.js Core Backend**: `v26.8.2` (PID duy nhất, Metrics: `127.0.0.1:9101`)

---

## 2. BẢN ĐỒ CỔNG MẠNG (PORT MAPPING)

| Thành phần | Địa chỉ lắng nghe | Giao thức / Mục đích |
| :--- | :--- | :--- |
| **Loki** | `127.0.0.1:3100` | HTTP Ingestion (`/loki/api/v1/push`), Readiness (`/ready`), Query API |
| **Grafana Alloy** | `127.0.0.1:12345` | HTTP Debug UI, Component Graph & Metrics |
| **Grafana Server** | `127.0.0.1:3030` | Web UI & Dashboards (Loki + Prometheus datasources) |
| **Prometheus** | `127.0.0.1:9090` | Time-series Metrics Scraper & Storage (Default datasource) |
| **Node.js Backend** | `127.0.0.1:3000` | Ứng dụng POS Store Core REST API |
| **Node.js Metrics** | `127.0.0.1:9101` | Endpoint `/metrics` cho Prometheus |
| **Nginx Proxy** | `127.0.0.1:8080` | Reverse Proxy đưa traffic vào Backend & ghi Access/Error logs |

---

## 3. THIẾT KẾ NGUỒN LOG & ĐÍNH CHÍNH CƠ CHẾ LOGGER THEO MÃ THỰC TẾ

### 3.1. Node.js Backend Logging (`logs/app.log`)
- **Vị trí**: `C:\Users\Dell Precision 5550\Documents\pos-store\logs\app.log`
- **Định dạng**: JSON 1 dòng/log (ndjson), mã hóa chuẩn **UTF-8**.
- **Cơ chế lọc dữ liệu nhạy cảm thực tế (`config/logger.js`)**:
  Hàm `sanitizeData(data)` duyệt qua các thuộc tính của đối tượng và đối chiếu với tập hợp `SENSITIVE_KEYS` gồm:
  `password`, `password_hash`, `passwordhash`, `current_password`, `new_password`, `confirm_password`, `pass`, `token`, `csrftoken`, `x-csrf-token`, `cookie`, `connect.sid`, `session`, `sessionid`, `authorization`, `secret`, `session_secret`, `connectionstring`, `sql`, `query`, `parameters`, `params`, `db_password`, `root_password`.
  *Khi phát hiện khóa nhạy cảm, hàm thực hiện lệnh `continue` để **bỏ qua hoàn toàn thuộc tính đó***, không đưa dữ liệu nhạy cảm vào chuỗi JSON ghi log (chứ không thay thế bằng chuỗi giả lập).
- **Tương thích `X-Request-ID`**:
  Middleware `middleware/request-id.js` tiếp nhận header `x-request-id` từ Nginx hoặc tự sinh `crypto.randomUUID()`. Thuộc tính `requestId` được đưa vào log JSON của mọi HTTP request và trả về trong header phản hồi `X-Request-ID`.

### 3.2. Nginx Logs
- **Access Log**: `C:\nginx\logs\access.log`
  Cấu hình log_format `main` ghi nhận trường `req_id="$upstream_http_x_request_id"` cùng thời gian xử lý `rt="$request_time"`, phương thức, đường dẫn và mã trạng thái.
- **Error Log**: `C:\nginx\logs\error.log`

---

## 4. CHIẾN LƯỢC GẮN NHÃN (LABEL DESIGN) - CHỐNG BÙNG NỔ CARDINALITY

Để tối ưu hóa hiệu năng TSDB của Loki và tuân thủ nguyên tắc không tạo chỉ mục độ phân tán cao:
- **Nhãn Stream (Indexed Labels)**:
  - `app = "pos_store"` (Định danh hệ thống)
  - `env = "development"` (Môi trường)
  - `source = "node_backend" | "nginx_access" | "nginx_error"` (Nguồn phát sinh)
- **Dữ liệu động (Payload Only - Non-indexed)**:
  - Tuyệt đối **không** tạo nhãn index cho: `requestId`, `userId`, dynamic URL, `ipAddress`.
  - Các thông tin này được lưu trong nội dung log và truy vấn thông qua bộ lọc LogQL (`|=`, `| json`, `| pattern`).

---

## 5. HƯỚNG DẪN KHỞI ĐỘNG VÀ DỪNG HỆ THỐNG CÓ XÁC MINH DANH TÍNH TIẾN TRÌNH

Nhằm đảm bảo an toàn tuyệt đối và tránh nhầm lẫn tiến trình trong môi trường Windows, toàn bộ logic nhận diện tiến trình được quy về hàm dùng chung `deploy/logging/ProcessIdentity.ps1`:
- **Nguyên tắc nhận diện (`Test-IsTargetLoggingProcess`)**:
  - Yêu cầu **đồng thời** cả hai điều kiện (`AND`, tuyệt đối **không** dùng `OR` giữa executable, tên config và số cổng):
    1. `ExecutablePath` chuẩn hóa khớp chính xác đường dẫn Loki (`C:\loki\loki.exe`) hoặc Alloy (`C:\alloy\alloy.exe`) dự kiến.
    2. Đường dẫn config thực tế trong `CommandLine` khớp chính xác đường dẫn file config POS Store (`C:\loki\loki.yml` hoặc `C:\alloy\config.alloy`).
  - **Không** so sánh bằng tên file chung chung (`loki.yml`, `config.alloy`) và **không** so sánh chỉ bằng số cổng (3100, 12345).
  - Hỗ trợ đầy đủ đường dẫn chứa khoảng trắng, được bao bằng dấu ngoặc kép hoặc các ký tự phân tách token chuẩn.

### 5.1. Khởi động hệ thống Logging (`start-logging.ps1`)
```powershell
powershell -ExecutionPolicy Bypass -File deploy\logging\start-logging.ps1
```
*Cơ chế kiểm soát chặt chẽ:*
1. Kiểm tra sự tồn tại của `loki.exe` và `alloy.exe`.
2. Đồng bộ file cấu hình `loki.yml` và `config.alloy` từ repo ra đĩa.
3. Chạy `loki.exe -verify-config` và `alloy.exe validate` để xác thực cú pháp trước khi chạy.
4. **Kiểm tra cổng và xung đột danh tính (`Assert-PortAvailableOrTargetIdentity`)**:
   - Nếu cổng 3100 hoặc 12345 đang bị chiếm bởi một tiến trình **không đúng danh tính POS Store** -> **Báo xung đột ngay lập tức và thoát với mã lỗi khác 0 (`exit 1`)**, kể cả khi cổng đó phản hồi HTTP trả về 200.
5. Nếu chưa có tiến trình nào, khởi động Loki & Alloy dạng background process.
6. **Nhánh chạy sẵn**: Nếu tiến trình chiếm cổng **đúng danh tính POS Store**, bắt buộc kiểm tra sức khỏe HTTP (Loki `/ready` HTTP 200 `ready`, Alloy UI HTTP 200) trước khi thông báo sẵn sàng.

### 5.2. Dừng an toàn hệ thống Logging (`stop-logging.ps1`)
```powershell
powershell -ExecutionPolicy Bypass -File deploy\logging\stop-logging.ps1
```
*Cơ chế kiểm soát chặt chẽ:*
1. Xác minh danh tính từng tiến trình chiếm cổng hoặc có tên `alloy.exe`/`loki.exe` qua `Test-IsTargetLoggingProcess`.
2. **Bỏ qua tiến trình không đúng danh tính**: Tuyệt đối không can thiệp, không dừng nhầm các tiến trình khác của hệ thống hoặc tiến trình lạ chiếm cổng.
3. **Dừng tiến trình mục tiêu**: Chỉ gửi tín hiệu dừng tới các PID đích đã được xác minh đúng danh tính POS Store.
4. **Chỉ báo đã dừng khi thỏa mãn đồng thời**:
   - Mọi PID đích đã kết thúc hoàn toàn (`Get-Process -Id` trả về rỗng).
   - Cổng tương ứng (12345 / 3100) đã được giải phóng (`Get-NetTCPConnection` không còn lắng nghe).
   - Nếu PID chưa kết thúc hoặc cổng chưa giải phóng sau thời gian chờ -> Báo thất bại và thoát với mã lỗi khác 0 (`exit 1`).

---

## 6. CẤU HÌNH DATASOURCE LOKI TRÊN GRAFANA

- **Provisioning file**: `C:\grafana\conf\provisioning\datasources\loki.yaml`
- **Datasource Settings**:
  - `name`: `Loki`
  - `uid`: `loki-pos-store`
  - `type`: `loki`
  - `access`: `proxy`
  - `url`: `http://127.0.0.1:3100`
  - `isDefault`: `false` (Giữ nguyên `Prometheus` làm default)
- **Kiểm tra sức khỏe datasource**:
  ```powershell
  Invoke-RestMethod -Uri "http://127.0.0.1:3030/api/datasources/uid/loki-pos-store/health" -Headers @{ Authorization = "Basic " + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("admin:admin")) }
  # Kết quả: { "status": "OK", "message": "Data source successfully connected." }
  ```

---

## 7. CẨM NANG TRUY VẤN LOGQL THỰC HÀNH

### 7.1. Xem log Node.js Backend
```logql
{app="pos_store", source="node_backend"}
```

### 7.2. Xem log Nginx Access
```logql
{app="pos_store", source="nginx_access"}
```

### 7.3. Xem log Nginx Error
```logql
{app="pos_store", source="nginx_error"}
```

### 7.4. Đối chiếu log Node.js và Nginx theo Request ID
```logql
{app="pos_store"} |= "889fee1f-bab2-48c6-aee8-51d15495861d"
```
*Kết quả:* Trả về đồng thời cả dòng log JSON của Node.js Backend và dòng log access của Nginx, đồng nhất về method `GET`, path `/login`, status `200` và `requestId`.

### 7.5. Lọc các phản hồi lỗi (Status Code >= 400)

**Từ nguồn Node.js Backend (phân tích cú pháp JSON):**
```logql
{app="pos_store", source="node_backend"} | json | statusCode >= 400
```

**Từ nguồn Nginx Access (dùng biểu thức chính quy Regex):**
```logql
{app="pos_store", source="nginx_access"} |~ " (4[0-9]{2}|5[0-9]{2}) "
```

---

## 8. BỘ SCRIPT KIỂM THỬ TỰ ĐỘNG

1. **Kiểm tra cách ly trên chính script (Isolated Validation Test)**:
   ```powershell
   node scripts/test_verify_pipeline_isolated.js
   ```
   *Thực hiện:*
   - Ca Loki trả result rỗng `result: []` -> Bị từ chối, không ghi SUCCESS.
   - Ca Loki HTTP/API lỗi (status error hoặc HTTP 500) -> Bị từ chối.
   - Ca log hai nguồn khớp nhau nhưng sai request đã gửi (sai requestId, sai method, sai status, sai path) -> Bị từ chối.

2. **Kiểm tra đường ống log thực tế (End-to-End Pipeline & Persistence)**:
   ```powershell
   node scripts/verify_logging_pipeline.js
   ```
   *Thực hiện:*
   - Polling có timeout kiểm tra 3 request `GET /login`.
   - Đối chiếu từng log với chính request đã gửi (requestId, GET, /login, status 200).
   - Ca 404 thực tế: Truy cập `/api/products/99999999` trả về đúng HTTP 404 thật, đối chiếu đúng `requestId` mới sinh trên cả hai nguồn và trong truy vấn `>= 400`.
   - Kiểm tra persistence: Tạo request trước restart, lưu requestId và khoảng thời gian nano cố định. Restart Loki & Alloy. Sau restart xác nhận đúng log cũ trên cả 2 nguồn và xác nhận request mới tiếp tục được thu thập.
   - Toàn bộ kết quả lưu vào `deploy/logging/artifacts/loki_query_verification.json` (chỉ ghi `SUCCESS` khi mọi assertion đạt).

3. **Chụp ảnh giao diện Grafana Explore**:
   ```powershell
   node scripts/capture_grafana_explore.js
   ```
   *Thực hiện:*
   - Tự động xác thực vào Grafana API, mở giao diện Explore truy vấn `{app="pos_store"}` bằng Edge headless CDP.
   - Lưu ảnh chụp tại `deploy/logging/artifacts/grafana_explore_loki.png`.

4. **Kiểm tra cách ly hàm nhận diện tiến trình (Isolated Process Identity Test)**:
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts/test_process_identity_isolated.ps1
   ```
   *Thực hiện:*
   - Đúng executable nhưng config khác: Từ chối (`$false`).
   - Executable khác nhưng cùng tên file config (`loki.yml`, `config.alloy`): Từ chối (`$false`).
   - Chỉ trùng số cổng trong CommandLine (`3100`, `12345`): Từ chối (`$false`).
   - Đúng executable và đường dẫn config có khoảng trắng: Chấp nhận (`$true`).
   - Cấu hình thực tế POS Store: Chấp nhận (`$true`).
   - Xác minh xung đột: Tiến trình chiếm cổng không đúng danh tính bị ném lỗi xung đột `XUNG DOT: ...` và `start-logging.ps1` exit khác 0 kể cả khi HTTP trả 200.
   - Xác minh `stop-logging`: Bỏ qua tiến trình không đúng danh tính, chỉ báo đã dừng khi PID đích kết thúc và cổng được giải phóng.
