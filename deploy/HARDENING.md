# BÁO CÁO VÀ TÀI LIỆU HARDENING HỆ THỐNG POS STORE (DOCKER COMPOSE)

Phục vụ môn học: **Triển khai và Quản trị Hệ thống Phần mềm**  
Hệ thống: **POS Store - Hệ thống Quản lý Bán hàng Cửa hàng Bán lẻ**  
Kiến trúc: **Docker Compose (8 Containers: Nginx, Node.js App, MySQL, phpMyAdmin, Prometheus, Loki, Grafana, Grafana Alloy)**  
Ngày thực hiện: **23/10/2026** (Cập nhật bổ sung kiểm chứng Trust Proxy & CSP Real Browser)

---

## 1. TỔNG QUAN NGUYÊN TẮC HARDENING

Quá trình rà soát và hoàn thiện Hardening tuân thủ nghiêm ngặt 4 nguyên tắc kỹ thuật:
1. **Kiểm chứng bằng dữ liệu runtime thực tế**: Mọi kết luận đều xuất phát từ kiểm tra trực tiếp qua Nginx (cổng 8080), cổng backend (3000), quy trình kết nối CSDL MySQL, phân quyền container và header phản hồi HTTP; không suy đoán lý thuyết.
2. **Phân loại rõ ràng 4 trạng thái**: Đã có (Present & Verified), Thiếu (Missing), Cấu hình sai/thừa (Misconfigured/Excess), Chưa kiểm chứng (Unverified).
3. **Can thiệp tối thiểu, đúng đích**: Chỉ sửa đổi những điểm thiếu hoặc sai có bằng chứng rõ ràng; giữ nguyên vẹn cơ chế bảo vệ tài khoản hệ thống `manager`, toàn bộ chức năng nghiệp vụ POS, giao diện bán hàng, biểu đồ Grafana và pipeline logging/metrics. Không tự ý đóng các cổng localhost đang dùng (cổng 3000, 3307...).
4. **Không tạo rủi ro dữ liệu**: Kiểm thử trong môi trường cách ly (tài khoản probe độc lập); không tạo hóa đơn rác hoặc thay đổi số liệu bán hàng thật; không kích hoạt các tính năng gây hỏng kết nối môi trường phát triển (như HSTS khi chưa có HTTPS).

---

## 2. BẢNG TỔNG HỢP TRƯỚC VÀ SAU KHI HOÀN THIỆN HARDENING

| Hạng mục | Hiện trạng phát hiện ban đầu | Bằng chứng kiểm tra thực tế | Biện pháp xử lý / Hoàn thiện | Kết quả sau kiểm chứng |
| :--- | :--- | :--- | :--- | :--- |
| **1. Header Server & X-Powered-By** | Lộ chính xác phiên bản Nginx (`nginx/1.27.2`) và framework backend (`Express`). | `curl.exe -i http://127.0.0.1:8080/login`<br>Thấy: `Server: nginx/1.27.2`<br>`X-Powered-By: Express` | - Bật `server_tokens off;` trong block `http` của Nginx.<br>- Thêm `app.disable('x-powered-by')` trong `server.js` và `proxy_hide_header X-Powered-By;` trong Nginx. | `Server: nginx`<br>Header `X-Powered-By` biến mất hoàn toàn. |
| **2. Header Cache-Control bị trùng lặp** | Trùng 2 dòng `Cache-Control` trái ngược: `public, max-age=0` (từ Express) và `no-store, no-cache...` (từ Nginx). | `curl.exe -i http://127.0.0.1:8080/login`<br>Xuất hiện 2 header `Cache-Control` liên tiếp trong response. | Thêm `proxy_hide_header Cache-Control;` trong `location /` của Nginx để Nginx làm đầu mối chuẩn hóa duy nhất. | Chỉ còn duy nhất 1 header `Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0`. |
| **3. MIME Sniffing & Frame Embedding** | Thiếu bảo vệ chống MIME-sniffing và Clickjacking. | Không có `X-Content-Type-Options` và `X-Frame-Options` trong response header. | Thêm `add_header X-Content-Type-Options "nosniff" always;`<br>Thêm `add_header X-Frame-Options "SAMEORIGIN" always;`. | Trả về `nosniff` và `SAMEORIGIN` trên mọi endpoint. |
| **4. Referrer Policy** | Thiếu chính sách Referrer phù hợp. | Không có `Referrer-Policy`. | Thêm `add_header Referrer-Policy "strict-origin-when-cross-origin" always;`. | Trả về `strict-origin-when-cross-origin`. |
| **5. Content Security Policy (CSP)** | Cần bảo vệ tải tài nguyên nhưng phải đảm bảo Bootstrap, VietQR, modal hoạt động trên trình duyệt thật. | Kiểm tra console và network qua Chrome Headless (CDP protocol). | Thiết lập CSP phù hợp tài nguyên thực tế: `default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net data:; img-src 'self' data: https://img.vietqr.io; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self';`. | Trình duyệt thật (Chrome) ghi nhận: 0 lỗi vi phạm CSP, 0 request bị chặn, ảnh VietQR tải thành công (540x540px), modal và đăng nhập hoạt động trơn tru. *(Lưu ý: CSP hiện còn `unsafe-inline`, chưa thể coi là chống XSS toàn diện).* |
| **6. HSTS** | HSTS không được kích hoạt khi chưa có HTTPS. | Không có `Strict-Transport-Security`. | Giữ nguyên: **Chưa bật HSTS** vì dự án đang chạy HTTP trên localhost. Tránh nguy cơ khóa trình duyệt không thể truy cập HTTP. | Tuân thủ chính xác yêu cầu. |
| **7. Trust Proxy & Chuẩn hóa Header** | Cấu hình `trust proxy: 1` trước đây mù quáng tin cậy 1 hop, dẫn đến khi client gọi trực tiếp cổng 3000 có thể giả mạo `X-Forwarded-*`. Nginx cũng chưa chuẩn hóa ghi đè `X-Forwarded-Host`. | Gửi request có `X-Forwarded-For: 10.0.0.99`, `X-Forwarded-Proto: https`, `X-Forwarded-Host: attacker.com`:<br>- Cổng 3000: `clientIp` bị đổi thành `10.0.0.99`, `protocol` thành `https` và kích hoạt `Secure` cookie sai lệch.<br>- Cổng 8080: `X-Forwarded-Host` bị lọt `attacker.com`. | - Tại Nginx: Chuẩn hóa toàn bộ: gán `X-Forwarded-For $remote_addr;`, `X-Forwarded-Proto $scheme;`, `X-Forwarded-Host $host;`, `X-Forwarded-Port $server_port;`.<br>- Tại Express: Chuyển sang chính sách Trust Proxy nghiêm ngặt bằng hàm phân giải động: **CHỈ tin cậy proxy thực tế** (Nginx container qua DNS `nginx` hoặc loopback local); từ chối tin cậy header khi gọi trực tiếp vào cổng 3000. | - Cổng 3000 trực tiếp: Bỏ qua hoàn toàn header giả mạo; `clientIp` giữ nguyên socket IP thật, `protocol` giữ `http`, không bị bật cờ `Secure` cookie sai lệch.<br>- Cổng 8080: Nginx ghi đè triệt để header giả mạo; Express nhận diện đúng client IP thật từ Nginx. |
| **8. Session Cookie Secure** | Thuộc tính `secure` bị gán cứng `false`. | `cookie: { secure: false }` trong `server.js`. | Chuyển sang cơ chế thích ứng: `secure: process.env.COOKIE_SECURE === 'true' ? true : (process.env.COOKIE_SECURE === 'false' ? false : 'auto')`. | Thích ứng tự động: Giữ `secure: false` trên HTTP localhost, tự động bật `secure: true` nếu chạy sau reverse proxy HTTPS. |
| **9. Quyền MySQL User `pos_app`** | Tài khoản ứng dụng `pos_app` được cấp `ALL PRIVILEGES` trên database `pos_store`, có thừa quyền phá hủy cấu trúc (DROP, CREATE, ALTER...). | `SHOW GRANTS FOR 'pos_app'@'%';`<br>Thấy: `GRANT ALL PRIVILEGES ON pos_store.*` | Áp dụng Principle of Least Privilege: Thu hồi `ALL PRIVILEGES`, chỉ cấp `SELECT, INSERT, UPDATE, DELETE` trên `pos_store.*`. Cập nhật vào cuối `database/init/01_init_schema.sql`. Giữ nguyên quyền `root` cho quản trị. | `pos_app` chỉ có `SELECT, INSERT, UPDATE, DELETE`. Các truy vấn `CREATE TABLE` hoặc `DROP TABLE` từ app bị MySQL từ chối (`ER_TABLEACCESS_DENIED_ERROR`). Không phát hiện lỗi nghiệp vụ trong runtime. |
| **10. File nhạy cảm trong `.dockerignore`** | Thiếu chỉ thị loại trừ thư mục bản sao lưu CSDL và file sao lưu `.bak`. | Kiểm tra `.dockerignore` ban đầu thiếu `database/backups` và `*.bak`. | Bổ sung `database/backups`, `*.bak`, `*.log` vào `.dockerignore`. | Loại trừ các tệp/thư mục khớp mẫu khỏi build context. *(Lưu ý: `.dockerignore` chỉ lọc các đường dẫn khớp mẫu khai báo, không thay thế cho quy trình quản lý bí mật tổng thể).* |
| **11. Giới hạn đăng nhập sai** | Đã có cơ chế rate limiting nhưng cần kiểm chứng độ tin cậy. | `routes/auth.js` chứa Map `accountLoginAttempts` (5 lần sai, khóa 15 phút, trả về HTTP 429). | Giữ nguyên cơ chế, kiểm chứng bằng tài khoản probe độc lập `isolated_lockout_probe_*`. | Đạt chuẩn: Lần thử thứ 5/6 sai trả về 429 và `Retry-After: 900`. Đăng nhập thành công tự xóa bộ đếm. |
| **12. Chống Session Fixation & CSRF** | Đã có nhưng cần xác minh runtime. | `req.session.regenerate()` sau login, `req.session.destroy()` khi logout; `csrfProtection` trên mọi mutating route. | Kiểm chứng bằng script tự động: POST không token bị 403, Session ID thay đổi sau login, logout xóa cookie và vô hiệu phiên. | Đạt 100% mục tiêu kiểm chứng. |

---

## 3. CHI TIẾT BỔ SUNG KIỂM CHỨNG & HOÀN THIỆN KỸ THUẬT

### 3.1. Phân tích & Xử lý Trust Proxy trên cả hai cổng 8080 và 3000

#### A. Vấn đề phát hiện khi kiểm tra hai đường
Hệ thống công bố đồng thời cổng Nginx `8080` (cho người dùng cuối) và cổng Node.js `3000` (phục vụ kiểm thử/phát triển trực tiếp).
Khi gửi các HTTP header giả mạo từ client:
- `X-Forwarded-For: 10.0.0.99`
- `X-Forwarded-Proto: https`
- `X-Forwarded-Host: attacker.com`

**Hiện trạng trước khi sửa:**
1. **Truy cập trực tiếp cổng 3000**: Do cấu hình `app.set('trust proxy', 1)`, Express coi kết nối trực tiếp này là hop proxy đầu tiên và tin cậy hoàn toàn các header do client tự gửi:
   - `clientIp` bị biến thành `10.0.0.99` (sai lệch IP client).
   - `protocol` bị nhận thành `https` -> Express tự động bật cờ `Secure` trong `Set-Cookie`, khiến trình duyệt chạy HTTP trên localhost không gửi lại cookie ở các request tiếp theo (hỏng phiên đăng nhập).
   - `hostname` bị nhận thành `attacker.com` (tiềm ẩn Host Header Injection).
2. **Truy cập qua Nginx cổng 8080**: Nginx dùng `$proxy_add_x_forwarded_for`, làm chuỗi header gửi sang Express bị nối đuôi `10.0.0.99, 172.19.0.1`, đồng thời Nginx chưa gán `X-Forwarded-Host`, dẫn đến `req.hostname` vẫn bị nhận thành `attacker.com`.

#### B. Giải pháp kỹ thuật đã triển khai
1. **Chuẩn hóa tại Nginx (`deploy/docker/nginx/nginx.conf` và `deploy/nginx/nginx.conf`)**:
   ```nginx
   # Chuẩn hóa triệt để, loại bỏ hoàn toàn header giả mạo từ client gửi lên Nginx:
   proxy_set_header Host $http_host;
   proxy_set_header X-Real-IP $remote_addr;
   proxy_set_header X-Forwarded-For $remote_addr; # Ghi đè bằng remote_addr thật, không dùng proxy_add_x_forwarded_for
   proxy_set_header X-Forwarded-Proto $scheme;     # Ghi đè bằng giao thức thật
   proxy_set_header X-Forwarded-Host $host;        # Ghi đè bằng host thật
   proxy_set_header X-Forwarded-Port $server_port;
   ```
2. **Chính sách Trust Proxy nghiêm ngặt tại Express (`server.js`)**:
   Thay vì dùng `trust proxy: 1` mù quáng, cấu hình hàm kiểm tra động danh sách IP proxy tin cậy:
   ```javascript
   const dns = require('dns');
   const trustedProxyIps = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

   // Tự động phân giải IP container của Nginx trong Docker network pos_net
   function refreshNginxProxyIp() {
     dns.lookup('nginx', { all: true }, (err, addresses) => {
       if (!err && Array.isArray(addresses)) {
         addresses.forEach((addr) => {
           trustedProxyIps.add(addr.address);
           trustedProxyIps.add(`::ffff:${addr.address}`);
         });
       }
     });
   }
   refreshNginxProxyIp();
   setInterval(refreshNginxProxyIp, 15000).unref();

   // Chỉ tin cậy header nếu hop kết nối trực tiếp đến Express là Nginx hoặc loopback
   app.set('trust proxy', (ip, i) => {
     if (i === 0) {
       const cleanIp = String(ip).replace(/^::ffff:/, '');
       return trustedProxyIps.has(cleanIp) || cleanIp === '127.0.0.1' || cleanIp === '::1';
     }
     return false;
   });
   ```

#### C. Bằng chứng kiểm chứng sau khi sửa
Gửi đồng thời request mang header giả mạo tới cả 2 cổng:
1. **Qua Nginx (8080)**:
   ```json
   {
     "clientIp": "172.19.0.1",
     "remoteIp": "172.19.0.3",
     "protocol": "http",
     "hostname": "127.0.0.1"
   }
   ```
   *Kết quả*: Nginx đã ghi đè sạch sẽ header giả mạo. Express nhận đúng `clientIp = 172.19.0.1`, `protocol = http`, `hostname = 127.0.0.1`.
2. **Trực tiếp cổng 3000**:
   ```json
   {
     "clientIp": "172.19.0.1",
     "remoteIp": "172.19.0.1",
     "protocol": "http",
     "hostname": "127.0.0.1"
   }
   ```
   *Kết quả*: Do kết nối không đến từ Nginx container (`172.19.0.3`), hàm `trust proxy` trả về `false`. Express bỏ qua toàn bộ `X-Forwarded-*`: `clientIp` quay về đúng IP socket thật (`172.19.0.1`), `protocol` giữ nguyên `http` (không bị bật cờ `Secure` cookie sai lệch), `hostname` giữ nguyên `127.0.0.1`.
3. **Cổng 3000 vẫn mở và hoạt động bình thường** phục vụ phát triển/kiểm thử cục bộ; không thêm endpoint debug công khai nào.

---

### 3.2. Kiểm chứng CSP bằng Trình duyệt Thực tế (Real Browser Verification)

Thay vì chỉ kiểm tra HTTP status 200, hệ thống được kiểm chứng tự động bằng Google Chrome Headless thông qua Chrome DevTools Protocol (CDP) trên cổng Nginx 8080 (`scripts/verify-browser-csp.js`):

1. **Luồng Đăng nhập (`/login`)**:
   - Trình duyệt nạp đầy đủ Bootstrap 5 CSS và script từ `cdn.jsdelivr.net`.
   - Thực hiện điền form và click nút Đăng nhập qua DOM. Quá trình xác thực thành công, trình duyệt tự động chuyển hướng về `/`.
2. **Trang Tổng quan Quản lý (`/`)**:
   - Tiêu đề hiển thị: `"Tổng quan quản lý - POS Store"`.
   - Widget số liệu hoạt động chính xác (Tồn kho thấp: `2`).
   - Modal chi tiết hóa đơn (`#invoice-detail-modal`) khởi tạo và đóng mở mượt mà thông qua hàm JavaScript `closeInvoiceModal()`.
3. **Trang Bán hàng (`/sales`) & Hiển thị mã QR VietQR**:
   - Giao diện bán hàng nạp đầy đủ danh mục và thanh toán.
   - Kiểm tra tải ảnh VietQR trực tiếp từ domain `https://img.vietqr.io`:
     Ảnh nạp thành công với kích thước thực tế **540x540px** (`status: "LOADED"`), không bị CSP chặn.
4. **Các trang Quản trị còn lại**:
   - `/products`, `/employees`, `/invoices`, `/stock-receipts`, `/inventory`, `/profile` đều nạp đầy đủ DOM, render đúng số lượng bảng biểu dữ liệu.
5. **Kiểm tra Nhật ký Trình duyệt (Console & Network Audit)**:
   - **Tổng số lỗi vi phạm CSP (CSP Violations)**: **0 lỗi**.
   - **Tổng số yêu cầu mạng bị CSP chặn (Blocked by CSP)**: **0 yêu cầu**.
   - Không có tài nguyên nội bộ hoặc bên thứ ba hợp lệ nào bị chặn sai lệch.

#### ĐÍNH CHÍNH VÀ GIỚI HẠN QUAN TRỌNG VỀ CSP:
> [!WARNING]
> **Giới hạn kỹ thuật**: Do các giao diện hiện tại (`login.html`, `profile.html`, `sales.html`, `dashboard.html`...) đang chứa các đoạn thẻ `<script>` nội tuyến và các thuộc tính `style="..."` phục vụ hiệu ứng giao diện, chỉ thị `script-src` và `style-src` của CSP hiện bắt buộc phải chứa `'unsafe-inline'`.
> Vì lý do này, **CSP hiện tại CHƯA THỂ coi là cơ chế phòng chống XSS toàn diện**. Nếu kẻ tấn công tiêm nhiễm được mã độc inline vào trang, trình duyệt vẫn sẽ thực thi mã đó.
> **Khuyến nghị nâng cấp tương lai**: Để đạt mức chống XSS chặt chẽ, cần tách toàn bộ inline script sang các file `.js` độc lập trong thư mục `public/js/`, loại bỏ các thuộc tính style nội tuyến, và áp dụng cơ chế CSP Nonce (`nonce-{random}`) hoặc SHA-256 hash cho từng script.

---

### 3.3. Đính chính Báo cáo về .dockerignore và Giao thức MySQL

Để đảm bảo tính chuẩn xác và trung thực kỹ thuật cao nhất:

1. **Về `.dockerignore`**:
   - `.dockerignore` hoạt động theo cơ chế so khớp mẫu (pattern matching). Việc bổ sung `database/backups`, `*.bak`, `*.log`, `.env*` có tác dụng loại bỏ các file/thư mục khớp với mẫu đã khai báo ra khỏi Docker build context.
   - **Đính chính**: Đây **không phải là giải pháp "ngăn chặn tuyệt đối mọi bí mật"**. Nếu nhà phát triển đặt tên file nhạy cảm lệch khỏi các mẫu trên hoặc nhúng trực tiếp credential vào source code thì Docker vẫn có thể đóng gói vào image. Quản trị viên cần kết hợp kiểm soát mã nguồn và quét secret (git-secrets/trufflehog).

2. **Về Kết nối CSDL MySQL**:
   - **Đính chính**: Cần phân biệt rõ ràng giữa kết nối CSDL và kết nối HTTP:
     - Giao thức CSDL MySQL hoạt động trên tầng socket nhị phân (MySQL wire protocol), trạng thái kết nối và truy vấn được xác định thông qua gói tin bắt tay (handshake packet) và mã phản hồi SQL (như `COM_QUERY OK` hoặc mã lỗi `ER_*`), **giao thức MySQL không trả mã trạng thái HTTP như 200 OK**.
     - Mã HTTP 200 chỉ tồn tại ở tầng web server (Express/Nginx) khi trả lời yêu cầu HTTP client.

3. **Về Phân quyền MySQL `pos_app`**:
   - Quyền hạn của `pos_app` hiện được giữ nguyên ở mức tối thiểu: `SELECT, INSERT, UPDATE, DELETE` trên database `pos_store.*`.
   - Tài khoản bị cấm các quyền DDL/quản trị (`DROP`, `CREATE`, `ALTER`, `GRANT`). 
   - Quá trình vận hành thực tế và bộ kiểm thử không ghi nhận bất kỳ lỗi quyền hạn nào; các chức năng thêm sản phẩm, lập đơn hàng, nhập kho, xóa session hết hạn đều chạy thông suốt.
   - Giữ nguyên tài khoản `root` phục vụ phpMyAdmin và quản trị viên.

---

## 4. TỔNG HỢP KIỂM CHỨNG TỰ ĐỘNG

Bộ kiểm thử tổng hợp tự động `scripts/test-hardening-verification.js` và `scripts/verify-browser-csp.js` ghi nhận:
- **Test xác minh Backend & Headers (`test-hardening-verification.js`)**: 25/25 tiêu chí PASS (Server version ẩn, X-Powered-By gỡ bỏ, nosniff, SAMEORIGIN, CSP hợp lệ, HSTS không bật, Cache-Control duy nhất, CSRF 403, Rate limiting 429, Session regeneration, Cookie HttpOnly/SameSite/Secure thích ứng, MySQL least privilege).
- **Test xác minh Trình duyệt thật (`verify-browser-csp.js`)**: Đăng nhập, widget thống kê, modal hóa đơn, hiển thị ảnh VietQR 540x540px hoạt động chính xác; ghi nhận 0 lỗi CSP violation trong console.

---

## 5. DANH SÁCH TỆP TIN THAY ĐỔI & BẢN GIAO

1. **[deploy/docker/nginx/nginx.conf](file:///c:/Users/Dell%20Precision%205550/Documents/pos-store/deploy/docker/nginx/nginx.conf)**: Chuẩn hóa ghi đè `X-Forwarded-For $remote_addr;`, `X-Forwarded-Proto $scheme;`, `X-Forwarded-Host $host;`, `X-Forwarded-Port $server_port;`.
2. **[deploy/nginx/nginx.conf](file:///c:/Users/Dell%20Precision%205550/Documents/pos-store/deploy/nginx/nginx.conf)**: Đồng bộ cấu hình chuẩn hóa header cho Nginx standalone.
3. **[server.js](file:///c:/Users/Dell%20Precision%205550/Documents/pos-store/server.js)**: Cấu hình chính sách Trust Proxy nghiêm ngặt bằng hàm phân giải IP Nginx động; chỉ tin cậy proxy thực tế, từ chối tin cậy khi kết nối trực tiếp cổng 3000.
4. **[middleware/http-logger.js](file:///c:/Users/Dell%20Precision%205550/Documents/pos-store/middleware/http-logger.js)**: Bổ sung trường ghi log kiểm toán nội bộ (`clientIp`, `remoteIp`, `protocol`, `hostname`).
5. **[scripts/verify-browser-csp.js](file:///c:/Users/Dell%20Precision%205550/Documents/pos-store/scripts/verify-browser-csp.js)**: Kịch bản kiểm thử tự động trên trình duyệt thật (Chrome CDP) xác minh CSP, Console errors, Modal và VietQR.
6. **[deploy/HARDENING.md](file:///c:/Users/Dell%20Precision%205550/Documents/pos-store/deploy/HARDENING.md)**: Cập nhật chi tiết kiểm chứng 2 đường Trust Proxy, báo cáo CDP trình duyệt thật và 3 nội dung đính chính kỹ thuật.
7. **[README.md](file:///c:/Users/Dell%20Precision%205550/Documents/pos-store/README.md)**: Cập nhật tóm tắt Mục 7 theo các kết quả bổ sung mới nhất.
