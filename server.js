require("dotenv").config();

const http = require("http");
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
const requestIdMiddleware = require("./middleware/request-id");
const httpLoggerMiddleware = require("./middleware/http-logger");
const { metricsMiddleware, startMetricsServer } = require("./config/metrics");
const logger = require("./config/logger");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const METRICS_PORT = process.env.METRICS_PORT !== undefined ? Number(process.env.METRICS_PORT) : 9101;
const METRICS_HOST = process.env.METRICS_HOST || "0.0.0.0";

// Vo hieu hoa header X-Powered-By de chong tiet lo cong nghe Express
app.disable('x-powered-by');

// Danh sach IP proxy duoc phep tin cay (Nginx reverse proxy hoac loopback)
const dns = require('dns');
const trustedProxyIps = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function refreshNginxProxyIp() {
  dns.lookup('nginx', { all: true }, (err, addresses) => {
    if (!err && Array.isArray(addresses)) {
      addresses.forEach((addr) => {
        trustedProxyIps.add(addr.address);
        trustedProxyIps.add(`::ffff:${addr.address}`);
      });
    }
  });
}
refreshNginxProxyIp();
const proxyRefreshTimer = setInterval(refreshNginxProxyIp, 15000);
if (proxyRefreshTimer.unref) proxyRefreshTimer.unref();

// Chinh sach Trust Proxy chat che:
// - CHI tin cay hop proxy dau tien neu ket noi xuat phat tu Nginx container hoac loopback
// - TUYET DOI KHONG tin cay header X-Forwarded-* khi client ket noi truc tiep vao cong 3000
app.set('trust proxy', (ip, i) => {
  if (i === 0) {
    const cleanIp = String(ip).replace(/^::ffff:/, '');
    return trustedProxyIps.has(cleanIp) || cleanIp === '127.0.0.1' || cleanIp === '::1';
  }
  return false;
});

if (!process.env.SESSION_SECRET) {
  console.error("Lỗi: Bắt buộc phải có SESSION_SECRET trong file .env");
  process.exit(1);
}

// 1. Cấp requestId cho toàn bộ request
app.use(requestIdMiddleware);

// Endpoint kiểm tra sức khỏe độc lập (healthcheck) cho Container orchestrator & Nginx
// Phản hồi trực tiếp trước httpLoggerMiddleware và metricsMiddleware để không ô nhiễm log và metrics người dùng
app.get('/healthz', (req, res) => {
  res.status(200).type('text/plain').send('OK');
});

// 2. Khởi động theo dõi HTTP request và metrics cho lưu lượng người dùng / nghiệp vụ
app.use(httpLoggerMiddleware);
app.use(metricsMiddleware);

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

// Thiet lap Secure cookie linh hoat:
// - Mac dinh 'auto': Tu dong bat Secure neu ket noi qua HTTPS (thong qua trust proxy X-Forwarded-Proto),
//   giu Secure=false khi chay localhost HTTP de khong lam mat cookie/session dang nhap.
// - Co the ghi de bang bien moi truong COOKIE_SECURE (true/false) khi can thiet.
const isCookieSecure = process.env.COOKIE_SECURE === 'true' 
  ? true 
  : (process.env.COOKIE_SECURE === 'false' ? false : 'auto');

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: {
    maxAge: 86400000,
    httpOnly: true,
    secure: isCookieSecure,
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

// Middleware xử lý lỗi tập trung
app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }
  const statusCode = err.status || err.statusCode || 500;
  if (statusCode >= 500) {
    return logger.sendServerError(res, req, 'unhandled_error', err);
  }

  // Xử lý các lỗi phân tích cú pháp (Parser errors) bằng thông báo an toàn, không rò rỉ nội dung body hoặc err.message
  if (err instanceof SyntaxError && statusCode === 400 && ('body' in err || err.type === 'entity.parse.failed')) {
    return res.status(400).json({
      error: 'Dữ liệu JSON không hợp lệ'
    });
  }

  if (err.type === 'entity.too.large') {
    return res.status(statusCode).json({
      error: 'Kích thước dữ liệu gửi lên vượt quá giới hạn'
    });
  }

  if (err.type === 'encoding.unsupported' || err.type === 'charset.unsupported') {
    return res.status(statusCode).json({
      error: 'Định dạng mã hóa không được hỗ trợ'
    });
  }

  // Giữ thông báo nghiệp vụ hiện có trong routes
  return res.status(statusCode).json({
    error: err.message || 'Yêu cầu không hợp lệ'
  });
});

async function startServer() {
  try {
    const [rows] = await pool.query("SELECT DATABASE() AS database_name");
    await pool.query("SELECT id FROM products LIMIT 1");

    console.log(`Kết nối MySQL thành công: ${rows[0].database_name}`);

    // Khởi động HTTP server riêng phục vụ Prometheus scrape tại 127.0.0.1:9101
    let metricsServer;
    try {
      metricsServer = await startMetricsServer(METRICS_PORT, METRICS_HOST);
      const actualMetricsPort = metricsServer.address().port;
      console.log(`Metrics server đang chạy tại http://${METRICS_HOST}:${actualMetricsPort}/metrics`);
      logger.info({
        event: 'metrics_server_started',
        host: METRICS_HOST,
        port: actualMetricsPort,
        requestedPort: METRICS_PORT
      });
    } catch (metricsError) {
      logger.error({
        event: 'metrics_server_startup_error',
        errorCode: metricsError.code || 'METRICS_STARTUP_ERROR',
        errorType: metricsError.name || 'Error',
        port: METRICS_PORT,
        host: METRICS_HOST
      });
      console.error(`[LỖI] Không thể khởi động Metrics server tại ${METRICS_HOST}:${METRICS_PORT} (${metricsError.code || metricsError.message})`);
      await pool.end();
      process.exit(1);
    }

    const server = http.createServer(app);

    server.on("error", (error) => {
      logger.error({
        event: 'server_startup_error',
        errorCode: error.code || 'STARTUP_ERROR',
        errorType: error.name || 'Error'
      });
      process.exit(1);
    });

    server.listen(PORT, HOST, () => {
      console.log(`Website đang chạy tại http://${HOST}:${PORT}`);
      logger.info({
        event: 'server_started',
        port: PORT,
        database: rows[0].database_name
      });
    });
  } catch (error) {
    logger.error({
      event: 'database_connection_error',
      errorCode: error.code || 'DB_ERROR',
      errorType: error.name || 'Error'
    });
    await pool.end();
    process.exit(1);
  }
}

startServer();