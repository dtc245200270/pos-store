const express = require('express');
const crypto = require('crypto');
const pool = require('../../config/db');
const { requireLogin } = require('../../middleware/auth');

const router = express.Router();

router.use(requireLogin);

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

// Lấy danh sách hóa đơn (hỗ trợ tìm kiếm, lọc ngày VN, lọc người bán cho Quản lý, phân trang)
router.get('/', async (req, res) => {
  try {
    const { q, from_date, to_date, seller_id, page: pageQuery, limit: limitQuery, paginate } = req.query;

    const conditions = [];
    const params = [];

    // Phân quyền theo vai trò
    if (req.session.role === 'CASHIER') {
      // CASHIER chỉ xem hóa đơn do tài khoản mình lập
      conditions.push('i.created_by = ?');
      params.push(req.session.userId);
    } else if (req.session.role === 'MANAGER') {
      // MANAGER có thể lọc theo người bán nếu có chỉ định
      if (seller_id !== undefined && seller_id !== '' && seller_id !== 'all') {
        const parsedSellerId = parseInt(seller_id, 10);
        if (!isNaN(parsedSellerId) && parsedSellerId > 0) {
          conditions.push('i.created_by = ?');
          params.push(parsedSellerId);
        }
      }
    }

    // Tìm kiếm theo mã hóa đơn
    if (q && typeof q === 'string' && q.trim()) {
      conditions.push('i.invoice_no LIKE ?');
      params.push(`%${q.trim()}%`);
    }

    // Kiểm tra và lọc theo ngày (thống nhất theo giờ Việt Nam UTC+7)
    const cleanFromDate = typeof from_date === 'string' && from_date.trim() ? from_date.trim() : null;
    const cleanToDate = typeof to_date === 'string' && to_date.trim() ? to_date.trim() : null;

    if (cleanFromDate) {
      if (!isValidCalendarDate(cleanFromDate)) {
        return res.status(400).json({ error: 'Định dạng Từ ngày không hợp lệ hoặc không tồn tại trên lịch.' });
      }
    }

    if (cleanToDate) {
      if (!isValidCalendarDate(cleanToDate)) {
        return res.status(400).json({ error: 'Định dạng Đến ngày không hợp lệ hoặc không tồn tại trên lịch.' });
      }
    }

    if (cleanFromDate && cleanToDate && cleanFromDate > cleanToDate) {
      return res.status(400).json({ error: 'Từ ngày không được lớn hơn Đến ngày.' });
    }

    if (cleanFromDate) {
      conditions.push('i.created_at >= ?');
      params.push(`${cleanFromDate} 00:00:00`);
    }
    if (cleanToDate) {
      conditions.push('i.created_at <= ?');
      params.push(`${cleanToDate} 23:59:59`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Đếm tổng số bản ghi
    const countSql = `SELECT COUNT(*) AS total
                      FROM invoices i
                      JOIN users u ON i.created_by = u.id
                      ${whereClause}`;
    const [countRows] = await pool.query(countSql, params);
    const total = Number(countRows[0]?.total || 0);

    // Tính toán phân trang
    const page = Math.max(1, parseInt(pageQuery, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(limitQuery, 10) || 10));
    const totalPages = total > 0 ? Math.ceil(total / limit) : 0;
    const offset = (page - 1) * limit;

    // Lấy danh sách hóa đơn theo trang
    const dataSql = `SELECT i.id, i.invoice_no, i.total_amount, i.created_at, u.full_name as created_by_name
                     FROM invoices i
                     JOIN users u ON i.created_by = u.id
                     ${whereClause}
                     ORDER BY i.created_at DESC, i.id DESC
                     LIMIT ? OFFSET ?`;
    const [rows] = await pool.query(dataSql, [...params, limit, offset]);

    // Tương thích ngược: nếu không truyền tham số truy vấn nào (như integration test cũ)
    const hasAnyParam = pageQuery !== undefined || limitQuery !== undefined || paginate !== undefined || q || from_date || to_date || seller_id;
    if (!hasAnyParam) {
      return res.json(rows);
    }

    res.json({
      invoices: rows,
      total,
      page,
      totalPages,
      limit
    });
  } catch (error) {
    console.error('Lỗi lấy danh sách hóa đơn:', error);
    res.status(500).json({ error: 'Lỗi máy chủ nội bộ' });
  }
});

// Lấy danh sách người bán (chỉ dành cho MANAGER để lọc theo người bán)
router.get('/sellers', async (req, res) => {
  try {
    if (req.session.role !== 'MANAGER') {
      return res.status(403).json({ error: 'Chỉ quản lý mới có quyền truy cập danh sách người bán' });
    }
    const [users] = await pool.query(
      `SELECT id, username, full_name, role 
       FROM users 
       ORDER BY full_name ASC`
    );
    res.json(users);
  } catch (error) {
    console.error('Lỗi lấy danh sách người bán:', error);
    res.status(500).json({ error: 'Lỗi máy chủ nội bộ' });
  }
});

// Xem chi tiết hóa đơn (kiểm tra quyền sở hữu đối với CASHIER)
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const numId = parseInt(id, 10);
  if (isNaN(numId) || numId <= 0) {
    return res.status(404).json({ error: 'Không tìm thấy hóa đơn hoặc không có quyền truy cập' });
  }

  try {
    let query = `SELECT i.*, u.full_name as created_by_name
                 FROM invoices i
                 JOIN users u ON i.created_by = u.id
                 WHERE i.id = ?`;
    const params = [numId];

    // Thu ngân chỉ xem được chi tiết hóa đơn do mình lập
    if (req.session.role === 'CASHIER') {
      query += ' AND i.created_by = ?';
      params.push(req.session.userId);
    }

    const [invoices] = await pool.query(query, params);

    if (invoices.length === 0) {
      return res.status(404).json({ error: 'Không tìm thấy hóa đơn hoặc không có quyền truy cập' });
    }

    // Lấy dữ liệu chi tiết hóa đơn đã lưu (snapshot tên, đơn vị, giá tại thời điểm bán)
    const [items] = await pool.query(
      `SELECT ii.*, p.sku
       FROM invoice_items ii
       LEFT JOIN products p ON ii.product_id = p.id
       WHERE ii.invoice_id = ?
       ORDER BY ii.id ASC`,
      [numId]
    );

    res.json({ invoice: invoices[0], items });
  } catch (error) {
    console.error('Lỗi lấy chi tiết hóa đơn:', error);
    res.status(500).json({ error: 'Lỗi máy chủ nội bộ' });
  }
});

// Tạo hóa đơn bán hàng
router.post('/', async (req, res) => {
  const Decimal = require('decimal.js');
  const { invoice_no, request_key, items } = req.body;
  const created_by = req.session.userId;

  const cleanInvoiceNo = typeof invoice_no === 'string' ? invoice_no.trim() : '';

  if (!cleanInvoiceNo || !request_key || typeof request_key !== 'string' || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Dữ liệu không hợp lệ. Phải có ít nhất 1 sản phẩm.' });
  }

  // Gộp sản phẩm
  const mergedItemsMap = new Map();
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return res.status(400).json({ error: 'Chi tiết sản phẩm phải là object' });
    }
    const qty = Number(item.quantity);
    const price = Number(item.unit_price);

    if (item.product_id === null || item.product_id === undefined || typeof item.product_id !== 'number' || typeof item.quantity !== 'number' || typeof item.unit_price !== 'number') {
      return res.status(400).json({ error: 'Sai kiểu dữ liệu' });
    }
    if (!item.product_id || !Number.isInteger(qty) || qty <= 0 || isNaN(price) || price <= 0 || qty > 2147483647) {
      return res.status(400).json({ error: 'Chi tiết sản phẩm không hợp lệ (số lượng phải nguyên dương <= 2147483647, giá bán > 0).' });
    }
    if (!/^\d+(\.\d{1,2})?$/.test(item.unit_price.toString())) {
      return res.status(400).json({ error: 'Giá bán không được vượt quá 2 chữ số thập phân.' });
    }
    if (price >= 10000000000000) {
      return res.status(400).json({ error: 'Giá bán vượt quá giới hạn hệ thống.' });
    }

    const pid = Number(item.product_id);
    if (mergedItemsMap.has(pid)) {
      const existing = mergedItemsMap.get(pid);
      if (existing.expected_price !== price) {
        return res.status(400).json({ error: `Sản phẩm ID ${pid} có nhiều đơn giá dự kiến khác nhau trong cùng hóa đơn.` });
      }
      existing.quantity += qty;
      if (existing.quantity > 2147483647) {
        return res.status(400).json({ error: 'Số lượng sau gộp vượt quá giới hạn' });
      }
    } else {
      mergedItemsMap.set(pid, {
        product_id: pid,
        quantity: qty,
        expected_price: price
      });
    }
  }

  const finalItems = Array.from(mergedItemsMap.values());
  finalItems.sort((a, b) => a.product_id - b.product_id);

  const hashPayload = JSON.stringify({ invoice_no: cleanInvoiceNo, items: finalItems });
  const request_hash = crypto.createHash('sha256').update(hashPayload).digest('hex');

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [existing] = await connection.query(
      'SELECT id, request_hash, invoice_no, request_key, created_by FROM invoices WHERE invoice_no = ? OR (created_by = ? AND request_key = ?)',
      [cleanInvoiceNo, created_by, request_key]
    );

    if (existing.length > 0) {
      await connection.rollback();
      for (const doc of existing) {
        if (doc.created_by === created_by && doc.request_key === request_key) {
          if (doc.request_hash === request_hash) {
            return res.status(200).json({ message: 'Hóa đơn đã được tạo trước đó', id: doc.id, invoice_no: doc.invoice_no });
          } else {
            return res.status(409).json({ error: 'Yêu cầu bị Conflict do trùng request_key nhưng khác dữ liệu (Hash).' });
          }
        }
      }
      return res.status(400).json({ error: 'Mã hóa đơn đã tồn tại trong hệ thống (Trùng invoice_no).' });
    }

    let total_amount = new Decimal(0);
    const productIds = finalItems.map(i => i.product_id);
    
    // Khóa dữ liệu chống race condition
    const [products] = await connection.query(
      'SELECT id, name, unit, sale_price, stock_quantity, is_active FROM products WHERE id IN (?) ORDER BY id ASC FOR UPDATE',
      [productIds]
    );

    if (products.length !== productIds.length) {
      await connection.rollback();
      return res.status(400).json({ error: 'Một số sản phẩm không tồn tại.' });
    }

    const productsMap = new Map();
    products.forEach(p => productsMap.set(p.id, p));

    let hasPriceChange = false;
    let priceChangeMessage = 'Giá của một số sản phẩm đã thay đổi, vui lòng xác nhận đơn giá mới: ';

    for (const item of finalItems) {
      const p = productsMap.get(item.product_id);
      
      if (!p.is_active) {
        await connection.rollback();
        return res.status(400).json({ error: `Sản phẩm ${p.name} đã ngừng kinh doanh.` });
      }

      if (p.stock_quantity < item.quantity) {
        await connection.rollback();
        return res.status(400).json({ error: `Sản phẩm ${p.name} không đủ tồn kho (còn lại: ${p.stock_quantity}, yêu cầu: ${item.quantity}).` });
      }

      const currentSalePrice = Number(p.sale_price);
      if (currentSalePrice !== item.expected_price) {
        hasPriceChange = true;
        priceChangeMessage += `${p.name} (${item.expected_price} -> ${currentSalePrice}); `;
      }

      item.final_price = currentSalePrice;
      const itemTotal = new Decimal(item.quantity).times(new Decimal(currentSalePrice));
      total_amount = total_amount.plus(itemTotal);
    }

    if (total_amount.gte(10000000000000)) {
      await connection.rollback();
      return res.status(400).json({ error: 'Tổng tiền hóa đơn vượt quá giới hạn hệ thống.' });
    }

    if (hasPriceChange) {
      await connection.rollback();
      return res.status(409).json({ 
        error: priceChangeMessage, 
        requires_confirmation: true 
      });
    }

    // Tạo hóa đơn
    const [invoiceResult] = await connection.query(
      `INSERT INTO invoices (invoice_no, created_by, request_key, request_hash, total_amount)
       VALUES (?, ?, ?, ?, ?)`,
      [cleanInvoiceNo, created_by, request_key, request_hash, total_amount.toFixed(2)]
    );
    const invoiceId = invoiceResult.insertId;

    // Chi tiết và biến động
    for (const item of finalItems) {
      const p = productsMap.get(item.product_id);
      const newStock = p.stock_quantity - item.quantity;

      const [itemResult] = await connection.query(
        `INSERT INTO invoice_items (invoice_id, product_id, product_name_snapshot, unit_snapshot, quantity, unit_price)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [invoiceId, p.id, p.name, p.unit, item.quantity, item.final_price]
      );
      const invoiceItemId = itemResult.insertId;

      await connection.query(
        'UPDATE products SET stock_quantity = ? WHERE id = ?',
        [newStock, p.id]
      );

      await connection.query(
        `INSERT INTO stock_movements (product_id, invoice_item_id, quantity_delta, balance_after)
         VALUES (?, ?, ?, ?)`,
        [p.id, invoiceItemId, -item.quantity, newStock]
      );
    }

    await connection.commit();
    res.status(201).json({ message: 'Tạo hóa đơn thành công', id: invoiceId, invoice_no: cleanInvoiceNo });

  } catch (error) {
    await connection.rollback();
    console.error('Lỗi giao dịch tạo hóa đơn:', error);
    if (error.code === 'ER_DUP_ENTRY') {
       try {
         const [retry] = await connection.query(
           'SELECT id, request_hash, invoice_no FROM invoices WHERE created_by = ? AND request_key = ?',
           [created_by, request_key]
         );
         if (retry.length > 0) {
           if (retry[0].request_hash === request_hash) {
             return res.status(200).json({ message: 'Hóa đơn đã được tạo trước đó (Concurrent)', id: retry[0].id, invoice_no: retry[0].invoice_no || cleanInvoiceNo });
           } else {
             return res.status(409).json({ error: 'Yêu cầu bị Conflict (Concurrent).' });
           }
         }
       } catch (err) {}
       return res.status(400).json({ error: 'Yêu cầu trùng lặp hoặc mã hóa đơn đã tồn tại.' });
    }
    res.status(500).json({ error: 'Lỗi máy chủ nội bộ khi tạo hóa đơn' });
  } finally {
    connection.release();
  }
});

module.exports = router;
