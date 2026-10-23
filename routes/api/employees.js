const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../../config/db');
const { requireRole } = require('../../middleware/auth');
const logger = require('../../config/logger');

const router = express.Router();

// Định danh tài khoản quản trị hệ thống phía server (không dựa vào họ tên hay dữ liệu client)
const SYSTEM_ADMIN_USERNAME = (process.env.SYSTEM_ADMIN_USERNAME || 'manager').trim().toLowerCase();

function isSystemAdmin(username) {
  if (!username) return false;
  return String(username).trim().toLowerCase() === SYSTEM_ADMIN_USERNAME;
}

// Tất cả endpoints của employees chỉ dành riêng cho MANAGER
router.use(requireRole('MANAGER'));

// 1. Lấy danh sách nhân viên (hỗ trợ tìm kiếm theo tên đăng nhập / họ tên, lọc theo trạng thái)
router.get('/', async (req, res) => {
  try {
    const { q, status } = req.query;
    let query = 'SELECT id, username, full_name, role, is_active, created_at FROM users WHERE 1=1';
    const params = [];

    if (q && q.trim()) {
      query += ' AND (username LIKE ? OR full_name LIKE ?)';
      const search = `%${q.trim()}%`;
      params.push(search, search);
    }

    if (status === 'active') {
      query += ' AND is_active = 1';
    } else if (status === 'locked') {
      query += ' AND is_active = 0';
    }

    query += ' ORDER BY created_at DESC';
    const [rows] = await pool.query(query, params);
    const result = rows.map(user => ({
      ...user,
      is_system: isSystemAdmin(user.username)
    }));
    res.json(result);
  } catch (error) {
    return logger.sendServerError(res, req, 'get_employees', error);
  }
});

// 2. Thêm thu ngân / nhân viên mới
router.post('/', async (req, res) => {
  const { username, full_name, password, confirm_password, role } = req.body;

  if (!username || !username.trim() || !full_name || !full_name.trim() || !password) {
    return res.status(400).json({ error: 'Vui lòng điền đầy đủ thông tin: tên đăng nhập, họ tên và mật khẩu' });
  }

  const cleanUsername = username.trim();
  const cleanFullName = full_name.trim();

  if (password.length < 8) {
    return res.status(400).json({ error: 'Mật khẩu phải có ít nhất 8 ký tự' });
  }

  if (confirm_password !== undefined && password !== confirm_password) {
    return res.status(400).json({ error: 'Mật khẩu xác nhận không khớp' });
  }

  const assignedRole = role || 'CASHIER';
  if (assignedRole !== 'MANAGER' && assignedRole !== 'CASHIER') {
    return res.status(400).json({ error: 'Vai trò không hợp lệ' });
  }

  try {
    if (isSystemAdmin(cleanUsername)) {
      return res.status(400).json({ error: 'Tên đăng nhập này được dành riêng cho tài khoản hệ thống' });
    }

    // Kiểm tra tên đăng nhập duy nhất
    const [existing] = await pool.query('SELECT id FROM users WHERE LOWER(username) = LOWER(?)', [cleanUsername]);
    if (existing.length > 0) {
      return res.status(400).json({ error: 'Tên đăng nhập đã tồn tại trong hệ thống' });
    }

    // Băm mật khẩu bằng bcrypt (không log mật khẩu)
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const [result] = await pool.query(
      'INSERT INTO users (username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, 1)',
      [cleanUsername, passwordHash, cleanFullName, assignedRole]
    );

    res.status(201).json({ message: 'Tạo tài khoản nhân viên thành công', id: result.insertId });
  } catch (error) {
    return logger.sendServerError(res, req, 'create_employee', error);
  }
});

// 3. Sửa họ tên & vai trò nhân viên
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { full_name, role } = req.body;

  if (!full_name || !full_name.trim()) {
    return res.status(400).json({ error: 'Họ tên không được để trống' });
  }

  const cleanFullName = full_name.trim();

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // Khóa thống nhất các tài khoản Quản lý theo thứ tự id để chống race condition và deadlock
    const [managerRows] = await connection.query(
      'SELECT id, username, role, is_active FROM users WHERE role = "MANAGER" ORDER BY id ASC FOR UPDATE'
    );

    const [users] = await connection.query(
      'SELECT id, username, role, is_active FROM users WHERE id = ? FOR UPDATE',
      [id]
    );
    if (users.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Không tìm thấy tài khoản nhân viên' });
    }
    const targetUser = users[0];

    // Chặn mọi thao tác sửa thông tin, đổi hoặc hạ vai trò đối với tài khoản quản trị hệ thống
    if (isSystemAdmin(targetUser.username)) {
      await connection.rollback();
      return res.status(403).json({ error: 'Tài khoản quản trị hệ thống được bảo vệ, không thể chỉnh sửa thông tin hoặc vai trò' });
    }

    const targetRole = role || targetUser.role;
    if (targetRole !== 'MANAGER' && targetRole !== 'CASHIER') {
      await connection.rollback();
      return res.status(400).json({ error: 'Vai trò không hợp lệ' });
    }

    // Kiểm tra bảo vệ khi hạ quyền quản lý
    if (targetUser.role === 'MANAGER' && targetRole !== 'MANAGER') {
      const otherManagers = managerRows.filter(m => m.id !== Number(id));
      const otherActiveManagers = otherManagers.filter(m => m.is_active === 1);

      if (otherManagers.length === 0 || (targetUser.is_active === 1 && otherActiveManagers.length === 0)) {
        await connection.rollback();
        const selfMsg = Number(id) === req.session.userId ? ' (không thể tự hạ quyền của chính mình)' : '';
        return res.status(400).json({ error: `Không thể đổi vai trò quản lý cuối cùng thành Thu ngân${selfMsg}` });
      }

      // Không cho tự hạ quyền của chính mình
      if (Number(id) === req.session.userId) {
        await connection.rollback();
        return res.status(400).json({ error: 'Không thể tự hạ quyền của chính mình' });
      }
    }

    await connection.query(
      'UPDATE users SET full_name = ?, role = ? WHERE id = ?',
      [cleanFullName, targetRole, id]
    );

    await connection.commit();
    res.json({ message: 'Cập nhật tài khoản thành công' });
  } catch (error) {
    await connection.rollback();
    return logger.sendServerError(res, req, 'update_employee', error);
  } finally {
    connection.release();
  }
});

// 4. Khóa / Mở khóa tài khoản nhân viên
router.patch('/:id/toggle-active', async (req, res) => {
  const { id } = req.params;
  const { is_active } = req.body;

  if (is_active === undefined) {
    return res.status(400).json({ error: 'Thiếu trạng thái kích hoạt' });
  }

  const newStatus = (is_active === true || is_active === 1 || is_active === 'true' || is_active === '1') ? 1 : 0;

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // Khóa thống nhất các tài khoản Quản lý theo thứ tự id để chống race condition và deadlock
    const [managerRows] = await connection.query(
      'SELECT id, username, role, is_active FROM users WHERE role = "MANAGER" ORDER BY id ASC FOR UPDATE'
    );

    const [users] = await connection.query(
      'SELECT id, username, role, is_active FROM users WHERE id = ? FOR UPDATE',
      [id]
    );
    if (users.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Không tìm thấy tài khoản nhân viên' });
    }
    const targetUser = users[0];

    // Chặn mọi thao tác khóa / vô hiệu hóa / thay đổi trạng thái đối với tài khoản quản trị hệ thống
    if (isSystemAdmin(targetUser.username)) {
      await connection.rollback();
      return res.status(403).json({ error: 'Tài khoản quản trị hệ thống được bảo vệ, không thể thay đổi trạng thái hoạt động' });
    }

    // Khi thực hiện KHÓA tài khoản (newStatus === 0)
    if (newStatus === 0) {
      // 1. Không cho khóa quản lý hoạt động cuối cùng
      if (targetUser.role === 'MANAGER' && targetUser.is_active === 1) {
        const otherActiveManagers = managerRows.filter(m => m.id !== Number(id) && m.is_active === 1);
        if (otherActiveManagers.length === 0) {
          await connection.rollback();
          const selfMsg = Number(id) === req.session.userId ? ' (không thể tự khóa tài khoản của chính mình)' : '';
          return res.status(400).json({ error: `Không thể khóa tài khoản quản lý cuối cùng trong hệ thống${selfMsg}` });
        }
      }

      // 2. Không thể tự khóa tài khoản của chính mình
      if (Number(id) === req.session.userId) {
        await connection.rollback();
        return res.status(400).json({ error: 'Không thể tự khóa tài khoản của chính mình' });
      }
    }

    await connection.query('UPDATE users SET is_active = ? WHERE id = ?', [newStatus, id]);
    await connection.commit();

    if (newStatus === 1) {
      const authRoutes = require('../auth');
      if (authRoutes && authRoutes.clearLoginAttempts) {
        authRoutes.clearLoginAttempts(targetUser.username);
      }
    }

    res.json({
      message: newStatus === 1 ? 'Mở khóa tài khoản thành công' : 'Đã khóa tài khoản thành công',
      is_active: Boolean(newStatus)
    });
  } catch (error) {
    await connection.rollback();
    return logger.sendServerError(res, req, 'toggle_employee_active', error);
  } finally {
    connection.release();
  }
});

// 5. Đặt lại mật khẩu (không trả mật khẩu cũ, không log mật khẩu)
router.patch('/:id/reset-password', async (req, res) => {
  const { id } = req.params;
  const { password, confirm_password } = req.body;

  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Mật khẩu mới phải có ít nhất 8 ký tự' });
  }

  if (confirm_password !== undefined && password !== confirm_password) {
    return res.status(400).json({ error: 'Mật khẩu xác nhận không khớp' });
  }

  try {
    const [users] = await pool.query('SELECT id, username FROM users WHERE id = ?', [id]);
    if (users.length === 0) {
      return res.status(404).json({ error: 'Không tìm thấy tài khoản nhân viên' });
    }
    const targetUser = users[0];

    // Chặn đặt lại mật khẩu tài khoản quản trị hệ thống qua API quản lý nhân viên
    if (isSystemAdmin(targetUser.username)) {
      return res.status(403).json({ error: 'Không thể đặt lại mật khẩu của tài khoản quản trị hệ thống qua giao diện quản lý nhân viên' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, id]);

    // Hủy các phiên đăng nhập cũ của nhân viên trong bảng sessions bằng cách so sánh chính xác JSON userId
    try {
      await pool.query(
        `DELETE FROM sessions 
         WHERE JSON_VALID(data) = 1 
           AND CAST(JSON_EXTRACT(data, '$.userId') AS UNSIGNED) = ?`,
        [Number(targetUser.id)]
      );
    } catch (sessErr) {
      logger.logServerError(req, 'cleanup_sessions_after_reset_password', sessErr);
    }

    // Xóa bộ đếm đăng nhập thất bại để nhân viên có thể đăng nhập ngay với mật khẩu mới
    const authRoutes = require('../auth');
    if (authRoutes && authRoutes.clearLoginAttempts) {
      authRoutes.clearLoginAttempts(targetUser.username);
    }

    res.json({ message: 'Đặt lại mật khẩu thành công' });
  } catch (error) {
    return logger.sendServerError(res, req, 'reset_password', error);
  }
});

// 6. Xóa tài khoản (chỉ xóa nếu tài khoản chưa có chứng từ / giao dịch liên quan)
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // Khóa thống nhất các tài khoản Quản lý theo thứ tự id để chống race condition và deadlock
    const [managerRows] = await connection.query(
      'SELECT id, username, role, is_active FROM users WHERE role = "MANAGER" ORDER BY id ASC FOR UPDATE'
    );

    const [users] = await connection.query(
      'SELECT id, username, role, is_active FROM users WHERE id = ? FOR UPDATE',
      [id]
    );
    if (users.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Không tìm thấy tài khoản' });
    }
    const targetUser = users[0];

    // Chặn xóa tài khoản quản trị hệ thống
    if (isSystemAdmin(targetUser.username)) {
      await connection.rollback();
      return res.status(403).json({ error: 'Tài khoản quản trị hệ thống được bảo vệ, không thể xóa' });
    }

    // 1. Không cho xóa quản lý cuối cùng
    if (targetUser.role === 'MANAGER') {
      const otherManagers = managerRows.filter(m => m.id !== Number(id));
      const otherActiveManagers = otherManagers.filter(m => m.is_active === 1);

      if (otherManagers.length === 0 || (targetUser.is_active === 1 && otherActiveManagers.length === 0)) {
        await connection.rollback();
        const selfMsg = Number(id) === req.session.userId ? ' (không thể tự xóa tài khoản của chính mình)' : '';
        return res.status(400).json({ error: `Không thể xóa tài khoản quản lý cuối cùng trong hệ thống${selfMsg}` });
      }
    }

    // 2. Không thể tự xóa tài khoản của chính mình
    if (Number(id) === req.session.userId) {
      await connection.rollback();
      return res.status(400).json({ error: 'Không thể tự xóa tài khoản của chính mình' });
    }

    // 3. Kiểm tra chứng từ hóa đơn bán hàng
    const [[{ invCount }]] = await connection.query('SELECT COUNT(*) as invCount FROM invoices WHERE created_by = ?', [id]);
    if (invCount > 0) {
      await connection.rollback();
      return res.status(400).json({ error: 'Không thể xóa tài khoản đã lập hóa đơn bán hàng. Vui lòng sử dụng tính năng Khóa tài khoản.' });
    }

    // 4. Kiểm tra chứng từ phiếu nhập hàng
    const [[{ srCount }]] = await connection.query('SELECT COUNT(*) as srCount FROM stock_receipts WHERE created_by = ?', [id]);
    if (srCount > 0) {
      await connection.rollback();
      return res.status(400).json({ error: 'Không thể xóa tài khoản đã lập phiếu nhập hàng. Vui lòng sử dụng tính năng Khóa tài khoản.' });
    }

    await connection.query('DELETE FROM users WHERE id = ?', [id]);
    await connection.commit();
    res.json({ message: 'Xóa tài khoản thành công' });
  } catch (error) {
    await connection.rollback();
    return logger.sendServerError(res, req, 'delete_employee', error);
  } finally {
    connection.release();
  }
});

module.exports = router;
