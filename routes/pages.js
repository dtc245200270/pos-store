const express = require('express');
const path = require('path');
const { requireLogin, requireRole } = require('../middleware/auth');
const router = express.Router();

const viewsPath = path.join(__dirname, '../views');

// Trang đăng nhập (không yêu cầu đăng nhập)
router.get('/login', (req, res) => {
  if (req.session && req.session.userId) {
    if (req.session.role === 'CASHIER') {
      return res.redirect('/sales');
    }
    return res.redirect('/');
  }
  res.sendFile(path.join(viewsPath, 'login.html'));
});

// Các trang nghiệp vụ (yêu cầu đăng nhập)
router.use(requireLogin);

router.get('/', requireRole('MANAGER'), (req, res) => res.sendFile(path.join(viewsPath, 'dashboard.html')));
router.get('/products', requireRole('MANAGER'), (req, res) => res.sendFile(path.join(viewsPath, 'products.html')));
router.get('/employees', requireRole('MANAGER'), (req, res) => res.sendFile(path.join(viewsPath, 'employees.html')));
router.get('/sales', (req, res) => res.sendFile(path.join(viewsPath, 'sales.html')));
router.get('/invoices', (req, res) => res.sendFile(path.join(viewsPath, 'invoices.html')));
router.get('/stock-receipts', requireRole('MANAGER'), (req, res) => res.sendFile(path.join(viewsPath, 'stock-receipts.html')));
router.get('/inventory', (req, res) => res.sendFile(path.join(viewsPath, 'inventory.html')));
router.get('/profile', (req, res) => res.sendFile(path.join(viewsPath, 'profile.html')));

module.exports = router;
