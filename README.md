# Hệ thống Quản lý Cửa hàng POS (POS Store)

Ứng dụng POS Store đã được hoàn thiện chức năng và chuyển đổi sang kiến trúc container hóa toàn diện với **Docker Compose**, bảo toàn 100% chức năng nghiệp vụ, giám sát Prometheus/Grafana và thu thập log tập trung Loki/Grafana Alloy.

---

## 1. Môi trường Docker Compose

Toàn bộ hệ sinh thái dịch vụ được đóng gói trong `compose.yaml` với 8 container chuyên biệt, mạng nội bộ cô lập `pos_store_network` và 7 volume bền vững:

| Dịch vụ | Tên Container | Phiên bản Image | Cổng Container | Cổng Host (127.0.0.1) | Mục đích |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Nginx** | `pos-store-nginx` | `nginx:1.27.2-alpine` | `80` | `8080` | Reverse Proxy, chuyển tiếp backend, ghi access log kèm `req_id` |
| **Node.js App** | `pos-store-app` | `pos-store-app:1.0.0` (base `node:20.18.0-alpine`) | `3000`, `9101` | `3000`, `9101` | Backend Express, API, phục vụ Prometheus metrics endpoint độc lập |
| **MySQL** | `pos-store-mysql` | `mysql:8.0.40` | `3306` | `3307` | Cơ sở dữ liệu chính (dùng cổng 3307 để tránh xung đột MySQL Windows 3306) |
| **phpMyAdmin** | `pos-store-phpmyadmin` | `phpmyadmin:5.2.1` | `80` | `8081` | Giao diện quản trị CSDL MySQL trực quan |
| **Prometheus** | `pos-store-prometheus` | `prom/prometheus:v2.54.1` | `9090` | `9090` | Thu thập metrics từ `app:9101/metrics` mỗi 15s |
| **Grafana** | `pos-store-grafana` | `grafana/grafana:11.3.0` | `3000` | `3001` | Dashboard trực quan hóa chỉ số hệ thống và tra cứu log |
| **Loki** | `pos-store-loki` | `grafana/loki:3.2.1` | `3100` | `3100` | Lưu trữ log tập trung từ Node.js backend và Nginx proxy |
| **Grafana Alloy** | `pos-store-alloy` | `grafana/alloy:v1.4.3` | `12345` | `12345` | Thu thập file log thực tế (`app.log`, `pos_access.log`) đẩy về Loki |

---

## 2. Hướng dẫn Cài đặt & Khởi động Docker

### 2.1. Yêu cầu tiên quyết
- Docker Desktop đã bật WSL2 backend.
- Docker Compose v2+ (`docker compose version`).

### 2.2. Cấu hình file môi trường `.env`
Sao chép cấu hình mẫu từ `.env.example`:
```bash
cp .env.example .env
```
Các tham số mặc định đã được cấu hình sẵn sàng cho Docker Compose (tự động kết nối `mysql:3306` nội bộ, cổng host `8080`, `3000`, `9101`, `8081`, `3307`, `9090`, `3001`, `3100`, `12345`).

### 2.3. Khởi động hệ thống
```bash
# Build image và khởi chạy toàn bộ 8 containers ở chế độ chạy ngầm
docker compose up -d

# Kiểm tra trạng thái sức khỏe (health status) của các container
docker compose ps
```
Khi khởi chạy lần đầu, container MySQL sẽ tự động nạp bản sao lưu dữ liệu `database/backups/pos_store_backup.sql` vào volume `pos_store_mysql_data`.

### 2.4. Truy cập các dịch vụ
- **Website POS Store (qua Nginx Proxy):** [http://127.0.0.1:8080](http://127.0.0.1:8080)
  - Tài khoản Quản lý: `manager` / Mật khẩu: `29072907`
- **Backend Node.js trực tiếp:** [http://127.0.0.1:3000](http://127.0.0.1:3000)
- **Metrics Prometheus:** [http://127.0.0.1:9101/metrics](http://127.0.0.1:9101/metrics)
- **phpMyAdmin:** [http://127.0.0.1:8081](http://127.0.0.1:8081)
  - Máy chủ: `mysql` | Tên người dùng: `pos_app` | Mật khẩu: `290729`
- **Prometheus Dashboard & Targets:** [http://127.0.0.1:9090](http://127.0.0.1:9090)
  - Kiểm tra target: `http://127.0.0.1:9090/targets` (target `pos_store` trạng thái **UP**)
- **Grafana Dashboard:** [http://127.0.0.1:3001](http://127.0.0.1:3001)
  - Đăng nhập: `admin` / `admin`
  - Dashboard đã được nạp sẵn tại thư mục: **POS Store -> POS Store - Giám sát ứng dụng**
  - Datasource tự động cấu hình: `Prometheus` (mặc định) và `Loki`
- **Grafana Alloy UI:** [http://127.0.0.1:12345](http://127.0.0.1:12345)

---

## 3. Quản lý Dữ liệu & Bản sao lưu (Backup / Restore)

### 3.1. Dữ liệu bền vững (Persistent Volumes)
Hệ thống sử dụng các named volume độc lập, không bị mất dữ liệu khi restart hoặc stop container:
- `pos_store_mysql_data`: Dữ liệu CSDL MySQL.
- `pos_store_grafana_data`: Cấu hình, người dùng và tùy biến Grafana.
- `pos_store_prometheus_data`: Chuỗi dữ liệu số liệu lịch sử TSDB.
- `pos_store_loki_data`: Chunks và index nhật ký log.
- `pos_store_alloy_data`: Trạng thái con trỏ đọc log (positions offset).
- `pos_store_app_logs`: Thư mục chia sẻ log giữa Node.js backend và Alloy.
- `pos_store_nginx_logs`: Thư mục chia sẻ access/error log giữa Nginx và Alloy.

### 3.2. Nhập thủ công bản sao lưu vào CSDL Docker
Nếu cần nạp lại bản sao lưu khác vào container MySQL:
```bash
docker compose exec -T mysql mysql -u pos_app -p290729 pos_store < database/backups/pos_store_backup.sql
```

### 3.3. Xuất bản sao lưu mới từ CSDL Docker
```bash
docker compose exec -T mysql mysqldump -u pos_app -p290729 --no-tablespaces --single-transaction --quick --skip-lock-tables pos_store > database/backups/pos_store_new_backup.sql
```

---

## 4. Vận hành & Xem Log

### 4.1. Mở và dừng hệ thống
```bash
# Khởi động dịch vụ
docker compose up -d

# Khởi động lại dịch vụ
docker compose restart

# Tạm dừng các container (giữ nguyên container và network)
docker compose stop

# Dừng an toàn và gỡ bỏ container nhưng BẢO TOÀN NGUYÊN VẸN dữ liệu volumes
docker compose down
```

> [!CAUTION]
> **CẢNH BÁO MẤT DỮ LIỆU**: Lệnh `docker compose down -v` sẽ **XÓA TOÀN BỘ VOLUME DỮ LIỆU** (bao gồm toàn bộ database MySQL, log Loki, metrics Prometheus và dashboard Grafana). **TUYỆT ĐỐI KHÔNG SỬ DỤNG** cờ `-v` trong quy trình vận hành thông thường!

### 4.2. Xem Log thời gian thực từ CLI
```bash
# Xem log toàn bộ hệ thống
docker compose logs -f

# Xem log riêng ứng dụng Node.js
docker compose logs -f app

# Xem log Nginx Reverse Proxy
docker compose logs -f nginx

# Xem log Grafana Alloy
docker compose logs -f alloy
```

### 4.3. Truy vấn Log tương quan bằng LogQL trên Grafana Explore
Mỗi request đi qua hệ thống đều được cấp mã `requestId` xuyên suốt. Bạn có thể mở Grafana Explore (`http://127.0.0.1:3001/explore`), chọn datasource `Loki`:
```logql
# 1. Xem tất cả log ứng dụng Node.js:
{app="pos_store", source="node_backend"}

# 2. Xem access log của Nginx:
{app="pos_store", source="nginx_access"}

# 3. Đối chiếu cả hai nguồn log theo một requestId cụ thể:
{app="pos_store"} |= "8c5d678b-443a-4ee2-bf24-107782299796"
```

---

## 5. Hướng dẫn Quay lại Chạy Trực tiếp trên Windows (Rollback)

Bản cài đặt trực tiếp trên Windows hoàn toàn được bảo toàn và không bị thay đổi logic nghiệp vụ:

1. **Dừng môi trường Docker:**
   ```bash
   docker compose down
   ```
2. **Khôi phục cấu hình file `.env` chạy trực tiếp:**
   Đảm bảo các biến kết nối trỏ về MySQL Windows:
   ```env
   PORT=3000
   HOST=127.0.0.1
   DB_HOST=127.0.0.1
   DB_PORT=3306
   DB_USER=pos_app
   DB_PASSWORD=290729
   DB_NAME=pos_store
   METRICS_PORT=9101
   METRICS_HOST=127.0.0.1
   ```
3. **Khởi động ứng dụng Node.js:**
   ```bash
   npm start
   ```
4. **Khởi động giám sát / logging trên Windows (nếu cần):**
   - Giám sát: Chạy script `deploy/monitoring/start-monitoring.ps1`
   - Thu thập log: Chạy script `deploy/logging/start-logging.ps1`
   - Nginx Windows: `deploy/nginx/start_nginx.ps1`
   - phpMyAdmin Windows: `deploy/phpmyadmin/start-phpmyadmin.ps1`

---

## 6. Các chức năng nghiệp vụ của Website POS Store

### A. Đăng nhập, Đăng xuất, Phân quyền
- Cấu hình session với `express-session` và `express-mysql-session`.
- Mật khẩu băm an toàn bằng `bcryptjs`.
- Phân quyền MANAGER và CASHIER thông qua middleware `requireRole`.
- Tái tạo session ID khi đăng nhập để tránh lỗ hổng Session Fixation.
- Bảo vệ CSRF thông qua kiểm tra HTTP Header `Origin` cho các POST/PUT/DELETE request.
- Giới hạn số lần thử đăng nhập sai (rate limiting trong bộ nhớ).

### B. Sản phẩm và Tài khoản nhân viên
- CRUD sản phẩm với tồn kho khởi tạo = 0.
- Không cho phép cập nhật trực tiếp `stock_quantity`.
- CRUD tài khoản nhân viên. Không thể tự xóa quyền MANAGER của chính mình.
- Bảo vệ quản lý cuối cùng bằng cơ chế khóa transaction an toàn.

### C. Nhập hàng (Stock Receipts)
- API `POST /api/stock-receipts` chỉ định riêng cho MANAGER.
- Gộp các sản phẩm trùng khi nhập.
- Chống gửi 2 yêu cầu trùng bằng `request_key` và `request_hash` (với ràng buộc Unique ở Database).
- Cập nhật tồn kho và tạo bản ghi lịch sử vào `stock_movements`.
- Thực thi trong 1 `transaction`, Rollback nếu lỗi.

### D. Bán hàng và Hóa đơn (Sales & Invoices)
- Xử lý transaction an toàn, bảo vệ bằng `SELECT ... FOR UPDATE` tránh lỗi khi hai đơn được xử lý đồng thời.
- Khóa giới hạn: Nếu `stock_quantity < quantity`, giao dịch bị rollback.
- Xác thực giá thay đổi: Nếu Client gửi `expected_price` không khớp với giá `sale_price` trong DB, API trả về HTTP 409 buộc Client xác nhận.
- Hỗ trợ thanh toán tiền mặt và chuyển khoản mã VietQR tự động.

### E. Tồn kho và Lịch sử biến động
- API lấy chi tiết tồn kho (`/api/inventory`) và lịch sử (`/api/inventory/:id/movements`).

### F. Bộ kiểm thử tích hợp toàn diện (`npm test`)
- 57/57 tests PASS với Node native test runner (`node --test`).
