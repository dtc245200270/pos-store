/**
 * ==============================================================================
 * DỰ ÁN POS STORE - CẤP QUYỀN DELETE CHO USER CƠ SỞ DỮ LIỆU CỤC BỘ
 * ==============================================================================
 * Tệp: scripts/grant-delete.js
 * Mục đích:
 *   - Cấp bổ sung đặc quyền DELETE trên schema pos_store cho tài khoản 'pos_app'@'localhost'.
 *   - Sử dụng tài khoản root để thực thi câu lệnh GRANT và FLUSH PRIVILEGES.
 *   - Phục vụ môi trường kiểm thử hoặc thiết lập ban đầu cần dọn dẹp dữ liệu mẫu.
 * ==============================================================================
 */

require('dotenv').config();
const mysql = require('mysql2/promise');

/**
 * Thực thi lệnh cấp quyền DELETE và nạp lại bảng đặc quyền MySQL
 */
async function grantDelete() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: 'root',
    password: process.env.DB_PASSWORD
  });

  try {
    await pool.query("GRANT DELETE ON pos_store.* TO 'pos_app'@'localhost'");
    await pool.query("FLUSH PRIVILEGES");
    console.log("GRANT DELETE on pos_store.* granted successfully!");
  } catch (err) {
    console.error("Grant error:", err.message);
  } finally {
    await pool.end();
  }
}

grantDelete();
