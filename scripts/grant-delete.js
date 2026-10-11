require('dotenv').config();
const mysql = require('mysql2/promise');

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
