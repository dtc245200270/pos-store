/**
 * ==============================================================================
 * DỰ ÁN POS STORE - TRUNG GIAN ĐỊNH DANH YÊU CẦU (DISTRIBUTED REQUEST ID)
 * ==============================================================================
 * Tệp: middleware/request-id.js
 * Mục đích:
 *   - Tiếp nhận mã X-Request-ID từ client/Nginx hoặc tự động sinh UUID v4 mới.
 *   - Gán `req.requestId` xuyên suốt vòng đời xử lý request.
 *   - Trả về header `X-Request-ID` trong HTTP response để liên kết truy vết (tracing) giữa client, backend và log hệ thống.
 * ==============================================================================
 */

const crypto = require('crypto');

/**
 * Middleware cấp phát và phản hồi mã định danh yêu cầu duy nhất
 */
function requestIdMiddleware(req, res, next) {
  const incomingId = req.headers['x-request-id'];
  const requestId = (incomingId && typeof incomingId === 'string' && incomingId.trim()) 
    ? incomingId.trim() 
    : crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);
  next();
}

module.exports = requestIdMiddleware;
