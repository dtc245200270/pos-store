# Hệ thống Quản lý Cửa hàng POS (POS Store)

Dự án đã được cập nhật và hoàn thiện các chức năng theo đúng yêu cầu bằng Node.js, Express, và MySQL.

## Các chức năng đã triển khai & Kiểm tra

### A. Đăng nhập, Đăng xuất, Phân quyền
- **Đã hoàn thành**: 
  - Cấu hình session với `express-session` và `express-mysql-session` (với script migration do user cấu hình MySQL không cho phép quyền CREATE).
  - Mật khẩu băm an toàn bằng `bcryptjs`.
  - Phân quyền MANAGER và CASHIER thông qua middleware `requireRole`.
  - Tái tạo session ID khi đăng nhập để tránh lỗ hổng Session Fixation.
  - Bảo vệ CSRF thông qua kiểm tra HTTP Header `Origin` cho các POST/PUT/DELETE request.
  - Giới hạn số lần thử đăng nhập sai (rate limiting trong bộ nhớ).
  - Kèm script `scripts/create-manager.js` (tạo MANAGER ban đầu).
- **Kết quả kiểm tra**:
  - Đăng nhập sai: Bị chặn với mã lỗi 401.
  - Tài khoản manager đăng nhập đúng: OK.
  - Vô hiệu hóa tài khoản / sai quyền: Bị chặn với mã lỗi 403.

### B. Sản phẩm và Tài khoản nhân viên
- **Đã hoàn thành**:
  - CRUD sản phẩm với tồn kho khởi tạo = 0.
  - Không cho phép cập nhật trực tiếp `stock_quantity`.
  - CRUD tài khoản nhân viên. Không thể tự xóa quyền MANAGER của chính mình.
- **Kết quả kiểm tra**: Thêm nhân viên và sản phẩm thành công qua integration test.

### C. Nhập hàng (Stock Receipts)
- **Đã hoàn thành**:
  - API `POST /api/stock-receipts` chỉ định riêng cho MANAGER.
  - Gộp các sản phẩm trùng khi nhập.
  - Chống gửi 2 yêu cầu trùng bằng `request_key` và `request_hash` (với ràng buộc Unique ở Database).
  - Cập nhật tồn kho và tạo bản ghi lịch sử vào `stock_movements`.
  - Đảm bảo thực thi trong 1 `transaction`, Rollback nếu lỗi.
- **Kết quả kiểm tra**: Tăng tồn kho chính xác, các request trùng lặp bị chặn.

### D. Bán hàng và Hóa đơn (Sales & Invoices)
- **Đã hoàn thành**:
  - Tương tự Nhập hàng, tính transaction an toàn, bảo vệ bằng `SELECT ... FOR UPDATE` tránh lỗi khi hai đơn được xử lý đồng thời.
  - Khóa giới hạn: Nếu `stock_quantity < quantity`, giao dịch bị rollback.
  - Xác thực giá thay đổi: Nếu Client gửi `expected_price` không khớp với giá `sale_price` trong DB, API trả về HTTP 409 buộc Client xác nhận.
- **Kết quả kiểm tra**:
  - Bán vượt tồn kho: Trả về lỗi tồn kho không đủ (HTTP 400).
  - Test thay đổi giá: Trả về cảnh báo yêu cầu xác nhận.
  - Chống trùng lặp gửi request: OK.

### E. Tồn kho và Lịch sử biến động
- **Đã hoàn thành**: API lấy chi tiết tồn kho (`/api/inventory`) và lịch sử (`/api/inventory/:id/movements`).

## Các file đã thay đổi / tạo mới
1. `server.js`: Tích hợp session, các thư mục public, các routes API, CSRF Middleware.
2. `middleware/auth.js`: Middleware phân quyền và bảo vệ CSRF.
3. `routes/auth.js`: Routing Đăng nhập, Đăng xuất, Lấy thông tin user hiện tại.
4. `routes/pages.js`: Routing trả về các file HTML trong thư mục `views`.
5. `routes/api/products.js`, `routes/api/employees.js`, `routes/api/invoices.js`, `routes/api/stock-receipts.js`, `routes/api/inventory.js`: Xử lý CRUD nghiệp vụ.
6. `database/migration_01_sessions.sql`: Script tạo bảng cho express-mysql-session.
7. `scripts/create-manager.js`: Script Node JS dùng tạo tài khoản MANAGER ban đầu.
8. `views/login.html`, `views/dashboard.html`: Các trang UI mẫu cơ bản.

## Các trang UI được tách biệt
- `views/` chứa 6 trang giao diện (dashboard, products, employees, sales, invoices, stock-receipts, inventory).
- `public/js/` và `public/css/` xử lý layout chung (Sidebar, Navbar) và gắn kết với API qua file `auth.js` để tự động xử lý CSRF header `X-CSRF-Token`.

## Phần kiểm thử / Tình trạng test
1. File `tests/integration.test.js` đã được soạn sẵn với node native test runner (`node --test`). Các test bao gồm:
   - Đăng nhập (thành công / sai quyền / vòng đời CSRF Token).
   - Kiểm tra kiểu dữ liệu Sản phẩm và Bán hàng đồng thời (bắt lỗi đổi giá).
   - Nhập hàng & Hoá đơn (Kiểm tra Decimal giới hạn, số lượng, kiểm tra Idempotency hash).
   - Chặn tài khoản bị khoá, chặn xem hoá đơn của người khác.

## Phần kiểm thử / Tình trạng test

### 1. Kiểm thử tập trung 5 mục sửa lỗi nghiệp vụ gần nhất (`scripts/verify-fixes-bundle.js`):
Chạy trên cơ sở dữ liệu kiểm thử riêng `pos_store_test` (cổng 3006), **hoàn toàn không đụng chạm hay reset CSDL thực tế `pos_store`**:
| STT | Bài kiểm thử | Kết quả | Chi tiết thực tế |
| :---: | :--- | :---: | :--- |
| **1** | Xóa sessions theo so sánh chính xác JSON userId | **PASS** | Đổi/reset mật khẩu user ID 1 xóa chính xác phiên của ID 1; các phiên của ID 10, 11, 100 được bảo toàn nguyên vẹn 100%. |
| **2** | Kiểm tra ngày hợp lệ & chặn `from_date > to_date` | **PASS** | Backend trả HTTP 400 trước khi truy vấn; giao diện báo rõ lỗi, giữ nguyên danh sách và bộ lọc; xóa thông báo khi ngày hợp lệ hoặc bấm Đặt lại. |
| **3** | Retry an toàn phiếu nhập khi mất kết nối & Idempotency | **PASS** | Giữ nguyên `request_key`, mã phiếu và giỏ hàng; khóa sửa mặt hàng khi chờ thử lại; thử lại nhận HTTP 200 trả đúng phiếu cũ và không cộng trùng kho. |
| **4** | Khóa Transaction bảo vệ quản lý cuối cùng (2 request đồng thời) | **PASS** | Cơ chế khóa thống nhất `SELECT ... FOR UPDATE` theo thứ tự ID: 1 request thành công (200), 1 request bị chặn (400); luôn giữ lại ít nhất 1 quản lý hoạt động. |
| **5** | Dashboard `COUNT(*)` sản phẩm cần nhập vs giới hạn 20 dòng | **PASS** | Ô đếm thống kê hiển thị chính xác tổng thực tế từ `COUNT(*)`, danh sách chi tiết hiển thị giới hạn 20 dòng kèm chú thích liên kết. |

- **Tổng kết bộ test tập trung:** 5 bài PASS / 0 bài FAIL / 0 bài CHƯA CHẠY.

### 2. Bộ kiểm thử tích hợp toàn diện hệ thống (`npm test`):
Chạy 5 tệp kiểm thử tự động với Node native test runner (`node --test`):
- `tests/dashboard.test.js`: PASS (8/8 subtests)
- `tests/integration.test.js`: PASS (10/10 subtests)
- `tests/inventory.test.js`: PASS (10/10 subtests)
- `tests/products.test.js`: PASS (12/12 subtests)
- `tests/stock-receipts.test.js`: PASS (12/12 subtests)
- **Tổng cộng:** 57/57 tests PASS (0 fail, 0 skipped, 0 cancelled).

### 3. Bộ kiểm thử chức năng nhân viên & phân quyền:
- `scripts/test-employees-feature.js`: PASS 100% (9 bước nghiệp vụ phân quyền, CRUD, lockout, mid-session).
- `scripts/verify-protect-last-manager.js`: PASS 100% (6 kịch bản bảo vệ quản lý cuối cùng).
## Cách chạy dự án

**1. Khởi tạo Database Session (Bắt buộc chạy bằng Root)**
Vui lòng mở MySQL Workbench bằng tài khoản `root`, **chọn schema `pos_store`** và chạy script:
\`\`\`sql
SOURCE database/migration_01_sessions.sql;

-- Cấp quyền DELETE (dùng để clear session hết hạn) cho pos_app
GRANT DELETE ON pos_store.sessions TO 'pos_app'@'localhost';
FLUSH PRIVILEGES;
\`\`\`

**2. Tạo Manager ban đầu**
Bảo đảm `INITIAL_MANAGER_PASSWORD` trong `.env` có từ 12 ký tự trở lên.
Chạy trong terminal:
\`\`\`bash
node scripts/create-manager.js
\`\`\`

**3. Chạy server**
\`\`\`bash
node server.js
\`\`\`

Sau đó truy cập [http://localhost:3000](http://localhost:3000) và đăng nhập bằng tài khoản `manager`.
