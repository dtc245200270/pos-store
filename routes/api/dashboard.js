const express = require('express');
const pool = require('../../config/db');
const { requireLogin } = require('../../middleware/auth');
const logger = require('../../config/logger');

const router = express.Router();

router.use(requireLogin);

// ----------------------------------------------------------------------------
// API THỐNG KÊ TỔNG QUAN (CHỈ DÀNH CHO QUẢN LÝ - MANAGER)
// ----------------------------------------------------------------------------
router.get('/stats', async (req, res) => {
  try {
    // 1. Kiểm tra quyền nghiêm ngặt: Chỉ Quản lý mới được truy cập dữ liệu thống kê
    if (req.session.role !== 'MANAGER') {
      return res.status(403).json({
        error: 'Chỉ Quản lý (MANAGER) mới có quyền truy cập dữ liệu thống kê tổng quan.'
      });
    }

    // 2. Xác định mốc thời gian "hôm nay" theo đúng múi giờ Asia/Ho_Chi_Minh (UTC+7)
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
    const targetDate = req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
      ? req.query.date.trim()
      : formatter.format(new Date());

    const startOfDay = `${targetDate} 00:00:00`;
    const endOfDay = `${targetDate} 23:59:59`;

    // Ngưỡng sắp hết hàng (mặc định = 5)
    let threshold = 5;
    if (req.query.threshold !== undefined && req.query.threshold !== '') {
      const parsedTh = parseInt(req.query.threshold, 10);
      if (!isNaN(parsedTh) && parsedTh >= 0) {
        threshold = parsedTh;
      }
    }

    // 3. Doanh thu hôm nay & Số hóa đơn hôm nay (chỉ từ hóa đơn bán đã hoàn tất trong bảng invoices)
    // LƯU Ý: Tiền nhập hàng (stock_receipts) KHÔNG ĐƯỢC tính vào doanh thu bán hàng
    const [invoiceStatsRows] = await pool.query(`
      SELECT 
        COUNT(*) AS today_invoices_count,
        COALESCE(SUM(total_amount), 0) AS today_revenue
      FROM invoices
      WHERE created_at >= ? AND created_at <= ?
    `, [startOfDay, endOfDay]);

    const todayInvoicesCount = Number(invoiceStatsRows[0]?.today_invoices_count || 0);
    const todayRevenue = Number(invoiceStatsRows[0]?.today_revenue || 0);

    // 4. Số sản phẩm đang kinh doanh từ bảng products (is_active = 1)
    const [activeProductsRows] = await pool.query(`
      SELECT COUNT(*) AS active_count
      FROM products
      WHERE is_active = 1
    `);
    const activeProductsCount = Number(activeProductsRows[0]?.active_count || 0);

    // 5. Tổng số sản phẩm hết hàng hoặc sắp hết hàng (stock_quantity <= threshold) bằng COUNT(*) với cùng điều kiện
    const [lowStockCountRows] = await pool.query(`
      SELECT COUNT(*) AS low_stock_count
      FROM products
      WHERE is_active = 1 AND stock_quantity <= ?
    `, [threshold]);
    const lowStockCount = Number(lowStockCountRows[0]?.low_stock_count || 0);

    // 6. Danh sách sản phẩm hết hàng hoặc sắp hết hàng (giới hạn 20 dòng hiển thị)
    const [lowStockRows] = await pool.query(`
      SELECT id, sku, name, unit, stock_quantity, sale_price, is_active
      FROM products
      WHERE is_active = 1 AND stock_quantity <= ?
      ORDER BY stock_quantity ASC, name ASC
      LIMIT 20
    `, [threshold]);

    // 7. Danh sách 10 hóa đơn gần đây nhất
    const [recentInvoicesRows] = await pool.query(`
      SELECT 
        i.id,
        i.invoice_no,
        i.total_amount,
        i.created_at,
        COALESCE(u.full_name, u.username, 'Thu ngân') AS created_by_name
      FROM invoices i
      JOIN users u ON i.created_by = u.id
      ORDER BY i.created_at DESC, i.id DESC
      LIMIT 10
    `);

    res.json({
      date: targetDate,
      timeZone: 'Asia/Ho_Chi_Minh',
      threshold,
      summary: {
        todayRevenue,
        todayInvoicesCount,
        activeProductsCount,
        lowStockCount
      },
      lowStockProducts: lowStockRows,
      recentInvoices: recentInvoicesRows
    });
  } catch (error) {
    return logger.sendServerError(res, req, 'get_dashboard_stats', error);
  }
});

module.exports = router;
