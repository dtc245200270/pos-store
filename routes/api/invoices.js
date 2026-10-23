const express = require('express');
const crypto = require('crypto');
const pool = require('../../config/db');
const { requireLogin } = require('../../middleware/auth');
const logger = require('../../config/logger');

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

// Lấy cấu hình tài khoản nhận tiền VietQR từ biến môi trường (Tuyệt đối không trả secret khác về client)
function getPaymentConfig() {
  const bankId = (process.env.VIETQR_BANK_ID || '').trim();
  const bankName = (process.env.VIETQR_BANK_NAME || '').trim();
  const accountNo = (process.env.VIETQR_ACCOUNT_NO || '').trim();
  const accountName = (process.env.VIETQR_ACCOUNT_NAME || '').trim();
  const isConfigured = Boolean(bankId && accountNo && accountName);
  return {
    configured: isConfigured,
    bank_id: isConfigured ? bankId : null,
    bank_name: isConfigured ? (bankName || bankId) : null,
    account_no: isConfigured ? accountNo : null,
    account_name: isConfigured ? accountName : null
  };
}

// Tạo URL mã QR theo chuẩn VietQR Quick Link
// Chuẩn: https://img.vietqr.io/image/<BANK_ID>-<ACCOUNT_NO>-compact.png?amount=<AMOUNT>&addInfo=<TRANSFER_CONTENT>&accountName=<ENCODED_NAME>
function generateVietQRUrl(bankId, accountNo, accountName, amount, addInfo) {
  const baseUrl = `https://img.vietqr.io/image/${encodeURIComponent(bankId)}-${encodeURIComponent(accountNo)}-compact.png`;
  const params = new URLSearchParams();
  params.append('amount', amount.toString());
  params.append('addInfo', addInfo);
  params.append('accountName', accountName);
  return `${baseUrl}?${params.toString()}`;
}

// API lấy thông tin cấu hình tài khoản nhận tiền phục vụ giao diện thanh toán
router.get('/payment-config', (req, res) => {
  res.json(getPaymentConfig());
});

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
    const dataSql = `SELECT i.id, i.invoice_no, i.total_amount, i.payment_method, i.transfer_content, i.transfer_confirmed_at, i.created_at, u.full_name as created_by_name
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
    return logger.sendServerError(res, req, 'get_invoices', error);
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
    return logger.sendServerError(res, req, 'get_invoice_sellers', error);
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
    return logger.sendServerError(res, req, 'get_invoice_detail', error);
  }
});

// Chuẩn bị thông tin thanh toán chuyển khoản QR (VietQR)
// Kiểm tra sản phẩm, tồn kho, giá và tính lại tổng tiền. KHÔNG tạo hóa đơn, KHÔNG trừ kho, KHÔNG giữ hàng.
router.post('/prepare-qr', async (req, res) => {
  const Decimal = require('decimal.js');
  const { items } = req.body;

  // 1. Kiểm tra cấu hình tài khoản nhận tiền
  const config = getPaymentConfig();
  if (!config.configured) {
    return res.status(400).json({ error: 'Chưa cấu hình tài khoản nhận chuyển khoản' });
  }

  // 2. Kiểm tra giỏ hàng
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Giỏ hàng trống. Vui lòng thêm sản phẩm vào giỏ trước khi tạo mã QR.' });
  }

  // 3. Gộp sản phẩm và kiểm tra dữ liệu đầu vào
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
  const productIds = finalItems.map(i => i.product_id);

  try {
    const [products] = await pool.query(
      'SELECT id, name, unit, sale_price, stock_quantity, is_active FROM products WHERE id IN (?) ORDER BY id ASC',
      [productIds]
    );

    if (products.length !== productIds.length) {
      return res.status(400).json({ error: 'Một số sản phẩm không tồn tại trong hệ thống.' });
    }

    const productsMap = new Map();
    products.forEach(p => productsMap.set(p.id, p));

    let total_amount = new Decimal(0);
    let hasPriceChange = false;
    let priceChangeMessage = 'Giá của một số sản phẩm đã thay đổi, vui lòng xác nhận đơn giá mới: ';

    for (const item of finalItems) {
      const p = productsMap.get(item.product_id);

      if (!p.is_active) {
        return res.status(400).json({ error: `Sản phẩm ${p.name} đã ngừng kinh doanh.` });
      }

      if (p.stock_quantity < item.quantity) {
        return res.status(400).json({ error: `Sản phẩm ${p.name} không đủ tồn kho (còn lại: ${p.stock_quantity}, yêu cầu: ${item.quantity}).` });
      }

      const currentSalePrice = Number(p.sale_price);
      if (currentSalePrice !== item.expected_price) {
        hasPriceChange = true;
        priceChangeMessage += `${p.name} (${item.expected_price} -> ${currentSalePrice}); `;
      }

      const itemTotal = new Decimal(item.quantity).times(new Decimal(currentSalePrice));
      total_amount = total_amount.plus(itemTotal);
    }

    if (total_amount.gte(10000000000000)) {
      return res.status(400).json({ error: 'Tổng tiền hóa đơn vượt quá giới hạn hệ thống.' });
    }

    // Không làm tròn tiền, từ chối tạo QR nếu tổng tiền có phần lẻ VND
    if (!total_amount.modulo(1).isZero()) {
      return res.status(400).json({
        error: `Tổng tiền thanh toán (${total_amount.toFixed(2)} đ) có phần lẻ VND, không phải số nguyên. Hệ thống hiện chưa hỗ trợ tạo mã QR cho số tiền lẻ VND. Vui lòng chọn thanh toán bằng Tiền mặt.`
      });
    }

    if (hasPriceChange) {
      return res.status(409).json({ 
        error: priceChangeMessage, 
        requires_confirmation: true 
      });
    }

    // Tạo nội dung chuyển khoản ngắn, duy nhất, tối đa khoảng 12-14 ký tự
    const transferContent = `POS${Date.now().toString().slice(-6)}${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    const qrUrl = generateVietQRUrl(config.bank_id, config.account_no, config.account_name, total_amount.toNumber(), transferContent);

    res.json({
      amount: total_amount.toNumber(),
      amount_formatted: total_amount.toFixed(2),
      transfer_content: transferContent,
      bank_id: config.bank_id,
      bank_name: config.bank_name,
      account_no: config.account_no,
      account_name: config.account_name,
      qr_url: qrUrl
    });
  } catch (error) {
    return logger.sendServerError(res, req, 'prepare_qr', error);
  }
});

// Tạo hóa đơn bán hàng
router.post('/', async (req, res) => {
  const Decimal = require('decimal.js');
  const { invoice_no, request_key, items, payment_method, transfer_content } = req.body;
  const created_by = req.session.userId;

  const cleanInvoiceNo = typeof invoice_no === 'string' ? invoice_no.trim() : '';
  const cleanPaymentMethod = payment_method ? String(payment_method).trim().toUpperCase() : 'CASH';

  if (cleanPaymentMethod !== 'CASH' && cleanPaymentMethod !== 'BANK_TRANSFER') {
    return res.status(400).json({ error: 'Phương thức thanh toán không hợp lệ (chỉ chấp nhận CASH hoặc BANK_TRANSFER).' });
  }

  let cleanTransferContent = null;
  if (cleanPaymentMethod === 'BANK_TRANSFER') {
    const config = getPaymentConfig();
    if (!config.configured) {
      return res.status(400).json({ error: 'Chưa cấu hình tài khoản nhận chuyển khoản' });
    }
    if (!transfer_content || typeof transfer_content !== 'string' || !transfer_content.trim()) {
      return res.status(400).json({ error: 'Thiếu nội dung chuyển khoản cho phương thức Chuyển khoản QR.' });
    }
    const trimmedContent = transfer_content.trim();
    if (trimmedContent.length > 50) {
      return res.status(400).json({ error: 'Nội dung chuyển khoản vượt quá độ dài tối đa cho phép (tối đa 50 ký tự).' });
    }
    if (!/^[A-Za-z0-9_-]+$/.test(trimmedContent)) {
      return res.status(400).json({ error: 'Nội dung chuyển khoản không hợp lệ. Chỉ chấp nhận chữ cái, chữ số, dấu gạch dưới hoặc gạch nối (không chứa ký tự đặc biệt hoặc HTML).' });
    }
    cleanTransferContent = trimmedContent;
  }

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

  // Hash bao gồm phương thức thanh toán và nội dung chuyển khoản để chống gửi sai dữ liệu với cùng request_key
  const hashPayload = JSON.stringify({
    invoice_no: cleanInvoiceNo,
    payment_method: cleanPaymentMethod,
    transfer_content: cleanTransferContent,
    items: finalItems
  });
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
        if (cleanPaymentMethod === 'BANK_TRANSFER') {
          return res.status(409).json({
            error: `Lập hóa đơn thất bại do sản phẩm ${p.name} đã ngừng kinh doanh trong lúc chờ thanh toán. Khách hàng có thể đã chuyển khoản, vui lòng đối soát số dư tài khoản ngân hàng và liên hệ xử lý trực tiếp với khách hàng (Không tự ý đổi số tiền hoặc tự hoàn tiền).`,
            reconciliation_required: true
          });
        }
        return res.status(400).json({ error: `Sản phẩm ${p.name} đã ngừng kinh doanh.` });
      }

      if (p.stock_quantity < item.quantity) {
        await connection.rollback();
        if (cleanPaymentMethod === 'BANK_TRANSFER') {
          return res.status(409).json({
            error: `Lập hóa đơn thất bại do sản phẩm ${p.name} không đủ tồn kho (còn lại: ${p.stock_quantity}, yêu cầu: ${item.quantity}). Khách hàng có thể đã chuyển khoản, vui lòng đối soát số dư tài khoản ngân hàng và liên hệ xử lý trực tiếp với khách hàng (Không tự ý đổi giá hoặc xuất hóa đơn sai).`,
            reconciliation_required: true
          });
        }
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

    if (cleanPaymentMethod === 'BANK_TRANSFER' && !total_amount.modulo(1).isZero()) {
      await connection.rollback();
      return res.status(400).json({
        error: `Tổng tiền thanh toán (${total_amount.toFixed(2)} đ) có phần lẻ VND, không phải số nguyên. Phương thức Chuyển khoản QR chỉ hỗ trợ số nguyên VND. Vui lòng chọn thanh toán bằng Tiền mặt.`
      });
    }

    if (hasPriceChange) {
      await connection.rollback();
      if (cleanPaymentMethod === 'BANK_TRANSFER') {
        return res.status(409).json({
          error: `Lập hóa đơn thất bại do giá sản phẩm đã thay đổi trong lúc chờ thanh toán: ${priceChangeMessage}. Khách hàng có thể đã chuyển khoản số tiền cũ, vui lòng đối soát số dư tài khoản ngân hàng và liên hệ xử lý trực tiếp với khách hàng (Không tự ý đổi số tiền hoặc xuất sai hóa đơn).`,
          reconciliation_required: true
        });
      }
      return res.status(409).json({ 
        error: priceChangeMessage, 
        requires_confirmation: true 
      });
    }

    // Tạo hóa đơn
    const transferConfirmedAt = cleanPaymentMethod === 'BANK_TRANSFER' ? new Date() : null;
    const [invoiceResult] = await connection.query(
      `INSERT INTO invoices (invoice_no, created_by, request_key, request_hash, total_amount, payment_method, transfer_content, transfer_confirmed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [cleanInvoiceNo, created_by, request_key, request_hash, total_amount.toFixed(2), cleanPaymentMethod, cleanTransferContent, transferConfirmedAt]
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
    return logger.sendServerError(res, req, 'create_invoice', error);
  } finally {
    connection.release();
  }
});

module.exports = router;
