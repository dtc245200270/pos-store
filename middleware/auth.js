/**
 * ==============================================================================
 * DỰ ÁN POS STORE - TRUNG GIAN XÁC THỰC VÀ PHÂN QUYỀN (AUTHENTICATION & RBAC)
 * ==============================================================================
 * Tệp: middleware/auth.js
 * Mục đích:
 *   - Kiểm tra và đồng bộ trạng thái tài khoản từ MySQL vào phiên làm việc (Session).
 *   - Bảo vệ phân quyền truy cập theo vai trò: MANAGER (Quản lý) và CASHIER (Thu ngân).
 *   - Phòng chống tấn công CSRF (Cross-Site Request Forgery) bằng CSRF Token ngẫu nhiên.
 *   - Xử lý thu hồi phiên khi tài khoản bị khóa hoặc đổi mật khẩu.
 * ==============================================================================
 */

const path = require('path');
const crypto = require('crypto');
const pool = require('../config/db');
const logger = require('../config/logger');

/**
 * Kiểm tra tính hợp lệ của phiên làm việc đối chiếu trực tiếp với CSDL MySQL
 * - Chức năng:
 *     1. Xác nhận người dùng tồn tại và tài khoản đang kích hoạt (is_active = 1).
 *     2. Phát hiện trường hợp đổi mật khẩu: Nếu passwordHash trong session không khớp
 *        với password_hash trong DB -> phiên làm việc cũ ngay lập tức hết hiệu lực.
 *     3. Tự động đồng bộ vai trò (role) và trạng thái mới nhất vào session.
 * - Đầu vào: `req` (Express Request).
 * - Kết quả: Trả về `true` nếu phiên hợp lệ; `false` nếu tài khoản không tồn tại, bị khóa hoặc mật khẩu đã đổi.
 */
const verifySessionDB = async (req) => {
  if (!req.session || !req.session.userId) return false;
  try {
    const [users] = await pool.query(
      'SELECT role, is_active, password_hash FROM users WHERE id = ?',
      [req.session.userId]
    );
    if (users.length === 0) return false;
    const user = users[0];
    if (!user.is_active) return false;
    
    // Nếu session có lưu passwordHash mà khác với DB (mật khẩu đã bị đổi) -> phiên làm việc cũ không còn hợp lệ
    if (req.session.passwordHash && req.session.passwordHash !== user.password_hash) {
      return false;
    }

    // Cập nhật lại role/active trong session nếu có thay đổi
    req.session.role = user.role;
    req.session.isActive = user.is_active;
    return true;
  } catch (error) {
    logger.logServerError(req, 'verify_session_db', error);
    return false;
  }
};

/**
 * Middleware bắt buộc phải đăng nhập trước khi truy cập
 * - Nếu chưa đăng nhập hoặc phiên không hợp lệ: Hủy session, xóa cookie 'connect.sid'.
 * - Phản hồi: Trả về HTTP 401 JSON nếu là request /api/*, hoặc chuyển hướng đến trang /login nếu là trang giao diện.
 */
const requireLogin = async (req, res, next) => {
  const isValid = await verifySessionDB(req);
  if (isValid) {
    next();
  } else {
    // Xóa session nếu không hợp lệ
    if (req.session) {
      req.session.destroy();
      res.clearCookie('connect.sid');
    }
    
    if (req.originalUrl.startsWith('/api/')) {
      return res.status(401).json({ error: 'Vui lòng đăng nhập' });
    }
    res.redirect('/login');
  }
};

/**
 * Middleware phân quyền truy cập theo vai trò cụ thể (Role-Based Access Control)
 * - Đầu vào: `role` (Chuỗi: 'MANAGER' hoặc 'CASHIER').
 * - Hoạt động: Kiểm tra đăng nhập, sau đó so sánh `req.session.role === role`.
 * - Phản hồi lỗi: Trả về HTTP 403 JSON cho API hoặc hiển thị trang views/403.html cho người dùng.
 */
const requireRole = (role) => {
  return async (req, res, next) => {
    const isValid = await verifySessionDB(req);
    if (!isValid) {
      if (req.session) {
        req.session.destroy();
        res.clearCookie('connect.sid');
      }
      if (req.originalUrl.startsWith('/api/')) {
        return res.status(401).json({ error: 'Vui lòng đăng nhập' });
      }
      return res.redirect('/login');
    }

    if (req.session.role === role) {
      next();
    } else {
      if (req.originalUrl.startsWith('/api/')) {
        return res.status(403).json({ error: 'Không có quyền truy cập' });
      }
      res.status(403).sendFile(path.join(__dirname, '../views/403.html'));
    }
  };
};

/**
 * Middleware bảo vệ phòng chống tấn công CSRF
 * - Áp dụng cho các phương thức có tác động sửa đổi dữ liệu: POST, PUT, DELETE, PATCH.
 * - So sánh giá trị header `x-csrf-token` phía client gửi lên với `req.session.csrfToken`.
 * - Phản hồi: Trả về HTTP 403 JSON nếu token thiếu hoặc không khớp.
 */
const csrfProtection = (req, res, next) => {
  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    const clientToken = req.headers['x-csrf-token'];
    const serverToken = req.session.csrfToken;
    
    if (!clientToken || !serverToken || clientToken !== serverToken) {
      return res.status(403).json({ error: 'Lỗi CSRF Token không hợp lệ' });
    }
  }
  next();
};

/**
 * Endpoint sinh mã CSRF Token mới cho phiên làm việc
 * - Sinh chuỗi ngẫu nhiên 32 bytes (64 ký tự hex) bằng crypto.randomBytes nếu phiên chưa có.
 * - Trả về: Đối tượng JSON chứa `{ csrfToken: "..." }`.
 */
const generateCsrfToken = (req, res) => {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.json({ csrfToken: req.session.csrfToken });
};

module.exports = {
  verifySessionDB,
  requireLogin,
  requireRole,
  csrfProtection,
  generateCsrfToken
};
