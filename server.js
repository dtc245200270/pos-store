/**
 * ==============================================================================
 * DỰ ÁN POS STORE - MÁY CHỦ KHỞI CHẠY CHÍNH (BACKEND HTTP & API SERVER)
 * ==============================================================================
 * Tệp: server.js
 * Mục đích:
 *   - Điểm nhập chính (Entry point) của ứng dụng backend Node.js / Express.
 *   - Khởi tạo Express app, định tuyến API và các trang giao diện.
 *   - Thiết lập chính sách bảo mật: Trust Proxy (Nginx), Cookie/Session (MySQL Store),
 *     CSRF Protection, Request ID, Structured Logging và Prometheus Metrics.
 *   - Tách biệt cổng phục vụ ứng dụng người dùng (3000) và cổng nội bộ Prometheus scrape (9101).
 * ==============================================================================
 */

require("dotenv").config();

const http = require("http");
const express = require("express");
const session = require("express-session");
const pool = require("./config/db");

// Nạp các bộ định tuyến API và trang web
const authRoutes = require("./routes/auth");
const pageRoutes = require("./routes/pages");
const productRoutes = require("./routes/api/products");
const employeeRoutes = require("./routes/api/employees");
const stockReceiptRoutes = require("./routes/api/stock-receipts");
const invoiceRoutes = require("./routes/api/invoices");
const inventoryRoutes = require("./routes/api/inventory");
const dashboardRoutes = require("./routes/api/dashboard");

// Nạp các middleware bảo mật, theo dõi và ghi log
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

// Vô hiệu hóa header X-Powered-By để phòng tránh rò rỉ thông tin nền tảng Express
app.disable('x-powered-by');

// Danh sách địa chỉ IP proxy được phép tin cậy (Nginx reverse proxy trong Docker hoặc loopback cục bộ)
const dns = require('dns');
const trustedProxyIps = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Hàm làm mới địa chỉ IP của container Nginx qua DNS nội bộ Docker network
 * - Mục đích: Khi Docker Compose tái tạo container Nginx, IP nội bộ có thể thay đổi.
 * - Đầu vào: Không có.
 * - Kết quả: Tự động bổ sung địa chỉ IP IPv4 và IPv6 mapped vào tập hợp `trustedProxyIps`.
 */
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
// Định kỳ 15 giây phân giải lại DNS Nginx để thích ứng với việc restart container
const proxyRefreshTimer = setInterval(refreshNginxProxyIp, 15000);
if (proxyRefreshTimer.unref) proxyRefreshTimer.unref();

// Chính sách Trust Proxy chặt chẽ:
// - CHỈ tin cậy hop proxy đầu tiên (i === 0) nếu kết nối xuất phát từ Nginx container hoặc loopback.
// - KHÔNG tin cậy các header X-Forwarded-* giả mạo khi client kết nối trực tiếp vào cổng 3000.
app.set('trust proxy', (ip, i) => {
  if (i === 0) {
    const cleanIp = String(ip).replace(/^::ffff:/, '');
    return trustedProxyIps.has(cleanIp) || cleanIp === '127.0.0.1' || cleanIp === '::1';
  }
  return false;
});

// Kiểm tra biến môi trường SESSION_SECRET bắt buộc
if (!process.env.SESSION_SECRET) {
  console.error("Lỗi: Bắt buộc phải có SESSION_SECRET trong file .env");
  process.exit(1);
}

// 1. Cấp mã định danh yêu cầu (requestId) cho toàn bộ request để phục vụ truy vết phân tán
app.use(requestIdMiddleware);

// 2. Endpoint kiểm tra sức khỏe độc lập (healthcheck) cho Container orchestrator & Nginx
// - Phản hồi trực tiếp trước httpLoggerMiddleware và metricsMiddleware để không làm ô nhiễm log và metrics nghiệp vụ
app.get('/healthz', (req, res) => {
  res.status(200).type('text/plain').send('OK');
});

// 3. Khởi động theo dõi HTTP request và metrics Prometheus cho lưu lượng người dùng / nghiệp vụ
app.use(httpLoggerMiddleware);
app.use(metricsMiddleware);

// Phân tích cú pháp dữ liệu gửi lên (Body Parser)
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// 4. Cấu hình lưu trữ phiên làm việc tập trung trong MySQL (express-mysql-session)
// - Yêu cầu: Đã chạy file migration_01_sessions.sql để tạo bảng sessions trước đó.
// - Tự động xóa phiên hết hạn mỗi 15 phút (900.000 ms); thời gian sống của phiên là 1 ngày (86.400.000 ms).
// - createDatabaseTable: false vì user phân quyền ứng dụng (pos_app) không có quyền CREATE TABLE.
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
  createDatabaseTable: false
});

// 5. Thiết lập thuộc tính Secure cho Cookie linh hoạt:
// - Mặc định 'auto': Tự động bật Secure=true nếu kết nối qua HTTPS (thông qua trust proxy X-Forwarded-Proto),
//   và giữ Secure=false khi chạy localhost HTTP để không làm mất phiên đăng nhập.
// - Cho phép ghi đè tường minh bằng biến môi trường COOKIE_SECURE (true/false) khi cần thiết.
const isCookieSecure = process.env.COOKIE_SECURE === 'true' 
  ? true 
  : (process.env.COOKIE_SECURE === 'false' ? false : 'auto');

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: {
    maxAge: 86400000, // 24 giờ
    httpOnly: true,   // Chống truy cập cookie từ JavaScript phía client (giảm rủi ro XSS)
    secure: isCookieSecure,
    sameSite: 'lax'   // Cân bằng giữa bảo mật CSRF và trải nghiệm điều hướng trình duyệt
  }
}));

// Thư mục static công khai (chỉ chứa tệp tĩnh JS, CSS, hình ảnh; không chứa trang HTML nghiệp vụ)
app.use('/public', express.static('public'));

// 6. Đăng ký các tuyến đường (Routes) với lớp bảo vệ CSRF tương ứng
app.use('/api/auth', authRoutes);
app.use('/api/products', csrfProtection, productRoutes);
app.use('/api/employees', csrfProtection, employeeRoutes);
app.use('/api/stock-receipts', csrfProtection, stockReceiptRoutes);
app.use('/api/invoices', csrfProtection, invoiceRoutes);
app.use('/api/inventory', csrfProtection, inventoryRoutes);
app.use('/api/dashboard', csrfProtection, dashboardRoutes);
app.use('/', pageRoutes);

// 7. Middleware xử lý lỗi tập trung (Global Error Handling Middleware)
// - Bắt toàn bộ ngoại lệ chưa được xử lý trong ứng dụng Express.
// - Phân loại mã lỗi HTTP và chuẩn hóa phản hồi JSON an toàn, không để lộ stack trace ra ngoài.
app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }
  const statusCode = err.status || err.statusCode || 500;
  if (statusCode >= 500) {
    return logger.sendServerError(res, req, 'unhandled_error', err);
  }

  // Xử lý các lỗi phân tích cú pháp (JSON Parser errors) với thông báo an toàn
  if (err instanceof SyntaxError && statusCode === 400 && ('body' in err || err.type === 'entity.parse.failed')) {
    return res.status(400).json({
      error: 'Dữ liệu JSON không hợp lệ'
    });
  }

  // Lỗi kích thước payload vượt quá giới hạn
  if (err.type === 'entity.too.large') {
    return res.status(statusCode).json({
      error: 'Kích thước dữ liệu gửi lên vượt quá giới hạn'
    });
  }

  // Lỗi định dạng mã hóa ký tự không được hỗ trợ
  if (err.type === 'encoding.unsupported' || err.type === 'charset.unsupported') {
    return res.status(statusCode).json({
      error: 'Định dạng mã hóa không được hỗ trợ'
    });
  }

  // Giữ nguyên thông báo lỗi nghiệp vụ hợp lệ đã được kiểm soát từ routes
  return res.status(statusCode).json({
    error: err.message || 'Yêu cầu không hợp lệ'
  });
});

/**
 * Khởi động toàn bộ dịch vụ backend:
 *   Bước 1: Kiểm tra kết nối CSDL MySQL và xác nhận quyền truy cập bảng products.
 *   Bước 2: Khởi động HTTP server riêng phục vụ Prometheus scrape tại cổng METRICS_PORT (mặc định 9101).
 *   Bước 3: Lắng nghe kết nối HTTP ứng dụng tại cổng PORT (mặc định 3000).
 *   Xử lý lỗi: Nếu kết nối DB hoặc khởi động metrics thất bại, ghi log có cấu trúc và dừng tiến trình (exit 1).
 */
async function startServer() {
  try {
    // Bước 1: Kiểm tra kết nối tới MySQL và kiểm tra bảng dữ liệu cơ bản
    const [rows] = await pool.query("SELECT DATABASE() AS database_name");
    await pool.query("SELECT id FROM products LIMIT 1");

    console.log(`Kết nối MySQL thành công: ${rows[0].database_name}`);

    // Bước 2: Khởi động HTTP server riêng phục vụ Prometheus scrape tại 127.0.0.1:9101
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

    // Bước 3: Khởi tạo HTTP server chính cho ứng dụng Express
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

// Kích hoạt tiến trình khởi động server
startServer();