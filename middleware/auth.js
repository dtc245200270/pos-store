const path = require('path');
const crypto = require('crypto');
const pool = require('../config/db');
const logger = require('../config/logger');

// Kiểm tra session hiện tại so với DB thực tế
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

const generateCsrfToken = (req, res) => {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  res.json({ csrfToken: req.session.csrfToken });
};

module.exports = {
  requireLogin,
  requireRole,
  csrfProtection,
  generateCsrfToken
};
