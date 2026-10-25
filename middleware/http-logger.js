/**
 * ==============================================================================
 * DỰ ÁN POS STORE - TRUNG GIAN GHI NHẬT KÝ HTTP REQUEST (HTTP ACCESS LOGGER)
 * ==============================================================================
 * Tệp: middleware/http-logger.js
 * Mục đích:
 *   - Lắng nghe sự kiện hoàn tất (finish) của mỗi HTTP request và đo lường thời gian xử lý (durationMs).
 *   - Tự động gắn nhãn cấp độ log: 5xx -> error, 4xx -> warn, 2xx/3xx -> info.
 *   - Trích xuất dữ liệu sạch: path (đã loại bỏ query string), client IP, Request ID và User ID.
 *   - Bỏ qua endpoint nội bộ /healthz để tránh làm đầy dung lượng lưu trữ nhật ký.
 * ==============================================================================
 */

const logger = require('../config/logger');

/**
 * Middleware đo lường và ghi log cho các yêu cầu HTTP
 */
function httpLoggerMiddleware(req, res, next) {
  const rawUrl = req.originalUrl || req.url || req.path || '/';
  const pathOnly = rawUrl.split('?')[0];

  // Bỏ qua hoàn toàn request healthcheck nội bộ
  if (pathOnly === '/healthz') {
    return next();
  }

  // Ghi lại mốc thời gian bắt đầu với độ chính xác nanosecond
  const startTime = process.hrtime.bigint();

  res.on('finish', () => {
    try {
      const endTime = process.hrtime.bigint();
      // Thời gian thực thi (milliseconds), làm tròn 2 chữ số thập phân
      const durationMs = Number((Number(endTime - startTime) / 1e6).toFixed(2));
      const statusCode = res.statusCode;

      let level = 'info';
      if (statusCode >= 500) {
        level = 'error';
      } else if (statusCode >= 400) {
        level = 'warn';
      }

      // Trích xuất đường dẫn sạch không chứa query string
      const rawUrl = req.originalUrl || req.url || req.path || '/';
      const pathOnly = rawUrl.split('?')[0];

      const logData = {
        level,
        requestId: req.requestId || 'unknown',
        method: req.method,
        path: pathOnly,
        statusCode,
        durationMs,
        clientIp: req.ip,
        remoteIp: req.socket.remoteAddress,
        protocol: req.protocol,
        hostname: req.hostname
      };

      if (req.session && req.session.userId) {
        logData.userId = req.session.userId;
      }
      if (req.session && req.session.role) {
        logData.role = req.session.role;
      }

      logger.logHttpRequest(logData);
    } catch (err) {
      // Đảm bảo không làm ảnh hưởng luồng phản hồi
    }
  });

  next();
}

module.exports = httpLoggerMiddleware;
