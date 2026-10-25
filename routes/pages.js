/**
 * ==============================================================================
 * DỰ ÁN POS STORE - ĐỊNH TUYẾN CÁC TRANG GIAO DIỆN HTML (PAGE ROUTING)
 * ==============================================================================
 * Tệp: routes/pages.js
 * Mục đích:
 *   - Phục vụ các trang giao diện HTML tĩnh từ thư mục 'views/'.
 *   - Điều hướng tự động: Người dùng đã đăng nhập vào /login sẽ tự động chuyển tới
 *     trang bán hàng (/sales) đối với CASHIER hoặc trang tổng quan (/) đối với MANAGER.
 *   - Phân quyền trang bằng middleware requireRole:
 *       + Quản lý (MANAGER): /, /products, /employees, /stock-receipts.
 *       + Chung (cả Quản lý & Thu ngân): /sales, /invoices, /inventory, /profile.
 * ==============================================================================
 */

const express = require('express');
const path = require('path');
const { requireLogin, requireRole } = require('../middleware/auth');
const router = express.Router();

const viewsPath = path.join(__dirname, '../views');

// 1. Trang đăng nhập (Công khai - không yêu cầu đăng nhập)
router.get('/login', (req, res) => {
  // Nếu đã có phiên làm việc hợp lệ, tự động chuyển hướng theo vai trò
  if (req.session && req.session.userId) {
    if (req.session.role === 'CASHIER') {
      return res.redirect('/sales');
    }
    return res.redirect('/');
  }
  res.sendFile(path.join(viewsPath, 'login.html'));
});

// 2. Tất cả các trang nghiệp vụ bên dưới đều bắt buộc phải đăng nhập
router.use(requireLogin);

// Nhóm trang dành riêng cho Quản lý (MANAGER)
router.get('/', requireRole('MANAGER'), (req, res) => res.sendFile(path.join(viewsPath, 'dashboard.html')));
router.get('/products', requireRole('MANAGER'), (req, res) => res.sendFile(path.join(viewsPath, 'products.html')));
router.get('/employees', requireRole('MANAGER'), (req, res) => res.sendFile(path.join(viewsPath, 'employees.html')));
router.get('/stock-receipts', requireRole('MANAGER'), (req, res) => res.sendFile(path.join(viewsPath, 'stock-receipts.html')));

// Nhóm trang dùng chung cho cả Quản lý (MANAGER) và Thu ngân (CASHIER)
router.get('/sales', (req, res) => res.sendFile(path.join(viewsPath, 'sales.html')));
router.get('/invoices', (req, res) => res.sendFile(path.join(viewsPath, 'invoices.html')));
router.get('/inventory', (req, res) => res.sendFile(path.join(viewsPath, 'inventory.html')));
router.get('/profile', (req, res) => res.sendFile(path.join(viewsPath, 'profile.html')));

module.exports = router;
