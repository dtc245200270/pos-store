const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../config/db');
const logger = require('../config/logger');
const router = express.Router();

const { generateCsrfToken, csrfProtection, verifySessionDB, requireLogin } = require('../middleware/auth');

// Quản lý số lần thử đăng nhập theo tài khoản (chống dò mật khẩu theo tài khoản, không khóa nhầm IP dùng chung)
const accountLoginAttempts = new Map();

// Cấu hình giới hạn: Tối đa 5 lần thử sai, khóa 15 phút
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 phút (900 giây)

function getAccountAttempts(username) {
  if (!username) return null;
  const key = String(username).trim().toLowerCase();
  const entry = accountLoginAttempts.get(key);
  if (!entry) return null;

  // Nếu đã hết thời gian chặn, tự động xóa bộ đếm cũ để cho phép thử lại
  if (entry.lockUntil && entry.lockUntil <= Date.now()) {
    accountLoginAttempts.delete(key);
    return null;
  }
  return entry;
}

function recordFailedAttempt(username) {
  if (!username) return null;
  const key = String(username).trim().toLowerCase();
  let entry = accountLoginAttempts.get(key);

  // Nếu chưa có hoặc thời gian chặn cũ đã hết hạn, bắt đầu chu kỳ đếm mới
  if (!entry || (entry.lockUntil && entry.lockUntil <= Date.now())) {
    entry = { count: 0, lockUntil: 0 };
  }

  entry.count += 1;
  if (entry.count >= MAX_FAILED_ATTEMPTS) {
    entry.lockUntil = Date.now() + LOCKOUT_DURATION_MS;
  }
  accountLoginAttempts.set(key, entry);
  return entry;
}

function clearLoginAttempts(username) {
  if (!username) return;
  const key = String(username).trim().toLowerCase();
  accountLoginAttempts.delete(key);
}

function formatLockoutError(lockUntil) {
  const remainingMs = Math.max(0, lockUntil - Date.now());
  const remainingSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
  const remainingMinutes = Math.ceil(remainingSeconds / 60);

  const unlockDate = new Date(lockUntil);
  const unlockTimeVN = unlockDate.toLocaleTimeString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour12: false
  });

  const timeDesc = remainingSeconds >= 60
    ? `${remainingMinutes} phút (vào lúc ${unlockTimeVN})`
    : `${remainingSeconds} giây (vào lúc ${unlockTimeVN})`;

  return {
    error: `Quá nhiều lần thử sai. Vui lòng thử lại sau ${timeDesc}.`,
    retryAfterSeconds: remainingSeconds,
    lockUntil
  };
}

router.get('/csrf', generateCsrfToken);

router.post('/login', csrfProtection, async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Vui lòng nhập tên đăng nhập và mật khẩu' });
  }

  const cleanUsername = String(username).trim().toLowerCase();

  // Kiểm tra giới hạn đăng nhập theo tài khoản
  const attempts = getAccountAttempts(cleanUsername);
  if (attempts && attempts.lockUntil > Date.now()) {
    const lockoutInfo = formatLockoutError(attempts.lockUntil);
    res.set('Retry-After', String(lockoutInfo.retryAfterSeconds));
    return res.status(429).json(lockoutInfo);
  }

  try {
    const [users] = await pool.query(
      'SELECT id, username, password_hash, full_name, role, is_active FROM users WHERE username = ?',
      [username.trim()]
    );

    const user = users[0];

    if (!user || !user.is_active) {
      const failedEntry = recordFailedAttempt(cleanUsername);
      if (failedEntry && failedEntry.lockUntil > Date.now()) {
        const lockoutInfo = formatLockoutError(failedEntry.lockUntil);
        res.set('Retry-After', String(lockoutInfo.retryAfterSeconds));
        return res.status(429).json(lockoutInfo);
      }
      return res.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu không đúng, hoặc tài khoản đã bị vô hiệu hóa.' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      const failedEntry = recordFailedAttempt(cleanUsername);
      if (failedEntry && failedEntry.lockUntil > Date.now()) {
        const lockoutInfo = formatLockoutError(failedEntry.lockUntil);
        res.set('Retry-After', String(lockoutInfo.retryAfterSeconds));
        return res.status(429).json(lockoutInfo);
      }
      return res.status(401).json({ error: 'Tên đăng nhập hoặc mật khẩu không đúng.' });
    }

    // Đăng nhập thành công, xóa bộ đếm thất bại của tài khoản tương ứng
    clearLoginAttempts(cleanUsername);

    // Tạo lại session ID (chống Session Fixation)
    req.session.regenerate((err) => {
      if (err) {
        return logger.sendServerError(res, req, 'login_regenerate_session', err);
      }

      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.fullName = user.full_name;
      req.session.role = user.role;
      req.session.isActive = user.is_active;
      req.session.passwordHash = user.password_hash;
      // Sinh CSRF token mới sau khi tái tạo session
      req.session.csrfToken = require('crypto').randomBytes(32).toString('hex');

      req.session.save((saveErr) => {
        if (saveErr) {
          return logger.sendServerError(res, req, 'login_save_session', saveErr);
        }
        res.json({ message: 'Đăng nhập thành công', role: user.role, csrfToken: req.session.csrfToken });
      });
    });

  } catch (error) {
    return logger.sendServerError(res, req, 'login', error);
  }
});

router.post('/logout', requireLogin, csrfProtection, (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return logger.sendServerError(res, req, 'logout', err);
    }
    res.clearCookie('connect.sid'); // Tên cookie mặc định của express-session
    res.json({ message: 'Đăng xuất thành công' });
  });
});

// Đổi mật khẩu cá nhân (yêu cầu mật khẩu hiện tại, mật khẩu mới, xác nhận mật khẩu mới)
router.post('/change-password', requireLogin, csrfProtection, async (req, res) => {
  const { current_password, new_password, confirm_password } = req.body;

  if (!current_password || !new_password || !confirm_password) {
    return res.status(400).json({ error: 'Vui lòng nhập đầy đủ thông tin: mật khẩu hiện tại, mật khẩu mới và xác nhận mật khẩu' });
  }

  if (new_password.length < 8) {
    return res.status(400).json({ error: 'Mật khẩu mới phải có ít nhất 8 ký tự' });
  }

  if (new_password !== confirm_password) {
    return res.status(400).json({ error: 'Xác nhận mật khẩu mới không khớp' });
  }

  if (current_password === new_password) {
    return res.status(400).json({ error: 'Mật khẩu mới không được trùng với mật khẩu hiện tại' });
  }

  const userId = req.session.userId;

  try {
    const [users] = await pool.query(
      'SELECT id, password_hash FROM users WHERE id = ?',
      [userId]
    );

    if (users.length === 0) {
      return res.status(404).json({ error: 'Không tìm thấy người dùng' });
    }

    const user = users[0];
    const isMatch = await bcrypt.compare(current_password, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ error: 'Mật khẩu hiện tại không chính xác' });
    }

    const salt = await bcrypt.genSalt(10);
    const newPasswordHash = await bcrypt.hash(new_password, salt);

    await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [newPasswordHash, userId]);

    // Xóa bộ đếm thất bại của tài khoản khi đổi mật khẩu thành công
    if (req.session.username) {
      clearLoginAttempts(req.session.username);
    }

    // Vô hiệu hóa tất cả các phiên cũ của tài khoản trong bảng sessions bằng cách so sánh chính xác JSON userId
    try {
      await pool.query(
        `DELETE FROM sessions 
         WHERE JSON_VALID(data) = 1 
           AND CAST(JSON_EXTRACT(data, '$.userId') AS UNSIGNED) = ?`,
        [Number(userId)]
      );
    } catch (sessErr) {
      logger.logServerError(req, 'cleanup_sessions_after_password_change', sessErr);
    }

    // Hủy session hiện tại phía server và xóa cookie
    req.session.destroy((err) => {
      if (err) {
        logger.logServerError(req, 'destroy_session_after_password_change', err);
      }
      res.clearCookie('connect.sid');
      res.json({ message: 'Đổi mật khẩu thành công. Vui lòng đăng nhập lại.' });
    });

  } catch (error) {
    return logger.sendServerError(res, req, 'change_password', error);
  }
});

router.get('/me', requireLogin, async (req, res) => {
  // requireLogin đã tự động cập nhật session.role từ DB mới nhất
  res.json({
    userId: req.session.userId,
    username: req.session.username,
    fullName: req.session.fullName,
    role: req.session.role
  });
});

router.clearLoginAttempts = clearLoginAttempts;
router.getAccountAttempts = getAccountAttempts;
router.recordFailedAttempt = recordFailedAttempt;
router.accountLoginAttempts = accountLoginAttempts;

module.exports = router;
