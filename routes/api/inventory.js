const express = require('express');
const pool = require('../../config/db');
const { requireLogin } = require('../../middleware/auth');

const router = express.Router();

router.use(requireLogin);

// ----------------------------------------------------------------------------
// CHẶN SỬA TỒN KHO TRỰC TIẾP (HTTP 405 Method Not Allowed)
// ----------------------------------------------------------------------------
const blockDirectStockModification = (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    return res.status(405).json({
      error: 'Không cho phép sửa đổi tồn kho trực tiếp. Tồn kho chỉ được cập nhật tự động qua chứng từ Nhập hàng hoặc Hóa đơn bán hàng.'
    });
  }
  next();
};

router.use(blockDirectStockModification);

// ----------------------------------------------------------------------------
// 1. TRA CỨU TỒN KHO (Cả MANAGER và CASHIER đều có quyền truy cập)
// ----------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const { q, status, threshold: rawThreshold, active_only } = req.query;

    // Ngưỡng sắp hết hàng (mặc định = 5 nếu không truyền hoặc không hợp lệ)
    let threshold = 5;
    if (rawThreshold !== undefined && rawThreshold !== '') {
      const parsed = parseInt(rawThreshold, 10);
      if (!isNaN(parsed) && parsed >= 0) {
        threshold = parsed;
      }
    }

    let query = `
      SELECT id, sku, name, unit, stock_quantity, is_active, updated_at
      FROM products
      WHERE 1=1
    `;
    const params = [];

    // Tìm kiếm theo SKU hoặc Tên sản phẩm
    if (q && q.trim()) {
      query += ' AND (sku LIKE ? OR name LIKE ?)';
      const search = `%${q.trim()}%`;
      params.push(search, search);
    }

    if (active_only === 'true') {
      query += ' AND is_active = 1';
    }

    // Lọc theo trạng thái tồn kho
    if (status === 'out_of_stock') {
      // Hết hàng: tồn kho bằng 0
      query += ' AND stock_quantity = 0';
    } else if (status === 'low_stock') {
      // Sắp hết hàng: còn hàng nhưng <= ngưỡng
      query += ' AND stock_quantity > 0 AND stock_quantity <= ?';
      params.push(threshold);
    } else if (status === 'in_stock') {
      // Còn hàng an toàn: > ngưỡng
      query += ' AND stock_quantity > ?';
      params.push(threshold);
    }

    query += ' ORDER BY name ASC, id ASC';

    const [rows] = await pool.query(query, params);

    // Tính toán số liệu thống kê nhanh trên toàn bộ sản phẩm
    const [statsRows] = await pool.query(`
      SELECT 
        COUNT(*) AS total_items,
        SUM(CASE WHEN stock_quantity = 0 THEN 1 ELSE 0 END) AS out_of_stock_items,
        SUM(CASE WHEN stock_quantity > 0 AND stock_quantity <= ? THEN 1 ELSE 0 END) AS low_stock_items,
        SUM(CASE WHEN stock_quantity > ? THEN 1 ELSE 0 END) AS safe_stock_items
      FROM products
    `, [threshold, threshold]);

    const stats = statsRows[0] || {
      total_items: 0,
      out_of_stock_items: 0,
      low_stock_items: 0,
      safe_stock_items: 0
    };

    res.json({
      threshold: threshold,
      stats: {
        totalItems: Number(stats.total_items || 0),
        outOfStockItems: Number(stats.out_of_stock_items || 0),
        lowStockItems: Number(stats.low_stock_items || 0),
        safeStockItems: Number(stats.safe_stock_items || 0)
      },
      products: rows,
      total: rows.length
    });
  } catch (error) {
    console.error('Lỗi lấy danh sách tồn kho:', error);
    res.status(500).json({ error: 'Lỗi máy chủ nội bộ khi lấy dữ liệu tồn kho' });
  }
});

// ----------------------------------------------------------------------------
// 2. LỊCH SỬ TOÀN BỘ BIẾN ĐỘNG KHO (CHỈ MANAGER MỚI ĐƯỢC PHÉP TRUY CẬP)
// ----------------------------------------------------------------------------
router.get('/movements', async (req, res) => {
  try {
    // Backend kiểm tra quyền nghiêm ngặt: CASHIER không được xem
    if (req.session.role !== 'MANAGER') {
      return res.status(403).json({
        error: 'Chỉ Quản lý (MANAGER) mới có quyền truy cập lịch sử biến động kho và chứng từ chi tiết.'
      });
    }

    const { q, limit: rawLimit } = req.query;
    const limit = Math.min(Math.max(parseInt(rawLimit, 10) || 50, 1), 200);

    let query = `
      SELECT 
        sm.id,
        sm.product_id,
        sm.quantity_delta,
        sm.balance_after,
        sm.created_at,
        p.sku,
        p.name AS product_name,
        p.unit,
        CASE 
          WHEN sm.quantity_delta > 0 THEN 'IMPORT'
          ELSE 'EXPORT'
        END AS movement_type,
        COALESCE(rec.receipt_no, inv.invoice_no, 'N/A') AS document_no,
        CASE 
          WHEN sm.receipt_item_id IS NOT NULL THEN COALESCE(u_rec.full_name, u_rec.username, 'Quản lý')
          WHEN sm.invoice_item_id IS NOT NULL THEN COALESCE(u_inv.full_name, u_inv.username, 'Thu ngân')
          ELSE 'Hệ thống'
        END AS performed_by
      FROM stock_movements sm
      JOIN products p ON sm.product_id = p.id
      LEFT JOIN invoice_items ii ON sm.invoice_item_id = ii.id
      LEFT JOIN invoices inv ON ii.invoice_id = inv.id
      LEFT JOIN users u_inv ON inv.created_by = u_inv.id
      LEFT JOIN stock_receipt_items ri ON sm.receipt_item_id = ri.id
      LEFT JOIN stock_receipts rec ON ri.receipt_id = rec.id
      LEFT JOIN users u_rec ON rec.created_by = u_rec.id
      WHERE 1=1
    `;
    const params = [];

    if (q && q.trim()) {
      query += ` AND (p.sku LIKE ? OR p.name LIKE ? OR rec.receipt_no LIKE ? OR inv.invoice_no LIKE ?)`;
      const search = `%${q.trim()}%`;
      params.push(search, search, search, search);
    }

    query += ' ORDER BY sm.created_at DESC, sm.id DESC LIMIT ?';
    params.push(limit);

    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (error) {
    console.error('Lỗi lấy toàn bộ biến động kho:', error);
    res.status(500).json({ error: 'Lỗi máy chủ nội bộ khi lấy toàn bộ biến động kho' });
  }
});

// ----------------------------------------------------------------------------
// 3. LỊCH SỬ BIẾN ĐỘNG CỦA 1 SẢN PHẨM CỤ THỂ (CHỈ MANAGER MỚI ĐƯỢC PHÉP TRUY CẬP)
// ----------------------------------------------------------------------------
router.get('/:productId/movements', async (req, res) => {
  const { productId } = req.params;

  try {
    // Backend kiểm tra quyền nghiêm ngặt: CASHIER không được xem chứng từ của người khác
    if (req.session.role !== 'MANAGER') {
      return res.status(403).json({
        error: 'Chỉ Quản lý (MANAGER) mới có quyền truy cập lịch sử biến động kho và chứng từ chi tiết.'
      });
    }

    const pId = parseInt(productId, 10);
    if (!pId || isNaN(pId) || pId <= 0) {
      return res.status(400).json({ error: 'Mã sản phẩm không hợp lệ' });
    }

    // Kiểm tra sản phẩm tồn tại
    const [products] = await pool.query(
      'SELECT id, sku, name, unit, stock_quantity, is_active FROM products WHERE id = ?',
      [pId]
    );

    if (products.length === 0) {
      return res.status(404).json({ error: 'Không tìm thấy sản phẩm yêu cầu' });
    }

    const product = products[0];

    // Lấy toàn bộ biến động kho kèm thông tin chứng từ & người thực hiện
    const [movements] = await pool.query(
      `SELECT 
        sm.id,
        sm.product_id,
        sm.quantity_delta,
        sm.balance_after,
        sm.created_at,
        p.sku,
        p.name AS product_name,
        p.unit,
        CASE 
          WHEN sm.quantity_delta > 0 THEN 'IMPORT'
          ELSE 'EXPORT'
        END AS movement_type,
        COALESCE(rec.receipt_no, inv.invoice_no, 'N/A') AS document_no,
        CASE 
          WHEN sm.receipt_item_id IS NOT NULL THEN COALESCE(u_rec.full_name, u_rec.username, 'Quản lý')
          WHEN sm.invoice_item_id IS NOT NULL THEN COALESCE(u_inv.full_name, u_inv.username, 'Thu ngân')
          ELSE 'Hệ thống'
        END AS performed_by
      FROM stock_movements sm
      JOIN products p ON sm.product_id = p.id
      LEFT JOIN invoice_items ii ON sm.invoice_item_id = ii.id
      LEFT JOIN invoices inv ON ii.invoice_id = inv.id
      LEFT JOIN users u_inv ON inv.created_by = u_inv.id
      LEFT JOIN stock_receipt_items ri ON sm.receipt_item_id = ri.id
      LEFT JOIN stock_receipts rec ON ri.receipt_id = rec.id
      LEFT JOIN users u_rec ON rec.created_by = u_rec.id
      WHERE sm.product_id = ?
      ORDER BY sm.created_at DESC, sm.id DESC`,
      [pId]
    );

    res.json({
      product,
      movements
    });
  } catch (error) {
    console.error('Lỗi lấy lịch sử biến động kho sản phẩm:', error);
    res.status(500).json({ error: 'Lỗi máy chủ nội bộ khi lấy lịch sử biến động kho' });
  }
});

module.exports = router;
