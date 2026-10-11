-- Migration: Tạo bảng lưu trữ session cho express-mysql-session
-- Lý do: Sử dụng express-mysql-session yêu cầu bảng sessions để lưu trạng thái đăng nhập thay vì MemoryStore để phù hợp triển khai thực tế. Bảng này sẽ được quản lý bởi express-mysql-session.

CREATE TABLE IF NOT EXISTS sessions (
  session_id varchar(128) COLLATE utf8mb4_bin NOT NULL,
  expires int(11) unsigned NOT NULL,
  data mediumtext COLLATE utf8mb4_bin,
  PRIMARY KEY (session_id)
) ENGINE=InnoDB;
