const express = require('express');
const pool = require('../../config/db');
const { requireLogin, requireRole } = require('../../middleware/auth');

const router = express.Router();

router.use(requireLogin);

// Tìm kiếm sản phẩm (hỗ trợ phân trang, tìm theo SKU/tên, lọc theo trạng thái)
router.get('/', async (req, res) => {
  try {
    const { q, active_only, status, page: pageQuery, limit: limitQuery, paginate } = req.query;
    let whereConditions = ['1=1'];
    const params = [];

    if (q && typeof q === 'string' && q.trim()) {
      whereConditions.push('(sku LIKE ? OR name LIKE ?)');
      const search = `%${q.trim()}%`;
      params.push(search, search);
    }

    if (active_only === 'true' || status === 'active') {
      whereConditions.push('is_active = 1');
    } else if (status === 'inactive' || status === 'locked') {
      whereConditions.push('is_active = 0');
    }

    const whereClause = whereConditions.join(' AND ');

    // Nếu có yêu cầu phân trang (truyền page hoặc limit hoặc paginate=true)
    if (pageQuery !== undefined || limitQuery !== undefined || paginate === 'true') {
      const [countRows] = await pool.query(`SELECT COUNT(*) AS total FROM products WHERE ${whereClause}`, params);
      const total = Number(countRows[0]?.total || 0);

      const page = Math.max(1, parseInt(pageQuery, 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(limitQuery, 10) || 10));
      const totalPages = total > 0 ? Math.ceil(total / limit) : 0;
      const offset = (page - 1) * limit;

      const [rows] = await pool.query(
        `SELECT id, sku, name, unit, sale_price, stock_quantity, is_active, created_at, updated_at
         FROM products
         WHERE ${whereClause}
         ORDER BY id DESC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset]
      );

      return res.json({
        data: rows,
        items: rows,
        products: rows,
        pagination: {
          page,
          limit,
          total,
          totalPages
        },
        page,
        limit,
        total,
        totalPages
      });
    }

    // Tương thích ngược: trả về trực tiếp mảng sản phẩm cho các màn hình nghiệp vụ và bài test cũ
    const [rows] = await pool.query(
      `SELECT id, sku, name, unit, sale_price, stock_quantity, is_active, created_at, updated_at
       FROM products
       WHERE ${whereClause}
       ORDER BY name ASC`,
      params
    );
    res.json(rows);
  } catch (error) {
    console.error('Lỗi lấy danh sách sản phẩm:', error);
    res.status(500).json({ error: 'Lỗi máy chủ nội bộ' });
  }
});

// Lấy chi tiết 1 sản phẩm
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const numId = parseInt(id, 10);
  if (isNaN(numId) || numId <= 0) {
    return res.status(404).json({ error: 'Không tìm thấy sản phẩm' });
  }

  try {
    const [rows] = await pool.query(
      'SELECT id, sku, name, unit, sale_price, stock_quantity, is_active, created_at, updated_at FROM products WHERE id = ?',
      [numId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Không tìm thấy sản phẩm' });
    }
    res.json(rows[0]);
  } catch (error) {
    console.error('Lỗi lấy chi tiết sản phẩm:', error);
    res.status(500).json({ error: 'Lỗi máy chủ nội bộ' });
  }
});

// Thêm sản phẩm (Chỉ MANAGER)
router.post('/', requireRole('MANAGER'), async (req, res) => {
  const { sku, name, unit, sale_price } = req.body;

  const trimmedSku = typeof sku === 'string' ? sku.trim() : '';
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  const trimmedUnit = typeof unit === 'string' ? unit.trim() : '';

  if (!trimmedSku || !trimmedName || !trimmedUnit || sale_price === undefined || sale_price === null || sale_price === '') {
    return res.status(400).json({ error: 'Vui lòng nhập đầy đủ thông tin sản phẩm (SKU, tên, đơn vị, giá bán)' });
  }

  const price = Number(sale_price);
  if (typeof sale_price === 'boolean' || isNaN(price) || !isFinite(price) || price <= 0) {
    return res.status(400).json({ error: 'Giá bán phải là số hợp lệ lớn hơn 0 (không âm)' });
  }

  if (!/^\d+(\.\d{1,2})?$/.test(sale_price.toString().trim())) {
    return res.status(400).json({ error: 'Giá bán không được vượt quá 2 chữ số thập phân' });
  }

  if (price >= 10000000000000) {
    return res.status(400).json({ error: 'Giá bán vượt quá giới hạn hệ thống' });
  }

  try {
    const [existing] = await pool.query('SELECT id FROM products WHERE sku = ?', [trimmedSku]);
    if (existing.length > 0) {
      return res.status(400).json({ error: 'Mã SKU đã tồn tại' });
    }

    // Tồn kho ban đầu luôn luôn là 0 (không cho phép sửa tồn kho trực tiếp qua biểu mẫu)
    const [result] = await pool.query(
      'INSERT INTO products (sku, name, unit, sale_price, stock_quantity, is_active) VALUES (?, ?, ?, ?, 0, 1)',
      [trimmedSku, trimmedName, trimmedUnit, price]
    );

    res.status(201).json({ 
      message: 'Thêm sản phẩm thành công', 
      id: result.insertId,
      sku: trimmedSku,
      stock_quantity: 0
    });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Mã SKU đã tồn tại' });
    }
    console.error('Lỗi thêm sản phẩm:', error);
    res.status(500).json({ error: 'Lỗi máy chủ nội bộ' });
  }
});

// Sửa thông tin sản phẩm theo ID nội bộ (Chỉ MANAGER)
router.put('/:id', requireRole('MANAGER'), async (req, res) => {
  const { id } = req.params;
  const numId = parseInt(id, 10);
  if (isNaN(numId) || numId <= 0) {
    return res.status(400).json({ error: 'ID sản phẩm không hợp lệ' });
  }

  const { sku, name, unit, sale_price } = req.body;

  const trimmedSku = typeof sku === 'string' ? sku.trim() : '';
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  const trimmedUnit = typeof unit === 'string' ? unit.trim() : '';

  if (!trimmedSku) {
    return res.status(400).json({ error: 'Vui lòng nhập mã SKU' });
  }

  if (!trimmedName || !trimmedUnit || sale_price === undefined || sale_price === null || sale_price === '') {
    return res.status(400).json({ error: 'Vui lòng nhập đầy đủ thông tin sản phẩm (SKU, tên, đơn vị, giá bán)' });
  }

  const price = Number(sale_price);
  if (typeof sale_price === 'boolean' || isNaN(price) || !isFinite(price) || price <= 0) {
    return res.status(400).json({ error: 'Giá bán phải là số hợp lệ lớn hơn 0 (không âm)' });
  }

  if (!/^\d+(\.\d{1,2})?$/.test(sale_price.toString().trim())) {
    return res.status(400).json({ error: 'Giá bán không được vượt quá 2 chữ số thập phân' });
  }

  if (price >= 10000000000000) {
    return res.status(400).json({ error: 'Giá bán vượt quá giới hạn hệ thống' });
  }

  try {
    const [existing] = await pool.query('SELECT id, sku FROM products WHERE id = ?', [numId]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Không tìm thấy sản phẩm' });
    }

    // Kiểm tra trùng mã SKU với sản phẩm khác theo ID nội bộ
    const [duplicate] = await pool.query('SELECT id FROM products WHERE sku = ? AND id != ?', [trimmedSku, numId]);
    if (duplicate.length > 0) {
      return res.status(400).json({ error: 'Mã SKU đã tồn tại ở sản phẩm khác' });
    }

    // Cập nhật sku, name, unit, sale_price (tồn kho stock_quantity KHÔNG bao giờ được sửa ở đây)
    await pool.query(
      'UPDATE products SET sku = ?, name = ?, unit = ?, sale_price = ? WHERE id = ?',
      [trimmedSku, trimmedName, trimmedUnit, price, numId]
    );

    res.json({ message: 'Cập nhật sản phẩm thành công', id: numId, sku: trimmedSku });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Mã SKU đã tồn tại ở sản phẩm khác' });
    }
    console.error('Lỗi cập nhật sản phẩm:', error);
    res.status(500).json({ error: 'Lỗi máy chủ nội bộ' });
  }
});

// Ngừng kinh doanh / Kích hoạt lại sản phẩm (Chỉ MANAGER)
router.patch('/:id/toggle-active', requireRole('MANAGER'), async (req, res) => {
  const { id } = req.params;
  const numId = parseInt(id, 10);
  if (isNaN(numId) || numId <= 0) {
    return res.status(400).json({ error: 'ID sản phẩm không hợp lệ' });
  }

  const { is_active } = req.body;

  if (is_active === undefined || is_active === null) {
    return res.status(400).json({ error: 'Thiếu trạng thái kích hoạt' });
  }

  try {
    const [existing] = await pool.query('SELECT id, is_active FROM products WHERE id = ?', [numId]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Không tìm thấy sản phẩm' });
    }

    const newActiveState = (is_active === true || is_active === 1 || is_active === '1' || is_active === 'true') ? 1 : 0;
    await pool.query('UPDATE products SET is_active = ? WHERE id = ?', [newActiveState, numId]);
    
    res.json({ 
      message: newActiveState === 1 ? 'Đã kích hoạt lại sản phẩm' : 'Đã ngừng kinh doanh sản phẩm',
      is_active: newActiveState 
    });
  } catch (error) {
    console.error('Lỗi đổi trạng thái sản phẩm:', error);
    res.status(500).json({ error: 'Lỗi máy chủ nội bộ' });
  }
});

// Xóa vĩnh viễn sản phẩm (Chỉ MANAGER)
router.delete('/:id', requireRole('MANAGER'), async (req, res) => {
  const { id } = req.params;
  const numId = parseInt(id, 10);
  if (isNaN(numId) || numId <= 0) {
    return res.status(400).json({ error: 'ID sản phẩm không hợp lệ' });
  }

  try {
    // 1. Kiểm tra sản phẩm tồn tại
    const [products] = await pool.query(
      'SELECT id, sku, name, unit, stock_quantity, is_active FROM products WHERE id = ?',
      [numId]
    );

    if (products.length === 0) {
      return res.status(404).json({ error: 'Không tìm thấy sản phẩm' });
    }

    const product = products[0];

    // 2. Kiểm tra tham chiếu trong các giao dịch:
    // - chi tiết hóa đơn (invoice_items)
    // - chi tiết phiếu nhập (stock_receipt_items)
    // - lịch sử biến động kho (stock_movements)
    const [invoiceCheck] = await pool.query(
      'SELECT 1 FROM invoice_items WHERE product_id = ? LIMIT 1',
      [numId]
    );
    const [receiptCheck] = await pool.query(
      'SELECT 1 FROM stock_receipt_items WHERE product_id = ? LIMIT 1',
      [numId]
    );
    const [movementCheck] = await pool.query(
      'SELECT 1 FROM stock_movements WHERE product_id = ? LIMIT 1',
      [numId]
    );

    const hasInvoices = invoiceCheck.length > 0;
    const hasReceipts = receiptCheck.length > 0;
    const hasMovements = movementCheck.length > 0;
    const hasTransactions = hasInvoices || hasReceipts || hasMovements;

    if (hasTransactions) {
      const reasons = [];
      if (hasInvoices) reasons.push('hóa đơn bán hàng');
      if (hasReceipts) reasons.push('phiếu nhập hàng');
      if (hasMovements) reasons.push('biến động kho');

      return res.status(400).json({
        error: 'Sản phẩm đã có lịch sử giao dịch. Vui lòng dùng chức năng Khóa.',
        message: `Sản phẩm đã có lịch sử giao dịch (${reasons.join(', ')}). Không thể xóa để bảo toàn dữ liệu kế toán và chứng từ. Gợi ý: Hãy sử dụng chức năng Ngừng kinh doanh.`,
        suggest: 'Chuyển trạng thái sang "Ngừng kinh doanh"',
        can_toggle: true,
        reason: 'has_transactions',
        references: {
          invoices: hasInvoices,
          receipts: hasReceipts,
          movements: hasMovements
        }
      });
    }

    // 3. Kiểm tra tồn kho bằng 0
    if (Number(product.stock_quantity) !== 0) {
      return res.status(400).json({
        error: 'Chỉ xóa được sản phẩm có tồn kho bằng 0',
        message: `Sản phẩm vẫn còn tồn kho (${product.stock_quantity} ${product.unit}). Gợi ý: Hãy xuất kho hoặc chuyển sang Ngừng kinh doanh.`,
        suggest: 'Chuyển trạng thái sang "Ngừng kinh doanh"',
        can_toggle: true,
        reason: 'stock_not_zero',
        stock_quantity: product.stock_quantity
      });
    }

    // 4. Xóa vĩnh viễn (ON DELETE RESTRICT bảo vệ toàn vẹn dữ liệu)
    await pool.query('DELETE FROM products WHERE id = ?', [numId]);

    res.json({ message: 'Xóa sản phẩm thành công', id: numId });
  } catch (error) {
    if (error.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(400).json({
        error: 'Sản phẩm đã có lịch sử giao dịch. Vui lòng dùng chức năng Khóa.',
        message: 'Ràng buộc toàn vẹn cơ sở dữ liệu: Sản phẩm đã có chứng từ liên quan. Gợi ý: Hãy dùng chức năng Ngừng kinh doanh.',
        suggest: 'Chuyển trạng thái sang "Ngừng kinh doanh"',
        can_toggle: true
      });
    }
    console.error('Lỗi xóa sản phẩm:', error);
    res.status(500).json({ error: 'Lỗi máy chủ nội bộ' });
  }
});
module.exports = router;

