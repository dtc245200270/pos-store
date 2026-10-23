# BÁO CÁO VÀ TÀI LIỆU HARDENING HỆ THỐNG POS STORE (DOCKER COMPOSE)

Phục vụ môn học: **Triển khai và Quản trị Hệ thống Phần mềm**  
Hệ thống: **POS Store - Hệ thống Quản lý Bán hàng Cửa hàng Bán lẻ**  
Kiến trúc: **Docker Compose (8 Containers: Nginx, Node.js App, MySQL, phpMyAdmin, Prometheus, Loki, Grafana, Grafana Alloy)**  
Ngày thực hiện: **23/10/2026**

---

## 1. TỔNG QUAN NGUYÊN TẮC HARDENING

Quá trình rà soát và hoàn thiện Hardening tuân thủ nghiêm ngặt 4 nguyên tắc kỹ thuật:
1. **Kiểm chứng bằng dữ liệu runtime thực tế**: Mọi kết luận đều xuất phát từ kiểm tra trực tiếp qua Nginx (cổng 8080), quy trình kết nối MySQL, phân quyền container và header phản hồi HTTP; không suy đoán lý thuyết.
2. **Phân loại rõ ràng 4 trạng thái**: Đã có (Present & Verified), Thiếu (Missing), Cấu hình sai/thừa (Misconfigured/Excess), Chưa kiểm chứng (Unverified).
3. **Can thiệp tối thiểu, đúng đích**: Chỉ sửa đổi những điểm thiếu hoặc sai có bằng chứng rõ ràng; giữ nguyên vẹn cơ chế bảo vệ tài khoản hệ thống `manager`, toàn bộ chức năng nghiệp vụ POS, giao diện bán hàng, biểu đồ Grafana và pipeline logging/metrics.
4. **Không tạo rủi ro dữ liệu**: Kiểm thử trong môi trường cách ly (tài khoản probe độc lập); không tạo hóa đơn rác hoặc thay đổi số liệu bán hàng thật; không kích hoạt các tính năng gây hỏng kết nối môi trường phát triển (như HSTS khi chưa có HTTPS).

---

## 2. BẢNG TỔNG HỢP TRƯỚC VÀ SAU KHI HOÀN THIỆN HARDENING

| Hạng mục | Hiện trạng phát hiện ban đầu | Bằng chứng kiểm tra thực tế | Biện pháp xử lý / Hoàn thiện | Kết quả sau kiểm chứng |
| :--- | :--- | :--- | :--- | :--- |
| **1. Header Server & X-Powered-By** | Lộ chính xác phiên bản Nginx (`nginx/1.27.2`) và framework backend (`Express`). | `curl -i http://127.0.0.1:8080/login`<br>Thấy: `Server: nginx/1.27.2`<br>`X-Powered-By: Express` | - Bật `server_tokens off;` trong block `http` của Nginx.<br>- Thêm `app.disable('x-powered-by')` trong `server.js` và `proxy_hide_header X-Powered-By;` trong Nginx. | `Server: nginx`<br>Header `X-Powered-By` biến mất hoàn toàn. |
| **2. Header Cache-Control bị trùng lặp** | Trùng 2 dòng `Cache-Control` trái ngược: `public, max-age=0` (từ Express) và `no-store, no-cache...` (từ Nginx). | `curl -i http://127.0.0.1:8080/login`<br>Xuất hiện 2 header `Cache-Control` liên tiếp trong response. | Thêm `proxy_hide_header Cache-Control;` trong `location /` của Nginx để Nginx làm đầu mối chuẩn hóa duy nhất. | Chỉ còn duy nhất 1 header `Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0`. |
| **3. MIME Sniffing & Frame Embedding** | Thiếu bảo vệ chống MIME-sniffing và Clickjacking. | Không có `X-Content-Type-Options` và `X-Frame-Options` trong response header. | Thêm `add_header X-Content-Type-Options "nosniff" always;`<br>Thêm `add_header X-Frame-Options "SAMEORIGIN" always;`. | Trả về `nosniff` và `SAMEORIGIN` trên mọi endpoint. |
| **4. Referrer Policy** | Thiếu chính sách Referrer phù hợp. | Không có `Referrer-Policy`. | Thêm `add_header Referrer-Policy "strict-origin-when-cross-origin" always;`. | Trả về `strict-origin-when-cross-origin`. |
| **5. Content Security Policy (CSP)** | Chưa cấu hình CSP, có nguy cơ XSS hoặc nhúng script độc hại ngoài kiểm soát. | Header `Content-Security-Policy` chưa tồn tại trong phản hồi. | Xây dựng CSP chặt chẽ dựa trên tài nguyên thực tế của dự án: Bootstrap CSS/JS, Bootstrap Icons từ `cdn.jsdelivr.net`, mã QR thanh toán VietQR từ `img.vietqr.io`, script/style nội bộ POS Store. | CSP hoạt động đúng, không gây lỗi giao diện, Bootstrap hay VietQR. |
| **6. HSTS** | HSTS không được kích hoạt khi chưa có HTTPS. | Không có `Strict-Transport-Security`. | Giữ nguyên: **Chưa bật HSTS** vì dự án đang chạy HTTP trên localhost. Tránh nguy cơ khóa trình duyệt không thể truy cập HTTP. | Tuân thủ chính xác yêu cầu. |
| **7. Trust Proxy Express** | Express chạy sau Nginx nhưng chưa cấu hình `trust proxy`. | Trong `server.js` thiếu khai báo `app.set('trust proxy')`. | Thêm `app.set('trust proxy', 1);` trước khi khởi tạo session middleware. | Express nhận diện chính xác 1 hop proxy Nginx và IP khách qua `X-Forwarded-For`. |
| **8. Session Cookie Secure** | Thuộc tính `secure` bị gán cứng `false`. | `cookie: { secure: false }` trong `server.js`. | Chuyển sang cơ chế linh hoạt: `secure: process.env.COOKIE_SECURE === 'true' ? true : (process.env.COOKIE_SECURE === 'false' ? false : 'auto')`. | Thích ứng tự động: Giữ `secure: false` trên HTTP localhost, tự động bật `secure: true` nếu chạy sau reverse proxy HTTPS. |
| **9. Quyền MySQL User `pos_app`** | Tài khoản ứng dụng `pos_app` được cấp `ALL PRIVILEGES` trên database `pos_store`, có thừa quyền phá hủy cấu trúc (DROP, CREATE, ALTER...). | `SHOW GRANTS FOR 'pos_app'@'%';`<br>Thấy: `GRANT ALL PRIVILEGES ON pos_store.*` | Áp dụng Principle of Least Privilege: Thu hồi `ALL PRIVILEGES`, chỉ cấp `SELECT, INSERT, UPDATE, DELETE` trên `pos_store.*`. Cập nhật vào cuối `database/init/01_init_schema.sql`. Giữ nguyên quyền `root` cho quản trị. | `pos_app` chỉ có `SELECT, INSERT, UPDATE, DELETE`. Các truy vấn `CREATE TABLE` hoặc `DROP TABLE` từ app bị MySQL từ chối (ER_TABLEACCESS_DENIED_ERROR). |
| **10. File nhạy cảm trong `.dockerignore`** | Thư mục backup CSDL và file `.bak` chưa được loại trừ tường minh trong `.dockerignore`. | Kiểm tra `.dockerignore` thiếu `database/backups` và `*.bak`. | Bổ sung `database/backups`, `*.bak`, `*.log` vào `.dockerignore`. | Loại trừ hoàn toàn nguy cơ vô tình đóng gói backup/credentials vào image. |
| **11. Giới hạn đăng nhập sai** | Đã có cơ chế rate limiting nhưng cần kiểm chứng độ tin cậy. | `routes/auth.js` chứa Map `accountLoginAttempts` (5 lần sai, khóa 15 phút, trả về HTTP 429). | Giữ nguyên cơ chế, kiểm chứng bằng tài khoản probe độc lập `isolated_lockout_probe_*`. | Đạt chuẩn: Lần thử thứ 5/6 sai trả về 429 và `Retry-After: 900`. Đăng nhập thành công tự xóa bộ đếm. |
| **12. Chống Session Fixation & CSRF** | Đã có nhưng cần xác minh runtime. | `req.session.regenerate()` sau login, `req.session.destroy()` khi logout; `csrfProtection` trên mọi mutating route. | Kiểm chứng bằng script tự động: POST không token bị 403, Session ID thay đổi sau login, logout xóa cookie và vô hiệu phiên. | Đạt 100% mục tiêu kiểm chứng. |

---

## 3. CHI TIẾT CÁC HẠNG MỤC HARDENING ĐÃ THỰC HIỆN

### 3.1. Security Headers & Che giấu Dấu vết Công nghệ
Cấu hình tại `deploy/docker/nginx/nginx.conf` (và đồng bộ tại `deploy/nginx/nginx.conf`):
- `server_tokens off;`: Ẩn số phiên bản `1.27.2` của Nginx, chỉ còn `Server: nginx`.
- `app.disable('x-powered-by')` & `proxy_hide_header X-Powered-By;`: Ngăn chặn rò rỉ thông tin framework Express.
- `proxy_hide_header Cache-Control;` phối hợp `add_header Cache-Control`: Giải quyết dứt điểm xung đột duplicate header giữa Express `res.sendFile` và Nginx.
- `add_header X-Content-Type-Options "nosniff" always;`: Ngăn chặn trình duyệt đoán định sai MIME-type để thực thi mã độc.
- `add_header X-Frame-Options "SAMEORIGIN" always;`: Ngăn chặn trang bị lồng vào iframe trên tên miền lạ (Clickjacking).
- `add_header Referrer-Policy "strict-origin-when-cross-origin" always;`: Bảo vệ URL nội bộ không bị rò rỉ ra ngoài.
- `Content-Security-Policy`:
  ```
  default-src 'self';
  script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net;
  style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net;
  font-src 'self' https://cdn.jsdelivr.net data:;
  img-src 'self' data: https://img.vietqr.io;
  connect-src 'self';
  frame-ancestors 'self';
  base-uri 'self';
  form-action 'self';
  ```
  *Lưu ý an toàn nghiệp vụ*: CSP cho phép nạp tài nguyên cần thiết cho Bootstrap 5 (`cdn.jsdelivr.net`), mã QR thanh toán ngân hàng (`img.vietqr.io`), font biểu tượng và các script giao diện nội bộ của POS Store, tuyệt đối không làm đứt gãy luồng thu ngân hay hiển thị dashboard.

### 3.2. Bảo vệ Đăng nhập, Session và CSRF
- **Trust Proxy**: Cấu hình `app.set('trust proxy', 1)` trong `server.js`. Đảm bảo Express nhận đúng client IP từ header `X-Forwarded-For` do Nginx gửi sang, phục vụ ghi nhận log và rate limiting chính xác.
- **Session Cookie**:
  - `httpOnly: true`: Chống tấn công XSS đánh cắp session ID qua `document.cookie`.
  - `sameSite: 'lax'`: Bảo vệ cookie không bị tự động gửi trong các cross-site request độc hại.
  - `maxAge: 86400000` (24 giờ): Thời hạn phiên hợp lý cho ca làm việc bán hàng.
  - `secure: 'auto'`: Tương thích mượt mà môi trường phát triển HTTP localhost (không làm mất session) đồng thời sẵn sàng bật cờ `Secure` nếu triển khai sau proxy HTTPS.
- **Tái tạo Session ID (Session Fixation Defense)**: Sử dụng `req.session.regenerate()` ngay sau khi xác thực mật khẩu thành công. Session ID mới được cấp phát độc lập với session ID trước khi đăng nhập.
- **Hủy phiên khi Đăng xuất & Đổi mật khẩu**: Khi đăng xuất, `req.session.destroy()` xóa bản ghi trong CSDL MySQL và gửi `Set-Cookie` hết hạn (`Expires=Thu, 01 Jan 1970 00:00:00 GMT`). Khi đổi mật khẩu, hệ thống xóa toàn bộ session ID cũ của tài khoản trong bảng `sessions` để ngắt các thiết bị khác.
- **CSRF Protection**: Middleware `csrfProtection` bảo vệ toàn diện các phương thức `POST`, `PUT`, `DELETE`, `PATCH`. Token được sinh ngẫu nhiên 32 bytes (`crypto.randomBytes(32).toString('hex')`), đính kèm qua header `X-CSRF-Token` thông qua wrapper `apiFetch` trong `public/js/auth.js`.
- **Bảo vệ tài khoản quản trị hệ thống `manager`**: Giữ nguyên cơ chế kiểm tra chặn sửa, khóa, xóa hoặc reset mật khẩu của tài khoản `manager` (đã hoàn thiện tại commit `22b69a8`).

### 3.3. Giới hạn Truy cập Hạ tầng & Mạng Container
- **Ràng buộc Port Localhost**: Toàn bộ 9 cổng công bố trong `compose.yaml` (8080, 8081, 3000, 3001, 3100, 3307, 9090, 9101, 12345) đều liên kết tiền tố `127.0.0.1:`. Đã kiểm chứng qua lệnh PowerShell `Get-NetTCPConnection`: 100% cổng đều ở trạng thái `Listen` trên `127.0.0.1`, không một dịch vụ nào mở ra toàn mạng (`0.0.0.0`).
- **Mạng nội bộ cô lập**: Sử dụng Docker bridge network `pos_store_network` để các container liên lạc nội bộ qua tên dịch vụ (`mysql:3306`, `app:3000`, `loki:3100`), không cần định tuyến qua host Windows.
- **Chính sách Firewall**: Giữ nguyên cấu hình mạng Windows; không can thiệp Windows Firewall.

### 3.4. Quyền Container và MySQL (Principle of Least Privilege)
- **Tiến trình App chạy Non-root**: Kiểm tra trực tiếp bên trong container `pos-store-app` xác nhận:
  - `whoami`: `node`
  - `id`: `uid=1000(node) gid=1000(node) groups=1000(node)`
  - `PID 1`: Chạy lệnh `node server.js` dưới quyền user `node`.
- **Quyền Container**: Tất cả 8 containers đều chạy với `Privileged=false`. Không container nào mount `/var/run/docker.sock`. Các volume cấu hình từ host (`nginx.conf`, `prometheus.yml`, `loki.yml`, `config.alloy`, dashboard) đều được mount ở chế độ Read-Only (`:ro`).
- **Hạ quyền MySQL `pos_app`**:
  - Ban đầu: `GRANT ALL PRIVILEGES ON pos_store.*` (thừa quyền nguy hiểm).
  - Sau khi hạ quyền:
    ```sql
    REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'pos_app'@'%';
    GRANT SELECT, INSERT, UPDATE, DELETE ON `pos_store`.* TO 'pos_app'@'%';
    FLUSH PRIVILEGES;
    ```
  - Kết quả kiểm chứng: `pos_app` thực thi bình thường các truy vấn SELECT, INSERT, UPDATE, DELETE; khi thử `CREATE TABLE` hoặc `DROP TABLE`, MySQL phản hồi ngay lỗi từ chối quyền `ER_TABLEACCESS_DENIED_ERROR`.
  - Tài khoản `root` được giữ nguyên vẹn để phục vụ phpMyAdmin, migration và bảo trì.

### 3.5. Bảo vệ Bí mật & Nhật ký
- **Bảo vệ biến môi trường**: Giữ nguyên mật khẩu mạnh trong `.env`. File `.env`, `.env.bak`, `cookies.txt`, `database/backups/`, `*.log` đều nằm trong `.gitignore` và không bị Git theo dõi.
- **Bổ sung `.dockerignore`**: Thêm `database/backups`, `*.bak`, `*.log` vào `.dockerignore` nhằm ngăn chặn tuyệt đối việc build context đưa các file nhạy cảm vào image.
- **Khử trùng dữ liệu Log (Log Sanitization)**: File `config/logger.js` trang bị hàm `sanitizeData` lọc bỏ 28 trường nhạy cảm (`password`, `password_hash`, `token`, `x-csrf-token`, `cookie`, `session_secret`, `db_password`...). Nginx access log chỉ lưu URL không query string, không ghi trường Referer nguyên văn, không ghi Authorization hay Cookie.

---

## 4. KẾT QUẢ BỘ KIỂM THỬ XÁC MINH HARDENING

Toàn bộ các tiêu chí hardening đã được kiểm chứng tự động thông qua script `scripts/test-hardening-verification.js` chạy trên runtime thực tế:

```
================================================================
HARDENING VERIFICATION SUITE - POS STORE (DOCKER COMPOSE)
================================================================

--- TEST 1: Security Headers on Port 8080 ---
[PASS] Server header does not expose Nginx version
[PASS] X-Powered-By header is stripped
[PASS] X-Content-Type-Options is nosniff
[PASS] X-Frame-Options is SAMEORIGIN
[PASS] Referrer-Policy is strict-origin-when-cross-origin
[PASS] Content-Security-Policy configured with actual resources (Bootstrap, VietQR, self)
[PASS] HSTS is NOT present on HTTP localhost (as required)
[PASS] Cache-Control is not duplicated in response headers

--- TEST 2: CSRF Protection ---
[PASS] POST /api/auth/login without CSRF token returns 403 Forbidden
[PASS] POST /api/auth/login with invalid CSRF token returns 403 Forbidden

--- TEST 3: Login Rate Limiting (Isolated Account Probe) ---
[PASS] Exceeding 5 failed login attempts triggers 429 Too Many Requests
[PASS] Rate limiting includes Retry-After header (> 0 seconds)

--- TEST 4: Login Flow & Session Security ---
[PASS] Manager login succeeds with 200 OK
[PASS] Session ID regenerated upon login (Session Fixation defense)
[PASS] Cookie has HttpOnly attribute
[PASS] Cookie has SameSite=Lax attribute
[PASS] Cookie has appropriate Secure attribute for HTTP localhost
[PASS] Authenticated /api/auth/me returns MANAGER role
[PASS] Authenticated access to dashboard (/) returns 200 OK

--- TEST 5: Logout Flow & Session Invalidation ---
[PASS] Logout succeeds with 200 OK
[PASS] Logout clears session cookie (Expires in past or Max-Age=0)
[PASS] Old session cookie rejected with 401 Unauthorized after logout

--- TEST 6: MySQL Privilege Hardening (Least Privilege) ---
[PASS] pos_app can execute SELECT queries
[PASS] pos_app is DENIED CREATE TABLE privileges
[PASS] pos_app is DENIED DROP TABLE privileges

================================================================
TOTAL TESTS: 25 | PASSED: 25 | FAILED: 0
================================================================
```

Đồng thời, kiểm tra truy cập 8 trang giao diện chính sau khi đăng nhập (`/`, `/products`, `/employees`, `/sales`, `/invoices`, `/stock-receipts`, `/inventory`, `/profile`) đều trả về **HTTP 200 OK**. Các chỉ số Prometheus (`http://127.0.0.1:9101/metrics`) và các panel Grafana tiếp tục hoạt động chính xác.

---

## 5. PHÂN TÍCH HIỆN TRẠNG HTTPS & ĐỀ XUẤT LỘ TRÌNH

### 5.1. Hiện trạng thực tế
- Hệ thống hiện tại đang phục vụ qua giao thức **HTTP** tại cổng `127.0.0.1:8080`.
- Chưa cấu hình khối `server { listen 443 ssl; }` trong Nginx và chưa có tệp chứng chỉ số (TLS Certificate & Private Key).
- Do chưa có yêu cầu bắt buộc và đầy đủ từ giảng viên, hệ thống **chưa kích hoạt HTTPS** và **chưa bật header HSTS** nhằm tránh rủi ro trình duyệt từ chối kết nối HTTP nội bộ localhost.

### 5.2. Giới hạn của HTTP Localhost
- Dữ liệu truyền giữa trình duyệt và Nginx trên máy host không được mã hóa TLS (mặc dù chỉ lưu thông trong phạm vi card loopback 127.0.0.1 của Windows).
- Trình duyệt hiển thị cảnh báo "Not Secure" trên thanh địa chỉ.
- Không thể tận dụng các tính năng mạng nâng cao như HTTP/2 multiplexing.

### 5.3. Đề xuất Lộ trình Triển khai HTTPS (Khi có yêu cầu)
1. **Môi trường Phát triển (Local Dev)**:
   - Sử dụng công cụ `mkcert` để tạo Certificate Authority (CA) cục bộ tin cậy trên Windows:
     ```bash
     mkcert -install
     mkcert localhost 127.0.0.1
     ```
   - Đặt file `localhost.pem` và `localhost-key.pem` vào thư mục `deploy/docker/nginx/ssl/` (mount `:ro` vào container Nginx).
2. **Cấu hình Nginx SSL**:
   - Mở thêm cổng `443` trong `compose.yaml` (bind `127.0.0.1:8443:443`).
   - Bổ sung cấu hình SSL chuẩn TLS 1.2 / TLS 1.3:
     ```nginx
     server {
         listen 443 ssl;
         server_name localhost;
         ssl_certificate /etc/nginx/ssl/localhost.pem;
         ssl_certificate_key /etc/nginx/ssl/localhost-key.pem;
         ssl_protocols TLSv1.2 TLSv1.3;
         ssl_ciphers HIGH:!aNULL:!MD5;
         ...
     }
     ```
3. **Môi trường Production**:
   - Sử dụng Reverse Proxy / Load Balancer (như Traefik, Cloudflare, hoặc Let's Encrypt Certbot) với cơ chế tự động cấp phát và gia hạn chứng chỉ SSL hợp lệ.
   - Khi chứng chỉ đã được xác thực tin cậy, kích hoạt header HSTS:
     `add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;`
   - Đặt biến môi trường `COOKIE_SECURE=true` trong file `.env`.

---

## 6. CÁC GIỚI HẠN THỰC TẾ & HẠNG MỤC CHƯA TRIỂN KHAI

Để đảm bảo tính trung thực học thuật và phản ánh đúng thực tế kỹ thuật, hệ thống ghi nhận rõ ràng các giới hạn sau (không tuyên bố "bảo mật tuyệt đối"):
1. **Lưu trữ Rate Limiting trong bộ nhớ (In-memory Map)**: Bộ đếm số lần đăng nhập sai `accountLoginAttempts` được lưu trong bộ nhớ tiến trình Node.js. Nếu container `pos-store-app` khởi động lại, bộ đếm này sẽ được làm mới. Trong hệ thống production phân tán đa container (clustering), cơ chế này cần được chuyển sang lưu trữ trên Redis tập trung.
2. **Các cổng quản trị phục vụ học tập**: Cổng MySQL `3307`, phpMyAdmin `8081` và Grafana `3001` đang mở trên localhost để phục vụ mục đích kiểm tra và chấm điểm đồ án. Trong môi trường production thực tế, cổng MySQL và phpMyAdmin cần được đóng hoàn toàn hoặc đặt sau VPN/IP Whitelist riêng biệt.
3. **Chưa có Web Application Firewall (WAF)**: Nginx hiện hoạt động dưới vai trò Reverse Proxy đơn thuần, chưa tích hợp module ModSecurity / Coraza WAF để phát hiện và ngăn chặn nâng cao các mẫu tấn công SQLi/XSS ở tầng gateway.
