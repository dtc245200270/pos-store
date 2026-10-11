const express = require('express');
const crypto = require('crypto');
const pool = require('../../config/db');
const { requireRole } = require('../../middleware/auth');

const router = express.Router();

router.use(requireRole('MANAGER'));

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

// Lấy danh sách phiếu nhập (hỗ trợ tìm theo mã, lọc ngày theo giờ VN, phân trang)
router.get('/', async (req, res) => {
  try {
    const { q, from_date, to_date, page: pageQuery, limit: limitQuery, paginate } = req.query;

    const conditions = [];
    const params = [];

    // Tìm kiếm theo mã phiếu nhập
    if (q && typeof q === 'string' && q.trim()) {
      conditions.push('sr.receipt_no LIKE ?');
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
      conditions.push('sr.created_at >= ?');
      params.push(`${cleanFromDate} 00:00:00`);
    }
    if (cleanToDate) {
      conditions.push('sr.created_at <= ?');
      params.push(`${cleanToDate} 23:59:59`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const hasAnyParam = pageQuery !== undefined || limitQuery !== undefined || paginate !== undefined || q || from_date || to_date;

    // Nếu có yêu cầu phân trang hoặc tìm kiếm/lọc
    if (hasAnyParam) {
      const countSql = `SELECT COUNT(*) AS total
                        FROM stock_receipts sr
                        JOIN users u ON sr.created_by = u.id
                        ${whereClause}`;
      const [countRows] = await pool.query(countSql, params);
      const total = Number(countRows[0]?.total || 0);

      const page = Math.max(1, parseInt(pageQuery, 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(limitQuery, 10) || 10));
      const totalPages = total > 0 ? Math.ceil(total / limit) : 0;
      const offset = (page - 1) * limit;

      const dataSql = `SELECT sr.id, sr.receipt_no, sr.total_amount, sr.created_at, u.full_name as created_by_name, u.username as created_by_username
                       FROM stock_receipts sr
                       JOIN users u ON sr.created_by = u.id
                       ${whereClause}
                       ORDER BY sr.created_at DESC, sr.id DESC
                       LIMIT ? OFFSET ?`;
      const [rows] = await pool.query(dataSql, [...params, limit, offset]);

      return res.json({
        receipts: rows,
        data: rows,
        items: rows,
        total,
        page,
        totalPages,
        limit,
        pagination: {
          page,
          limit,
          total,
          totalPages
        }
      });
    }

    // Tương thích ngược: khi không truyền tham số truy vấn nào (như integration test cũ)
    const [rows] = await pool.query(
      `SELECT sr.id, sr.receipt_no, sr.total_amount, sr.created_at, u.full_name as created_by_name, u.username as created_by_username
       FROM stock_receipts sr
       JOIN users u ON sr.created_by = u.id
       ORDER BY sr.created_at DESC, sr.id DESC`,
      params
    );
    res.json(rows);
  } catch (error) {
    console.error('Lỗi lấy phiếu nhập:', error);
    res.status(500).json({ error: 'Lỗi máy chủ nội bộ' });
  }
});

// Xem chi tiết phiếu nhập (có mã phiếu, người lập, giờ VN, SKU/tên, ĐVT, số lượng, giá nhập, tổng tiền)
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const numId = parseInt(id, 10);
  if (isNaN(numId) || numId <= 0) {
    return res.status(404).json({ error: 'Không tìm thấy phiếu nhập' });
  }

  try {
    const [receipts] = await pool.query(
      `SELECT sr.*, u.full_name as created_by_name, u.username as created_by_username
       FROM stock_receipts sr
       JOIN users u ON sr.created_by = u.id
       WHERE sr.id = ?`,
      [numId]
    );

    if (receipts.length === 0) {
      return res.status(404).json({ error: 'Không tìm thấy phiếu nhập' });
    }

    const [items] = await pool.query(
      `SELECT sri.*, p.sku
       FROM stock_receipt_items sri
       LEFT JOIN products p ON sri.product_id = p.id
       WHERE sri.receipt_id = ?
       ORDER BY sri.id ASC`,
      [numId]
    );

    res.json({ receipt: receipts[0], items });
  } catch (error) {
    console.error('Lỗi lấy chi tiết phiếu nhập:', error);
    res.status(500).json({ error: 'Lỗi máy chủ nội bộ' });
  }
});

// Tạo phiếu nhập (có transaction, chống gửi lặp, cập nhật tồn kho và biến động kho)
router.post('/', async (req, res) => {
  const Decimal = require('decimal.js');
  const { receipt_no, request_key, items } = req.body;
  const created_by = req.session.userId;

  const cleanReceiptNo = typeof receipt_no === 'string' ? receipt_no.trim() : '';

  if (!cleanReceiptNo || !request_key || typeof request_key !== 'string' || !items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Dữ liệu không hợp lệ. Phải có ít nhất 1 sản phẩm và mã chứng từ.' });
  }

  // Gộp sản phẩm trùng trong cùng chứng từ và kiểm tra dữ liệu đầu vào
  const mergedItemsMap = new Map();
  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return res.status(400).json({ error: 'Chi tiết sản phẩm phải là object' });
    }
    const qty = Number(item.quantity);
    const cost = Number(item.unit_cost);

    if (item.product_id === null || item.product_id === undefined || typeof item.product_id !== 'number' || typeof item.quantity !== 'number' || typeof item.unit_cost !== 'number') {
      return res.status(400).json({ error: 'Sai kiểu dữ liệu' });
    }
    if (!item.product_id || !Number.isInteger(qty) || qty <= 0 || isNaN(cost) || cost < 0 || qty > 2147483647) {
      return res.status(400).json({ error: 'Chi tiết sản phẩm không hợp lệ (số lượng phải là số nguyên dương <= 2147483647, giá nhập >= 0).' });
    }
    // Giá nhập tối đa 2 chữ số thập phân
    if (!/^\d+(\.\d{1,2})?$/.test(item.unit_cost.toString().trim())) {
      return res.status(400).json({ error: 'Giá nhập không được vượt quá 2 chữ số thập phân.' });
    }
    if (cost >= 10000000000000) {
      return res.status(400).json({ error: 'Giá nhập vượt quá giới hạn hệ thống.' });
    }

    const pid = Number(item.product_id);
    if (mergedItemsMap.has(pid)) {
      const existing = mergedItemsMap.get(pid);
      if (existing.unit_cost !== cost) {
        return res.status(400).json({ error: `Sản phẩm ID ${pid} có nhiều đơn giá khác nhau trong cùng phiếu. Vui lòng thống nhất.` });
      }
      existing.quantity += qty;
      if (existing.quantity > 2147483647) {
        return res.status(400).json({ error: 'Số lượng sau gộp vượt quá giới hạn' });
      }
    } else {
      mergedItemsMap.set(pid, {
        product_id: pid,
        quantity: qty,
        unit_cost: cost
      });
    }
  }

  const finalItems = Array.from(mergedItemsMap.values());
  // Sắp xếp theo product_id để tránh deadlock khi SELECT ... FOR UPDATE
  finalItems.sort((a, b) => a.product_id - b.product_id);

  // Tính hash request để chống gửi trùng / idempotency
  const hashPayload = JSON.stringify({ receipt_no: cleanReceiptNo, items: finalItems });
  const request_hash = crypto.createHash('sha256').update(hashPayload).digest('hex');

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 1. Kiểm tra mã phiếu và request_key (Idempotency)
    const [existing] = await connection.query(
      'SELECT id, request_hash, receipt_no, request_key, created_by FROM stock_receipts WHERE receipt_no = ? OR (created_by = ? AND request_key = ?)',
      [cleanReceiptNo, created_by, request_key]
    );

    if (existing.length > 0) {
      await connection.rollback();
      for (const doc of existing) {
        if (doc.created_by === created_by && doc.request_key === request_key) {
          if (doc.request_hash === request_hash) {
            return res.status(200).json({ message: 'Phiếu nhập đã được tạo trước đó', id: doc.id, receipt_no: doc.receipt_no });
          } else {
            return res.status(409).json({ error: 'Yêu cầu bị Conflict do trùng request_key nhưng khác dữ liệu (Hash).' });
          }
        }
      }
      return res.status(400).json({ error: 'Mã phiếu nhập đã tồn tại. Vui lòng nhập mã khác.' });
    }

    // 2. Lấy thông tin sản phẩm và khóa dòng (SELECT ... FOR UPDATE)
    let total_amount = new Decimal(0);
    const productIds = finalItems.map(i => i.product_id);
    
    const [products] = await connection.query(
      'SELECT id, name, unit, stock_quantity, is_active FROM products WHERE id IN (?) ORDER BY id ASC FOR UPDATE',
      [productIds]
    );

    if (products.length !== productIds.length) {
      await connection.rollback();
      return res.status(400).json({ error: 'Một số sản phẩm không tồn tại.' });
    }

    const productsMap = new Map();
    products.forEach(p => productsMap.set(p.id, p));

    for (const item of finalItems) {
      const p = productsMap.get(item.product_id);
      if (!p.is_active) {
        await connection.rollback();
        return res.status(400).json({ error: `Sản phẩm ${p.name} đã ngừng kinh doanh.` });
      }
      const itemTotal = new Decimal(item.quantity).times(new Decimal(item.unit_cost));
      total_amount = total_amount.plus(itemTotal);
    }

    if (total_amount.gte(10000000000000)) {
      await connection.rollback();
      return res.status(400).json({ error: 'Tổng tiền phiếu nhập vượt quá giới hạn hệ thống.' });
    }

    // 3. Tạo phiếu nhập
    const [receiptResult] = await connection.query(
      `INSERT INTO stock_receipts (receipt_no, created_by, request_key, request_hash, total_amount)
       VALUES (?, ?, ?, ?, ?)`,
      [cleanReceiptNo, created_by, request_key, request_hash, total_amount.toFixed(2)]
    );
    const receiptId = receiptResult.insertId;

    // 4. Lưu chi tiết, cập nhật tồn kho và stock_movements
    for (const item of finalItems) {
      const p = productsMap.get(item.product_id);
      const newStock = p.stock_quantity + item.quantity;
      if (newStock > 2147483647) {
        await connection.rollback();
        return res.status(400).json({ error: `Tồn kho sau nhập của ${p.name} vượt quá giới hạn.` });
      }

      // Lưu chi tiết phiếu nhập
      const [itemResult] = await connection.query(
        `INSERT INTO stock_receipt_items (receipt_id, product_id, product_name_snapshot, unit_snapshot, quantity, unit_cost)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [receiptId, p.id, p.name, p.unit, item.quantity, item.unit_cost]
      );
      const receiptItemId = itemResult.insertId;

      // Cập nhật tồn kho sản phẩm
      await connection.query(
        'UPDATE products SET stock_quantity = ? WHERE id = ?',
        [newStock, p.id]
      );

      // Lưu lịch sử biến động kho
      await connection.query(
        `INSERT INTO stock_movements (product_id, receipt_item_id, quantity_delta, balance_after)
         VALUES (?, ?, ?, ?)`,
        [p.id, receiptItemId, item.quantity, newStock]
      );
    }

    // Commit toàn bộ - chỉ thành công khi toàn bộ các bước hoàn tất
    await connection.commit();
    res.status(201).json({ message: 'Tạo phiếu nhập thành công', id: receiptId, receipt_no: cleanReceiptNo, total_amount: total_amount.toFixed(2) });

  } catch (error) {
    await connection.rollback();
    console.error('Lỗi giao dịch tạo phiếu nhập:', error);
    if (error.code === 'ER_DUP_ENTRY') {
       try {
         const [retry] = await connection.query(
           'SELECT id, request_hash, receipt_no FROM stock_receipts WHERE created_by = ? AND request_key = ?',
           [created_by, request_key]
         );
         if (retry.length > 0) {
           if (retry[0].request_hash === request_hash) {
             return res.status(200).json({ message: 'Phiếu nhập đã được tạo trước đó (Concurrent)', id: retry[0].id, receipt_no: retry[0].receipt_no });
           } else {
             return res.status(409).json({ error: 'Yêu cầu bị Conflict (Concurrent).' });
           }
         }
       } catch (err) {}
       return res.status(400).json({ error: 'Mã phiếu nhập đã tồn tại. Vui lòng nhập mã khác.' });
    }
    res.status(500).json({ error: 'Lỗi máy chủ nội bộ khi tạo phiếu nhập' });
  } finally {
    connection.release();
  }
});

// Chặn sửa/xóa phiếu nhập đã ghi nhận để bảo toàn chứng từ kế toán
router.put('/:id', (req, res) => {
  res.status(405).json({ error: 'Không cho phép sửa phiếu nhập đã ghi nhận để bảo toàn chứng từ kế toán và lịch sử kho.' });
});

router.delete('/:id', (req, res) => {
  res.status(405).json({ error: 'Không cho phép xóa phiếu nhập đã ghi nhận để bảo toàn chứng từ kế toán và lịch sử kho.' });
});

module.exports = router;

