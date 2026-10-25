-- ==============================================================================
-- DỰ ÁN POS STORE - BẢN DI TRÚ CSDL 01: BẢNG LƯU TRỮ PHIÊN LÀM VIỆC (SESSIONS)
-- ==============================================================================
-- Tệp: database/migration_01_sessions.sql
-- Mục đích:
--   - Tạo bảng `sessions` phục vụ gói express-mysql-session lưu trữ phiên làm việc tập trung trong MySQL.
--   - Thay thế hoàn toàn MemoryStore mặc định của Express (vốn chỉ phù hợp dev đơn luồng, dễ rò rỉ bộ nhớ).
--   - Bảng mã `utf8mb4_bin` cho khóa chính session_id giúp phân biệt chính xác chữ hoa/thường và dữ liệu JSON.
-- ==============================================================================

CREATE TABLE IF NOT EXISTS sessions (
  session_id varchar(128) COLLATE utf8mb4_bin NOT NULL,
  expires int(11) unsigned NOT NULL,
  data mediumtext COLLATE utf8mb4_bin,
  PRIMARY KEY (session_id)
) ENGINE=InnoDB;
