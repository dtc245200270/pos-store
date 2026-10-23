# Hướng dẫn phpMyAdmin cho dự án POS Store (Windows)

Tài liệu hướng dẫn vận hành phpMyAdmin trên môi trường thực hành cục bộ Windows để quản trị cơ sở dữ liệu `pos_store` của dịch vụ `MySQL80`.

> [!NOTE]
> Đây là môi trường thực hành cục bộ (localhost). Không mở cổng ra mạng LAN hoặc Internet và không dùng cho môi trường production.

---

## 1. Thông số kiến trúc và Địa chỉ kết nối

- **Giao diện Web phpMyAdmin:** [http://127.0.0.1:8081](http://127.0.0.1:8081) hoặc [http://localhost:8081](http://localhost:8081)
- **Cơ sở dữ liệu kết nối:** MySQL Server 8.0 (`MySQL80`) tại `127.0.0.1:3306`
- **Cơ sở dữ liệu ứng dụng:** `pos_store`
- **Vị trí phpMyAdmin:** `C:\xampp\phpMyAdmin`
- **Vị trí file cấu hình đang dùng:** `C:\xampp\phpMyAdmin\config.inc.php`
- **File sao lưu cấu hình gốc:** `C:\xampp\phpMyAdmin\config.inc.php.bak`
- **Cấu hình mẫu trong dự án:** `deploy/phpmyadmin/config.inc.php.example`

---

## 2. Các nguyên tắc an toàn dữ liệu

1. **Không khởi động dịch vụ MySQL của XAMPP:** Dịch vụ MySQL chính của hệ thống là `MySQL80` (đang chạy cổng 3306). Tuyệt đối không bấm nút Start MySQL trong XAMPP Control Panel để tránh xung đột cổng mạng và tránh tạo database trống ngoài ý muốn.
2. **Xác thực bằng Cookie (`auth_type = 'cookie'`):** Không lưu tài khoản/mật khẩu trong file cấu hình. Người dùng tự nhập tài khoản khi mở trang web.
3. **Chặn mật khẩu trống:** Cấu hình `$cfg['Servers'][$i]['AllowNoPassword'] = false` để đảm bảo an toàn.
4. **Vô hiệu hóa tính năng bảng nâng cao:** Không cấu hình `controluser`, `controlpass` hay `pmadb` vì database `phpmyadmin` không tồn tại trên `MySQL80`. Không tự ý tạo bảng phụ trợ để tránh rác CSDL.

---

## 3. Cách khởi chạy và dừng phpMyAdmin

### Khởi chạy (Cách 1 - Dùng script có sẵn):
Nhấp đúp chuột vào file hoặc mở PowerShell chạy:
```powershell
.\deploy\phpmyadmin\start-phpmyadmin.bat
# hoặc
powershell -ExecutionPolicy Bypass -File .\deploy\phpmyadmin\start-phpmyadmin.ps1
```

### Khởi chạy (Cách 2 - Dùng lệnh trực tiếp):
Mở terminal và thực thi:
```powershell
& "C:\xampp\php\php.exe" -S 127.0.0.1:8081 -t "C:\xampp\phpMyAdmin"
```

### Dừng đúng tiến trình phpMyAdmin:
- Nếu đang chạy ở cửa sổ dòng lệnh: Nhấn `Ctrl + C`.
- Hoặc chạy script dừng tiến trình tại cổng 8081:
```powershell
powershell -ExecutionPolicy Bypass -File .\deploy\phpmyadmin\stop-phpmyadmin.ps1
```

---

## 4. Hướng dẫn chạy lại sau khi khởi động lại máy tính

Khi khởi động lại máy Windows, chạy các dịch vụ theo thứ tự:

1. **Khởi động ứng dụng POS Store (Node.js - cổng 3000):**
   ```powershell
   cd "c:\Users\Dell Precision 5550\Documents\pos-store"
   npm start
   ```
2. **Khởi động Nginx Reverse Proxy (cổng 8080):**
   ```powershell
   cd C:\nginx
   Start-Process .\nginx.exe
   ```
3. **Khởi động phpMyAdmin (cổng 8081):**
   ```powershell
   & "C:\xampp\php\php.exe" -S 127.0.0.1:8081 -t "C:\xampp\phpMyAdmin"
   ```
4. Mở trình duyệt truy cập: **http://127.0.0.1:8081**
   - Đăng nhập bằng tài khoản quản trị `root` hoặc tài khoản `pos_app` để quản lý CSDL `pos_store`.
