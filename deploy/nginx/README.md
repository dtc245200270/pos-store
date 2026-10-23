# Hướng dẫn Nginx Reverse Proxy cho POS Store (Windows)

Tài liệu hướng dẫn vận hành Nginx làm Reverse Proxy chuyển tiếp yêu cầu từ cổng `8080` về máy chủ ứng dụng Node.js chạy tại cổng `3000`.

---

## 1. Vị trí cài đặt và Cấu hình

- **Thư mục cài Nginx:** `C:\nginx`
- **File thực thi:** `C:\nginx\nginx.exe`
- **File cấu hình gốc của Nginx:** `C:\nginx\conf\nginx.conf`
- **File cấu hình dự án lưu trữ:** `deploy/nginx/nginx.conf`
- **Thư mục nhật ký (Logs):**
  - Nhật ký truy cập Nginx: `C:\nginx\logs\access.log`
  - Nhật ký lỗi Nginx: `C:\nginx\logs\error.log`

---

## 2. Các lệnh quản lý Nginx trên Windows (PowerShell / CMD)

Mở terminal tại thư mục `C:\nginx`:

```powershell
# Chuyển vào thư mục Nginx
cd C:\nginx

# 1. Kiểm tra tính hợp lệ của cú pháp cấu hình
.\nginx.exe -t

# 2. Khởi động Nginx chạy ngầm (Background)
Start-Process .\nginx.exe

# Hoặc khởi động với cú pháp trực tiếp
.\nginx.exe

# 3. Nạp lại cấu hình (Reload không gián đoạn)
.\nginx.exe -s reload

# 4. Dừng nhanh Nginx (Fast shutdown)
.\nginx.exe -s stop

# 5. Dừng an toàn (Graceful shutdown)
.\nginx.exe -s quit
```

---

## 3. Quy trình khởi động lại hệ thống sau khi khởi động lại máy tính

Khi khởi động lại Windows, các dịch vụ cần được bật theo thứ tự:

### Bước 1: Khởi động MySQL Service (nếu chưa tự động)
```powershell
Start-Service MySQL80
```

### Bước 2: Khởi động ứng dụng Node.js (cổng 3000)
Mở terminal tại thư mục dự án `pos-store`:
```powershell
cd "c:\Users\Dell Precision 5550\Documents\pos-store"
npm start
```

### Bước 3: Khởi động Nginx (cổng 8080)
Mở một cửa sổ terminal khác:
```powershell
cd C:\nginx
Start-Process .\nginx.exe
```

Truy cập website tại: **http://localhost:8080**

---

## 4. Phân biệt Nhật ký (Logs)

| Tiêu chí | Nhật ký Nginx (`access.log`) | Nhật ký Node.js (JSON stdout/stderr) |
| :--- | :--- | :--- |
| **Vị trí** | `C:\nginx\logs\access.log` | Luồng stdout của tiến trình Node.js |
| **Định dạng** | Text chuẩn W3C/Nginx combined mở rộng | Cấu trúc **JSON dòng (JSON Lines)** |
| **Mục đích** | Đo lường lưu lượng mạng, IP client, thời gian kết nối upstream (`rt`, `uct`, `urt`) | Theo dõi nghiệp vụ, định danh `requestId`, `userId`, `role`, cảnh báo và ngăn ngừa rò rỉ dữ liệu nhạy cảm |
| **Ví dụ** | `127.0.0.1 - - [13/Oct/2026:08:30:12 +0700] "GET /api/dashboard/stats HTTP/1.1" 200 ...` | `{"timestamp":"...","level":"info","event":"http_request","requestId":"...","statusCode":200}` |
