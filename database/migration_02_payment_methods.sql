-- Migration: Bổ sung phương thức thanh toán và thông tin chuyển khoản vào bảng invoices
-- Mục đích: Hỗ trợ thanh toán Chuyển khoản QR (VietQR) bên cạnh Tiền mặt (CASH).
-- Lưu nội dung chuyển khoản và thời điểm nhân viên xác nhận đã nhận đủ tiền.
-- Hóa đơn cũ trước migration có payment_method IS NULL, được hiển thị là "Chưa ghi nhận".

ALTER TABLE invoices
  ADD COLUMN payment_method VARCHAR(20) NULL DEFAULT NULL AFTER total_amount,
  ADD COLUMN transfer_content VARCHAR(100) NULL DEFAULT NULL AFTER payment_method,
  ADD COLUMN transfer_confirmed_at DATETIME NULL DEFAULT NULL AFTER transfer_content;
