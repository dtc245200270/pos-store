require("dotenv").config();
const bcrypt = require("bcryptjs");
const pool = require("../config/db");

async function createManager() {
  const username = "manager";
  const password = process.env.INITIAL_MANAGER_PASSWORD;

  if (!password) {
    console.error("Lỗi: Không tìm thấy INITIAL_MANAGER_PASSWORD trong .env");
    process.exit(1);
  }

  // Check password length: at least 12 chars, max 72 bytes UTF-8
  if (password.length < 12) {
    console.error("Lỗi: Mật khẩu phải có ít nhất 12 ký tự.");
    process.exit(1);
  }
  const passwordBytes = Buffer.byteLength(password, 'utf8');
  if (passwordBytes > 72) {
    console.error("Lỗi: Mật khẩu không được vượt quá 72 byte (UTF-8).");
    process.exit(1);
  }

  try {
    const [existingUsers] = await pool.query(
      "SELECT id FROM users WHERE username = ?",
      [username]
    );

    if (existingUsers.length > 0) {
      console.log(`Tài khoản '${username}' đã tồn tại. Bỏ qua tạo mới.`);
      process.exit(0);
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    await pool.query(
      `INSERT INTO users (username, password_hash, full_name, role, is_active)
       VALUES (?, ?, ?, 'MANAGER', 1)`,
      [username, passwordHash, "Quản lý hệ thống"]
    );

    console.log(`Đã khởi tạo thành công tài khoản '${username}'.`);
  } catch (error) {
    console.error("Lỗi khi tạo tài khoản manager:", error);
  } finally {
    await pool.end();
  }
}

createManager();
