const logger = require('../config/logger');

function httpLoggerMiddleware(req, res, next) {
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
        durationMs
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
