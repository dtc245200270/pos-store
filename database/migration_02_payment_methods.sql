-- ==============================================================================
-- DỰ ÁN POS STORE - BẢN DI TRÚ CSDL 02: PHƯƠNG THỨC THANH TOÁN & VIETQR
-- ==============================================================================
-- Tệp: database/migration_02_payment_methods.sql
-- Mục đích:
--   - Bổ sung 3 cột vào bảng `invoices` để hỗ trợ thanh toán Chuyển khoản VietQR bên cạnh Tiền mặt:
--       1. payment_method (VARCHAR(20)): 'CASH' hoặc 'BANK_TRANSFER' (mặc định NULL cho hóa đơn cũ).
--       2. transfer_content (VARCHAR(100)): Nội dung chuyển khoản duy nhất phục vụ đối soát.
--       3. transfer_confirmed_at (DATETIME): Thời điểm thu ngân xác nhận đã nhận đủ tiền vào tài khoản.
-- ==============================================================================

ALTER TABLE invoices
  ADD COLUMN payment_method VARCHAR(20) NULL DEFAULT NULL AFTER total_amount,
  ADD COLUMN transfer_content VARCHAR(100) NULL DEFAULT NULL AFTER payment_method,
  ADD COLUMN transfer_confirmed_at DATETIME NULL DEFAULT NULL AFTER transfer_content;
