/**
 * ==============================================================================
 * DỰ ÁN POS STORE - QUẢN LÝ KẾT NỐI CƠ SỞ DỮ LIỆU MYSQL (DATABASE POOL)
 * ==============================================================================
 * Tệp: config/db.js
 * Mục đích:
 *   - Khởi tạo và quản lý hồ bơi kết nối (Connection Pool) tới CSDL MySQL bằng thư viện mysql2/promise.
 *   - Tối ưu hiệu năng: Tái sử dụng kết nối, giới hạn tối đa 10 kết nối đồng thời.
 *   - Chuẩn hóa mã hóa ký tự (utf8mb4) và đồng bộ múi giờ Việt Nam (UTC+7 / Asia/Ho_Chi_Minh).
 * ==============================================================================
 */

const mysql = require("mysql2/promise");

// Cấu hình Connection Pool từ biến môi trường
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true, // Xếp hàng đợi khi số kết nối đạt ngưỡng giới hạn
  connectionLimit: 10,       // Tối đa 10 kết nối đồng thời trong pool
  queueLimit: 0,            // Không giới hạn độ dài hàng đợi (chờ kết nối giải phóng)
  charset: "utf8mb4",       // Hỗ trợ đầy đủ tiếng Việt có dấu và ký tự mở rộng
  timezone: "+07:00",       // Đồng bộ múi giờ Việt Nam cho các hàm Date/Time
});

// Khi một kết nối mới được tạo, đảm bảo phiên làm việc thực thi đúng múi giờ UTC+7
pool.on("connection", (connection) => {
  connection.query("SET time_zone = '+07:00'");
});

module.exports = pool;