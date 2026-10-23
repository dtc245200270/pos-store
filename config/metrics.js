const http = require('http');
const client = require('prom-client');

// Khởi tạo Prometheus Registry dùng chung cho toàn bộ tiến trình ứng dụng
const register = new client.Registry();

// 1. Thu thập metrics mặc định của tiến trình Node.js (CPU, Memory, Event Loop, v.v.)
client.collectDefaultMetrics({
  register,
  prefix: ''
});

// 2. Metric đếm tổng số yêu cầu HTTP (Counter)
const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Tổng số yêu cầu HTTP đã xử lý',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register]
});

// 3. Metric đo thời gian xử lý yêu cầu HTTP (Histogram - đơn vị giây, có bucket 2 giây)
const httpRequestDurationSeconds = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Thời gian xử lý yêu cầu HTTP theo giây',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [register]
});

/**
 * Hàm chuẩn hóa đường dẫn để tránh bùng nổ cardinality nhãn (Label Cardinality Explosion)
 * - Không dùng requestId, userId, SKU, nội dung chuyển khoản, query string hoặc URL thô
 * - Thay thế các ID động bằng mẫu :id
 * - Gom các route không xác định vào nhãn UNMATCHED
 */
function normalizeRoute(req) {
  // 1. Nếu Express đã khớp route
  if (req.route && req.route.path) {
    const basePath = req.baseUrl || '';
    const routePath = req.route.path === '/' && basePath ? '' : req.route.path;
    return (basePath + routePath) || '/';
  }

  // 2. Dự phòng khi route chưa khớp (ví dụ lỗi phân tích cú pháp body trước routing, hoặc 404)
  const rawUrl = req.originalUrl || req.url || req.path || '/';
  const pathname = rawUrl.split('?')[0].split('#')[0];

  if (pathname.startsWith('/public/')) {
    return '/public/:file';
  }

  const staticPages = [
    '/', '/login', '/products', '/employees',
    '/sales', '/invoices', '/stock-receipts',
    '/inventory', '/profile', '/403'
  ];
  if (staticPages.includes(pathname)) {
    return pathname;
  }

  // Auth routes
  if (pathname === '/api/auth/csrf') return '/api/auth/csrf';
  if (pathname === '/api/auth/login') return '/api/auth/login';
  if (pathname === '/api/auth/logout') return '/api/auth/logout';
  if (pathname === '/api/auth/change-password') return '/api/auth/change-password';
  if (pathname === '/api/auth/me') return '/api/auth/me';

  // Dashboard routes
  if (pathname === '/api/dashboard/stats') return '/api/dashboard/stats';
  if (pathname === '/api/dashboard/revenue-trend') return '/api/dashboard/revenue-trend';
  if (pathname === '/api/dashboard/top-products') return '/api/dashboard/top-products';

  // Inventory routes
  if (pathname === '/api/inventory') return '/api/inventory';
  if (pathname === '/api/inventory/movements') return '/api/inventory/movements';
  if (pathname === '/api/inventory/check-stock') return '/api/inventory/check-stock';

  // Products routes
  if (pathname === '/api/products') return '/api/products';
  if (pathname === '/api/products/export') return '/api/products/export';
  if (pathname === '/api/products/search') return '/api/products/search';
  if (/^\/api\/products\/[^/]+$/.test(pathname)) return '/api/products/:id';

  // Employees routes
  if (pathname === '/api/employees') return '/api/employees';
  if (/^\/api\/employees\/[^/]+\/status$/.test(pathname)) return '/api/employees/:id/status';
  if (/^\/api\/employees\/[^/]+\/reset-password$/.test(pathname)) return '/api/employees/:id/reset-password';
  if (/^\/api\/employees\/[^/]+$/.test(pathname)) return '/api/employees/:id';

  // Stock Receipts routes
  if (pathname === '/api/stock-receipts') return '/api/stock-receipts';
  if (/^\/api\/stock-receipts\/[^/]+\/cancel$/.test(pathname)) return '/api/stock-receipts/:id/cancel';
  if (/^\/api\/stock-receipts\/[^/]+$/.test(pathname)) return '/api/stock-receipts/:id';

  // Invoices routes
  if (pathname === '/api/invoices') return '/api/invoices';
  if (/^\/api\/invoices\/[^/]+\/receipt$/.test(pathname)) return '/api/invoices/:id/receipt';
  if (/^\/api\/invoices\/[^/]+\/cancel$/.test(pathname)) return '/api/invoices/:id/cancel';
  if (/^\/api\/invoices\/[^/]+$/.test(pathname)) return '/api/invoices/:id';

  return 'UNMATCHED';
}

/**
 * Middleware đo lường HTTP request cho Express
 * - Bắt đầu đo từ đầu chuỗi (đo cả lỗi parser JSON, 400 Bad Request)
 * - Không làm mất requestId, không thay đổi phản hồi nghiệp vụ
 */
function metricsMiddleware(req, res, next) {
  const startTime = process.hrtime.bigint();

  res.on('finish', () => {
    try {
      const endTime = process.hrtime.bigint();
      const durationSeconds = Number(endTime - startTime) / 1e9;
      const statusCode = String(res.statusCode || 200);
      const method = req.method ? req.method.toUpperCase() : 'UNKNOWN';
      const route = normalizeRoute(req);

      const labels = {
        method,
        route,
        status_code: statusCode
      };

      httpRequestsTotal.inc(labels, 1);
      httpRequestDurationSeconds.observe(labels, durationSeconds);
    } catch (e) {
      // Đảm bảo không gián đoạn luồng xử lý
    }
  });

  next();
}

/**
 * Khởi động máy chủ HTTP riêng cho metrics tại 127.0.0.1:9101
 * - Sử dụng cùng registry của ứng dụng
 * - Không qua Nginx, không tạo phiên đăng nhập session
 * - Báo lỗi cổng rõ ràng nếu thất bại
 */
function startMetricsServer(port = 9101, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/metrics') {
        try {
          res.setHeader('Content-Type', register.contentType);
          const metrics = await register.metrics();
          res.writeHead(200);
          res.end(metrics);
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Lỗi khi thu thập metrics');
        }
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
      }
    });

    let started = false;

    server.once('error', (err) => {
      if (!started) {
        reject(err);
      }
    });

    server.listen(port, host, () => {
      started = true;
      resolve(server);
    });
  });
}

module.exports = {
  register,
  httpRequestsTotal,
  httpRequestDurationSeconds,
  metricsMiddleware,
  normalizeRoute,
  startMetricsServer
};
