/**
 * ==============================================================================
 * DỰ ÁN POS STORE - QUẢN LÝ VÀ THEO DÕI TỒN KHO (INVENTORY & STOCK MOVEMENTS API)
 * ==============================================================================
 * Tệp: routes/api/inventory.js
 * Mục đích:
 *   - Tra cứu số lượng tồn kho thực tế, phân loại trạng thái: Hết hàng (0), Sắp hết (<= threshold), Còn hàng an toàn.
 *   - Tuyệt đối bảo vệ tính bất biến của tồn kho: Chặn toàn bộ phương thức POST/PUT/PATCH/DELETE
 *     bằng HTTP 405 Method Not Allowed (tồn kho chỉ biến động gián tiếp qua Hóa đơn hoặc Phiếu nhập).
 *   - Truy xuất lịch sử sổ kho chi tiết (stock_movements): Ghi lại số dư trước/sau, delta biến động, loại giao dịch (IMPORT/EXPORT),
 *     số chứng từ tham chiếu và người thực hiện. (Chức năng này chỉ dành riêng cho MANAGER).
 *   - Xử lý bộ lọc khoảng ngày chặt chẽ theo lịch dương thực tế (chấp nhận năm nhuận, chặn ngày 30/2, 31/4).
 * ==============================================================================
 */

const express = require('express');
const pool = require('../../config/db');
const { requireLogin } = require('../../middleware/auth');
const logger = require('../../config/logger');

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
    return logger.sendServerError(res, req, 'get_inventory', error);
  }
});

// ----------------------------------------------------------------------------
// KIỂM TRA NGÀY HỢP LỆ VÀ XỬ LÝ KHOẢNG NGÀY
// ----------------------------------------------------------------------------
// Kiểm tra ngày hợp lệ theo dương lịch thực tế (YYYY-MM-DD), chặn các ngày không tồn tại (như 2026-02-30, 2026-04-31) và chấp nhận năm nhuận
function isValidCalendarDate(dateStr) {
  if (typeof dateStr !== 'string') return false;
  const match = dateStr.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(year, month - 1, day);
  return (d.getFullYear() === year && (d.getMonth() + 1) === month && d.getDate() === day);
}

// Lấy mốc 00:00:00 của ngày tiếp theo cho điều kiện < (nhỏ hơn ngày kế tiếp)
function getNextDayMidnight(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const nextDate = new Date(Date.UTC(year, month - 1, day + 1));
  const y = nextDate.getUTCFullYear();
  const m = String(nextDate.getUTCMonth() + 1).padStart(2, '0');
  const d = String(nextDate.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d} 00:00:00`;
}

function validateDateRange(from_date, to_date) {
  const cleanFromDate = typeof from_date === 'string' && from_date.trim() ? from_date.trim() : null;
  const cleanToDate = typeof to_date === 'string' && to_date.trim() ? to_date.trim() : null;

  if (cleanFromDate) {
    if (!isValidCalendarDate(cleanFromDate)) {
      return { error: 'Định dạng Từ ngày không hợp lệ hoặc không tồn tại trên lịch.', status: 400 };
    }
  }

  if (cleanToDate) {
    if (!isValidCalendarDate(cleanToDate)) {
      return { error: 'Định dạng Đến ngày không hợp lệ hoặc không tồn tại trên lịch.', status: 400 };
    }
  }

  if (cleanFromDate && cleanToDate && cleanFromDate > cleanToDate) {
    return { error: 'Từ ngày không được lớn hơn Đến ngày.', status: 400 };
  }

  return { cleanFromDate, cleanToDate };
}

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

    const { q, from_date, to_date, limit: rawLimit } = req.query;

    const dateVal = validateDateRange(from_date, to_date);
    if (dateVal.error) {
      return res.status(dateVal.status).json({ error: dateVal.error });
    }
    const { cleanFromDate, cleanToDate } = dateVal;

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

    if (cleanFromDate) {
      query += ' AND sm.created_at >= ?';
      params.push(`${cleanFromDate} 00:00:00`);
    }

    if (cleanToDate) {
      query += ' AND sm.created_at < ?';
      params.push(getNextDayMidnight(cleanToDate));
    }

    query += ' ORDER BY sm.created_at DESC, sm.id DESC LIMIT ?';
    params.push(limit);

    const [rows] = await pool.query(query, params);
    res.json(rows);
  } catch (error) {
    return logger.sendServerError(res, req, 'get_inventory_movements', error);
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

    const { from_date, to_date, q } = req.query;

    const dateVal = validateDateRange(from_date, to_date);
    if (dateVal.error) {
      return res.status(dateVal.status).json({ error: dateVal.error });
    }
    const { cleanFromDate, cleanToDate } = dateVal;

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
      WHERE sm.product_id = ?
    `;
    const params = [pId];

    if (q && q.trim()) {
      query += ` AND (p.sku LIKE ? OR p.name LIKE ? OR rec.receipt_no LIKE ? OR inv.invoice_no LIKE ?)`;
      const search = `%${q.trim()}%`;
      params.push(search, search, search, search);
    }

    if (cleanFromDate) {
      query += ' AND sm.created_at >= ?';
      params.push(`${cleanFromDate} 00:00:00`);
    }

    if (cleanToDate) {
      query += ' AND sm.created_at < ?';
      params.push(getNextDayMidnight(cleanToDate));
    }

    query += ' ORDER BY sm.created_at DESC, sm.id DESC';

    const [movements] = await pool.query(query, params);

    res.json({
      product,
      movements
    });
  } catch (error) {
    return logger.sendServerError(res, req, 'get_product_movements', error);
  }
});

module.exports = router;
