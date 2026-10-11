require("dotenv").config();

const express = require("express");
const session = require("express-session");
const pool = require("./config/db");

const authRoutes = require("./routes/auth");
const pageRoutes = require("./routes/pages");
const productRoutes = require("./routes/api/products");
const employeeRoutes = require("./routes/api/employees");
const stockReceiptRoutes = require("./routes/api/stock-receipts");
const invoiceRoutes = require("./routes/api/invoices");
const inventoryRoutes = require("./routes/api/inventory");
const dashboardRoutes = require("./routes/api/dashboard");
const { csrfProtection } = require("./middleware/auth");

const app = express();
const PORT = Number(process.env.PORT || 3000);

if (!process.env.SESSION_SECRET) {
  console.error("Lỗi: Bắt buộc phải có SESSION_SECRET trong file .env");
  process.exit(1);
}

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Cấu hình express-mysql-session (Yêu cầu phải chạy file migration_01_sessions.sql trước)
const MySQLStore = require("express-mysql-session")(session);
const sessionStore = new MySQLStore({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  clearExpired: true,
  checkExpirationInterval: 900000,
  expiration: 86400000,
  createDatabaseTable: false // Vì pos_app không có quyền CREATE TABLE
});

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: {
    maxAge: 86400000,
    httpOnly: true,
    secure: false, // Phải là false khi chạy localhost HTTP (môi trường dev/test)
    sameSite: 'lax'
  }
}));

// Thư mục public cho JS, CSS, Hình ảnh (không chứa trang nghiệp vụ)
app.use('/public', express.static('public'));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/products', csrfProtection, productRoutes);
app.use('/api/employees', csrfProtection, employeeRoutes);
app.use('/api/stock-receipts', csrfProtection, stockReceiptRoutes);
app.use('/api/invoices', csrfProtection, invoiceRoutes);
app.use('/api/inventory', csrfProtection, inventoryRoutes);
app.use('/api/dashboard', csrfProtection, dashboardRoutes);
app.use('/', pageRoutes);

async function startServer() {
  try {
    const [rows] = await pool.query("SELECT DATABASE() AS database_name");
    await pool.query("SELECT id FROM products LIMIT 1");

    console.log(`Kết nối MySQL thành công: ${rows[0].database_name}`);

    const server = app.listen(PORT, "127.0.0.1", () => {
      console.log(`Website đang chạy tại http://localhost:${PORT}`);
    });

    server.on("error", (error) => {
      console.error("Lỗi khởi động máy chủ:", error.code);
      process.exit(1);
    });
  } catch (error) {
    console.error("Không thể kết nối hoặc truy vấn MySQL:", error.code);
    await pool.end();
    process.exit(1);
  }
}

startServer();