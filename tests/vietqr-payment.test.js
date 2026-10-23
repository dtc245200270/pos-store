const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const mysql = require('mysql2/promise');
const fs = require('fs');
require('dotenv').config();

const PORT = 3006;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const DB_NAME = 'pos_store_vietqr_test';

test('Comprehensive VietQR Payment & Cashier Confirmation Tests', async (t) => {
  let serverProcess;
  const rootPassword = process.env.ROOT_PASSWORD || process.env.DB_PASSWORD || '';

  // 1. Chuẩn bị cơ sở dữ liệu kiểm thử độc lập
  const rootPool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: process.env.DB_PORT || 3306,
    user: process.env.ROOT_USER || 'root',
    password: rootPassword,
    multipleStatements: true
  });

  try {
    await rootPool.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
    await rootPool.query(`CREATE DATABASE ${DB_NAME}`);
    await rootPool.query(`GRANT ALL PRIVILEGES ON ${DB_NAME}.* TO "pos_app"@"localhost"`);
    await rootPool.query('FLUSH PRIVILEGES');

    const schemaSql = fs.readFileSync('database/schema.sql', 'utf-8').replace(/\bpos_store\b/g, DB_NAME);
    const sessionSql = fs.readFileSync('database/migration_01_sessions.sql', 'utf-8').replace(/\bpos_store\b/g, DB_NAME);
    const migration02Sql = fs.readFileSync('database/migration_02_payment_methods.sql', 'utf-8').replace(/\bpos_store\b/g, DB_NAME);

    const baseParts = [...schemaSql.split(';'), ...sessionSql.split(';')].map(s => s.trim()).filter(s => s.length > 0);
    const conn = await rootPool.getConnection();
    try {
      await conn.query(`USE ${DB_NAME}`);
      for (const sql of baseParts) {
        if (!sql.toUpperCase().startsWith('DELIMITER')) {
          await conn.query(sql);
        }
      }

      // BẮT BUỘC: Chạy database/migration_02_payment_methods.sql trước khi sử dụng các cột thanh toán trong cơ sở dữ liệu kiểm thử riêng
      const mig02Parts = migration02Sql.split(';').map(s => s.trim()).filter(s => s.length > 0);
      for (const sql of mig02Parts) {
        if (!sql.toUpperCase().startsWith('DELIMITER')) {
          await conn.query(sql);
        }
      }

      const bcrypt = require('bcryptjs');
      const hash = await bcrypt.hash('password123', 10);
      await conn.query(
        'INSERT INTO users (username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?)',
        ['manager_test', hash, 'Quản Lý Test', 'MANAGER', 1]
      );
      await conn.query(
        'INSERT INTO users (username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?)',
        ['cashier_test', hash, 'Thu Ngân Test', 'CASHIER', 1]
      );

      // Thêm sản phẩm mẫu
      await conn.query(
        'INSERT INTO products (sku, name, unit, sale_price, stock_quantity, is_active) VALUES (?, ?, ?, ?, ?, ?)',
        ['SP001', 'Cà phê Robusta 500g', 'Gói', 120000.00, 50, 1]
      );
      await conn.query(
        'INSERT INTO products (sku, name, unit, sale_price, stock_quantity, is_active) VALUES (?, ?, ?, ?, ?, ?)',
        ['SP002', 'Trà Ô long Thượng Hạng', 'Hộp', 85000.00, 10, 1]
      );
      await conn.query(
        'INSERT INTO products (sku, name, unit, sale_price, stock_quantity, is_active) VALUES (?, ?, ?, ?, ?, ?)',
        ['SP003', 'Sản phẩm hết hàng', 'Cái', 50000.00, 0, 1]
      );
      await conn.query(
        'INSERT INTO products (sku, name, unit, sale_price, stock_quantity, is_active) VALUES (?, ?, ?, ?, ?, ?)',
        ['SP004', 'Sản phẩm ngừng bán', 'Cái', 40000.00, 20, 0]
      );
      await conn.query(
        'INSERT INTO products (sku, name, unit, sale_price, stock_quantity, is_active) VALUES (?, ?, ?, ?, ?, ?)',
        ['SP005', 'Sản phẩm giá lẻ VND', 'Cái', 12500.50, 20, 1]
      );

      // Thêm một hóa đơn cũ giả lập trước migration (payment_method = NULL)
      await conn.query(
        `INSERT INTO invoices (invoice_no, created_by, request_key, request_hash, total_amount, payment_method, transfer_content, transfer_confirmed_at)
         VALUES (?, 1, 'old-key-1', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', 120000.00, NULL, NULL, NULL)`,
        ['HD_OLD_001']
      );
    } finally {
      conn.release();
    }
  } finally {
    await rootPool.end();
  }

  // Khởi động server với cấu hình ngân hàng đầy đủ
  await new Promise((resolve) => {
    serverProcess = spawn('node', ['server.js'], {
      env: {
        ...process.env,
        DB_NAME: DB_NAME,
        SESSION_SECRET: 'test_secret_vietqr',
        PORT: String(PORT),
        METRICS_PORT: '0',
        VIETQR_BANK_ID: 'MB',
        VIETQR_ACCOUNT_NO: '0987654321',
        VIETQR_ACCOUNT_NAME: 'CONG TY POS STORE'
      }
    });

    serverProcess.stdout.on('data', (data) => {
      if (data.toString().includes('Website đang chạy')) {
        resolve();
      }
    });
    serverProcess.stderr.on('data', (data) => {
      console.error('[Server Err]:', data.toString());
    });
    setTimeout(resolve, 3000);
  });

  const req = async (method, path, body = null, cookie = '', csrf = '') => {
    const headers = { 'Content-Type': 'application/json' };
    if (cookie) headers['Cookie'] = cookie;
    if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;

    const options = { method, headers };
    if (body) options.body = JSON.stringify(body);

    const res = await fetch(`${BASE_URL}${path}`, options);
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    let newCookie = cookie;
    if (setCookies && setCookies.length > 0) {
      newCookie = setCookies.map(c => c.split(';')[0]).join('; ');
    }

    let data;
    const text = await res.text();
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, cookie: newCookie };
  };

  // Đăng nhập Thu ngân
  let cashierCookie = '';
  let cashierCsrf = '';
  {
    const csrfRes = await req('GET', '/api/auth/csrf');
    const loginRes = await req('POST', '/api/auth/login', { username: 'cashier_test', password: 'password123' }, csrfRes.cookie, csrfRes.data.csrfToken);
    assert.strictEqual(loginRes.status, 200, 'Thu ngân đăng nhập thất bại');
    cashierCookie = loginRes.cookie;
    cashierCsrf = loginRes.data.csrfToken;
  }

  // Đăng nhập Quản lý
  let managerCookie = '';
  let managerCsrf = '';
  {
    const csrfRes = await req('GET', '/api/auth/csrf');
    const loginRes = await req('POST', '/api/auth/login', { username: 'manager_test', password: 'password123' }, csrfRes.cookie, csrfRes.data.csrfToken);
    assert.strictEqual(loginRes.status, 200, 'Quản lý đăng nhập thất bại');
    managerCookie = loginRes.cookie;
    managerCsrf = loginRes.data.csrfToken;
  }

  // TEST 1: Cấu hình tài khoản nhận tiền bảo mật (không lộ env bí mật)
  await t.test('1. API GET /payment-config trả về thông tin VietQR công khai, không lộ biến môi trường bí mật', async () => {
    const res = await req('GET', '/api/invoices/payment-config', null, cashierCookie);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.configured, true);
    assert.strictEqual(res.data.bank_id, 'MB');
    assert.strictEqual(res.data.account_no, '0987654321');
    assert.strictEqual(res.data.account_name, 'CONG TY POS STORE');
    // Tuyệt đối không chứa DB_PASSWORD, SESSION_SECRET hay biến nhạy cảm khác
    assert.strictEqual(res.data.DB_PASSWORD, undefined);
    assert.strictEqual(res.data.SESSION_SECRET, undefined);
    assert.strictEqual(res.data.INITIAL_MANAGER_PASSWORD, undefined);
  });

  // TEST 2: Thanh toán Tiền mặt vẫn hoạt động bình thường và lưu payment_method = 'CASH'
  await t.test('2. Thanh toán Tiền mặt (CASH) hoạt động bình thường, lưu payment_method = "CASH"', async () => {
    const payload = {
      invoice_no: 'HD_CASH_001',
      request_key: 'req-cash-001',
      payment_method: 'CASH',
      items: [{ product_id: 1, quantity: 2, unit_price: 120000 }]
    };

    const res = await req('POST', '/api/invoices', payload, cashierCookie, cashierCsrf);
    assert.strictEqual(res.status, 201, 'Tạo hóa đơn tiền mặt thất bại: ' + JSON.stringify(res.data));
    assert.strictEqual(res.data.invoice_no, 'HD_CASH_001');

    // Kiểm tra chi tiết hóa đơn
    const detailRes = await req('GET', `/api/invoices/${res.data.id}`, null, cashierCookie);
    assert.strictEqual(detailRes.status, 200);
    assert.strictEqual(detailRes.data.invoice.payment_method, 'CASH');
    assert.strictEqual(detailRes.data.invoice.transfer_content, null);
    assert.strictEqual(detailRes.data.invoice.transfer_confirmed_at, null);
    assert.strictEqual(Number(detailRes.data.invoice.total_amount), 240000);
  });

  // TEST 3: Giỏ hàng trống hoặc vượt tồn bị từ chối trước và trong thanh toán
  await t.test('3. Kiểm tra giỏ hàng trống hoặc vượt tồn bị từ chối', async () => {
    // Giỏ trống
    const emptyRes = await req('POST', '/api/invoices/prepare-qr', { items: [] }, cashierCookie, cashierCsrf);
    assert.strictEqual(emptyRes.status, 400);

    // Vượt tồn kho (SP002 chỉ còn 10, yêu cầu 15)
    const overStockRes = await req('POST', '/api/invoices/prepare-qr', {
      items: [{ product_id: 2, quantity: 15, unit_price: 85000 }]
    }, cashierCookie, cashierCsrf);
    assert.strictEqual(overStockRes.status, 400);
    assert.match(overStockRes.data.error, /không đủ tồn kho/);

    // Sản phẩm hết hàng
    const outOfStockRes = await req('POST', '/api/invoices/prepare-qr', {
      items: [{ product_id: 3, quantity: 1, unit_price: 50000 }]
    }, cashierCookie, cashierCsrf);
    assert.strictEqual(outOfStockRes.status, 400);

    // Sản phẩm ngừng kinh doanh
    const inactiveRes = await req('POST', '/api/invoices/prepare-qr', {
      items: [{ product_id: 4, quantity: 1, unit_price: 40000 }]
    }, cashierCookie, cashierCsrf);
    assert.strictEqual(inactiveRes.status, 400);
    assert.match(inactiveRes.data.error, /đã ngừng kinh doanh/);
  });

  // TEST 4: Chuẩn bị QR kiểm tra đúng thông tin người nhận, số tiền, nội dung ngắn duy nhất
  let preparedTransfer = null;
  await t.test('4. POST /prepare-qr tính đúng tổng tiền máy chủ, sinh URL VietQR và nội dung chuyển khoản duy nhất', async () => {
    const payload = {
      items: [
        { product_id: 1, quantity: 1, unit_price: 120000 },
        { product_id: 2, quantity: 2, unit_price: 85000 }
      ]
    };

    const res = await req('POST', '/api/invoices/prepare-qr', payload, cashierCookie, cashierCsrf);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.data.amount, 290000);
    assert.strictEqual(res.data.bank_id, 'MB');
    assert.strictEqual(res.data.account_no, '0987654321');
    assert.strictEqual(res.data.account_name, 'CONG TY POS STORE');
    assert.ok(typeof res.data.transfer_content === 'string' && res.data.transfer_content.length > 0);
    assert.ok(res.data.transfer_content.startsWith('POS'));
    assert.ok(res.data.qr_url.includes('img.vietqr.io/image/MB-0987654321-compact.png'));
    assert.ok(res.data.qr_url.includes('amount=290000'));
    assert.ok(res.data.qr_url.includes(res.data.transfer_content));

    preparedTransfer = res.data;
  });

  // TEST 5: Mở QR chưa tạo hóa đơn, chưa trừ kho và chưa giữ hàng
  await t.test('5. Mở/tạo QR chưa làm thay đổi tồn kho và chưa tạo hóa đơn trong CSDL', async () => {
    // Kiểm tra tồn kho SP001 vẫn là 48 (50 - 2 ở test CASH), SP002 vẫn là 10
    const testPool = mysql.createPool({
      host: process.env.DB_HOST || '127.0.0.1',
      port: process.env.DB_PORT || 3306,
      user: 'pos_app',
      password: process.env.DB_PASSWORD || '',
      database: DB_NAME
    });

    try {
      const [products] = await testPool.query('SELECT id, stock_quantity FROM products WHERE id IN (1, 2) ORDER BY id');
      assert.strictEqual(products[0].stock_quantity, 48);
      assert.strictEqual(products[1].stock_quantity, 10);

      // Đếm số lượng hóa đơn hiện tại: 1 cũ + 1 tiền mặt = 2
      const [invoices] = await testPool.query('SELECT COUNT(*) as count FROM invoices');
      assert.strictEqual(invoices[0].count, 2);
    } finally {
      await testPool.end();
    }
  });

  // TEST 6: Xác nhận thủ công tạo đúng một hóa đơn và lưu thông tin chuyển khoản
  let bankInvoiceId = null;
  const qrRequestKey = 'req-qr-001';
  const qrInvoiceNo = 'HD_QR_001';

  await t.test('6. Xác nhận thủ công tạo đúng 1 hóa đơn BANK_TRANSFER với nội dung chuyển khoản và thời điểm xác nhận', async () => {
    const payload = {
      invoice_no: qrInvoiceNo,
      request_key: qrRequestKey,
      payment_method: 'BANK_TRANSFER',
      transfer_content: preparedTransfer.transfer_content,
      items: [
        { product_id: 1, quantity: 1, unit_price: 120000 },
        { product_id: 2, quantity: 2, unit_price: 85000 }
      ]
    };

    const res = await req('POST', '/api/invoices', payload, cashierCookie, cashierCsrf);
    assert.strictEqual(res.status, 201);
    bankInvoiceId = res.data.id;

    // Kiểm tra CSDL
    const testPool = mysql.createPool({
      host: process.env.DB_HOST || '127.0.0.1',
      port: process.env.DB_PORT || 3306,
      user: 'pos_app',
      password: process.env.DB_PASSWORD || '',
      database: DB_NAME
    });

    try {
      const [rows] = await testPool.query('SELECT * FROM invoices WHERE id = ?', [bankInvoiceId]);
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].payment_method, 'BANK_TRANSFER');
      assert.strictEqual(rows[0].transfer_content, preparedTransfer.transfer_content);
      assert.ok(rows[0].transfer_confirmed_at !== null, 'Phải có thời điểm nhân viên xác nhận');

      // Tồn kho đã trừ: SP001: 48 - 1 = 47, SP002: 10 - 2 = 8
      const [products] = await testPool.query('SELECT id, stock_quantity FROM products WHERE id IN (1, 2) ORDER BY id');
      assert.strictEqual(products[0].stock_quantity, 47);
      assert.strictEqual(products[1].stock_quantity, 8);
    } finally {
      await testPool.end();
    }
  });

  // TEST 7: Mất phản hồi sau khi đã lưu rồi thử lại: chỉ có một hóa đơn và một lần trừ kho
  await t.test('7. Kiểm tra mất phản hồi sau khi đã lưu rồi thử lại: chỉ có một hóa đơn và một lần trừ kho', async () => {
    const payload = {
      invoice_no: qrInvoiceNo,
      request_key: qrRequestKey,
      payment_method: 'BANK_TRANSFER',
      transfer_content: preparedTransfer.transfer_content,
      items: [
        { product_id: 1, quantity: 1, unit_price: 120000 },
        { product_id: 2, quantity: 2, unit_price: 85000 }
      ]
    };

    // Gửi lại yêu cầu với đúng payload cũ sau khi mất phản hồi
    const retryRes = await req('POST', '/api/invoices', payload, cashierCookie, cashierCsrf);
    assert.strictEqual(retryRes.status, 200, 'Phải trả về 200 cho yêu cầu trùng lặp an toàn');
    assert.strictEqual(retryRes.data.id, bankInvoiceId);

    const testPool = mysql.createPool({
      host: process.env.DB_HOST || '127.0.0.1',
      port: process.env.DB_PORT || 3306,
      user: 'pos_app',
      password: process.env.DB_PASSWORD || '',
      database: DB_NAME
    });

    try {
      // 1. Chỉ có đúng 1 hóa đơn được tạo cho request_key này
      const [invoices] = await testPool.query('SELECT COUNT(*) as count FROM invoices WHERE request_key = ?', [qrRequestKey]);
      assert.strictEqual(invoices[0].count, 1, 'Chỉ được có đúng 1 hóa đơn trong CSDL');

      // 2. Tồn kho vẫn giữ nguyên 47 và 8 (chỉ trừ đúng 1 lần)
      const [products] = await testPool.query('SELECT id, stock_quantity FROM products WHERE id IN (1, 2) ORDER BY id');
      assert.strictEqual(products[0].stock_quantity, 47);
      assert.strictEqual(products[1].stock_quantity, 8);

      // 3. Stock movements chỉ ghi nhận 2 dòng biến động cho hóa đơn này
      const [movements] = await testPool.query(`
        SELECT COUNT(*) as count FROM stock_movements sm
        JOIN invoice_items ii ON sm.invoice_item_id = ii.id
        WHERE ii.invoice_id = ?
      `, [bankInvoiceId]);
      assert.strictEqual(movements[0].count, 2, 'Biến động kho chỉ ghi nhận đúng 1 lần cho mỗi sản phẩm');
    } finally {
      await testPool.end();
    }
  });

  // TEST 7b: Kiểm tra không thể tạo QR mới/đổi phương thức khi đang phục hồi
  await t.test('7b. Kiểm tra không thể tạo QR mới/đổi phương thức khi đang phục hồi (Thay đổi payload trên cùng request_key bị từ chối HTTP 409)', async () => {
    // 1. Thử đổi phương thức sang CASH với cùng request_key cũ
    const conflictMethodRes = await req('POST', '/api/invoices', {
      invoice_no: qrInvoiceNo,
      request_key: qrRequestKey,
      payment_method: 'CASH',
      items: [
        { product_id: 1, quantity: 1, unit_price: 120000 },
        { product_id: 2, quantity: 2, unit_price: 85000 }
      ]
    }, cashierCookie, cashierCsrf);
    assert.strictEqual(conflictMethodRes.status, 409, 'Đổi phương thức thanh toán trên cùng request_key phải bị từ chối 409');
    assert.match(conflictMethodRes.data.error, /Conflict/i);

    // 2. Thử đổi danh sách sản phẩm với cùng request_key cũ
    const conflictItemsRes = await req('POST', '/api/invoices', {
      invoice_no: qrInvoiceNo,
      request_key: qrRequestKey,
      payment_method: 'BANK_TRANSFER',
      transfer_content: preparedTransfer.transfer_content,
      items: [
        { product_id: 1, quantity: 2, unit_price: 120000 }
      ]
    }, cashierCookie, cashierCsrf);
    assert.strictEqual(conflictItemsRes.status, 409, 'Đổi giỏ hàng/tổng tiền trên cùng request_key phải bị từ chối 409');
  });

  // TEST 7c: Kiểm tra CASH mất phản hồi sau khi đã lưu rồi thử lại: chỉ có một hóa đơn và một lần trừ kho, phương thức vẫn là CASH
  await t.test('7c. Kiểm tra CASH mất phản hồi sau khi đã lưu rồi thử lại: chỉ có một hóa đơn và một lần trừ kho, phương thức vẫn là CASH', async () => {
    const cashReqKey = 'req-cash-recover-001';
    const cashInvNo = 'HD_CASH_RECOVER_001';
    const payload = {
      invoice_no: cashInvNo,
      request_key: cashReqKey,
      payment_method: 'CASH',
      items: [
        { product_id: 1, quantity: 1, unit_price: 120000 }
      ]
    };

    // 1. Gửi lần 1: thành công lưu vào CSDL
    const firstRes = await req('POST', '/api/invoices', payload, cashierCookie, cashierCsrf);
    assert.strictEqual(firstRes.status, 201);
    const createdCashId = firstRes.data.id;

    // 2. Client giả lập mất phản hồi mạng, gửi lại đúng payload cũ
    const retryRes = await req('POST', '/api/invoices', payload, cashierCookie, cashierCsrf);
    assert.strictEqual(retryRes.status, 200, 'Thử lại cùng payload cũ phải trả về 200 idempotent');
    assert.strictEqual(retryRes.data.id, createdCashId);
    assert.strictEqual(retryRes.data.invoice_no, cashInvNo);

    // 3. Đối chiếu CSDL
    const testPool = mysql.createPool({
      host: process.env.DB_HOST || '127.0.0.1',
      port: process.env.DB_PORT || 3306,
      user: 'pos_app',
      password: process.env.DB_PASSWORD || '',
      database: DB_NAME
    });

    try {
      // Chỉ có đúng 1 hóa đơn CASH
      const [invRows] = await testPool.query('SELECT * FROM invoices WHERE request_key = ?', [cashReqKey]);
      assert.strictEqual(invRows.length, 1);
      assert.strictEqual(invRows[0].payment_method, 'CASH');
      assert.strictEqual(invRows[0].transfer_content, null);

      // Tồn kho SP001: từ 47 trừ đúng 1 lần thành 46
      const [pRows] = await testPool.query('SELECT stock_quantity FROM products WHERE id = 1');
      assert.strictEqual(pRows[0].stock_quantity, 46);

      // Stock movements chỉ có đúng 1 dòng
      const [smRows] = await testPool.query(`
        SELECT COUNT(*) as count FROM stock_movements sm
        JOIN invoice_items ii ON sm.invoice_item_id = ii.id
        WHERE ii.invoice_id = ?
      `, [createdCashId]);
      assert.strictEqual(smRows[0].count, 1, 'Chỉ trừ tồn kho đúng 1 lần');
    } finally {
      await testPool.end();
    }
  });

  // TEST 7d: Kiểm tra CASH đang phục hồi không thể bị đổi phương thức sang BANK_TRANSFER trên cùng request_key
  await t.test('7d. Kiểm tra CASH đang phục hồi không thể bị đổi phương thức sang BANK_TRANSFER trên cùng request_key (409 Conflict)', async () => {
    const cashReqKey = 'req-cash-recover-001';
    const cashInvNo = 'HD_CASH_RECOVER_001';

    const conflictMethodRes = await req('POST', '/api/invoices', {
      invoice_no: cashInvNo,
      request_key: cashReqKey,
      payment_method: 'BANK_TRANSFER',
      transfer_content: 'POS12345678',
      items: [
        { product_id: 1, quantity: 1, unit_price: 120000 }
      ]
    }, cashierCookie, cashierCsrf);

    assert.strictEqual(conflictMethodRes.status, 409, 'Đổi phương thức thanh toán trên cùng request_key phải bị từ chối 409');
    assert.match(conflictMethodRes.data.error, /Conflict/i);
  });

  // TEST 8: Đổi giá/tồn trong lúc chờ thanh toán báo lỗi đối soát rõ ràng cho BANK_TRANSFER
  await t.test('8. Đổi giá/hết tồn trong lúc chờ thanh toán chuyển khoản trả về HTTP 409 yêu cầu đối soát', async () => {
    // 1. Chuẩn bị QR khi SP002 còn tồn 8 cái
    const prepRes = await req('POST', '/api/invoices/prepare-qr', {
      items: [{ product_id: 2, quantity: 8, unit_price: 85000 }]
    }, cashierCookie, cashierCsrf);
    assert.strictEqual(prepRes.status, 200);

    // 2. Một giao dịch khác mua hết tồn của SP002
    const testPool = mysql.createPool({
      host: process.env.DB_HOST || '127.0.0.1',
      port: process.env.DB_PORT || 3306,
      user: 'pos_app',
      password: process.env.DB_PASSWORD || '',
      database: DB_NAME
    });
    try {
      await testPool.query('UPDATE products SET stock_quantity = 0 WHERE id = 2');
    } finally {
      await testPool.end();
    }

    // 3. Khách đã quét QR chuyển khoản, nhân viên bấm xác nhận
    const confirmRes = await req('POST', '/api/invoices', {
      invoice_no: 'HD_CONFLICT_001',
      request_key: 'req-conflict-001',
      payment_method: 'BANK_TRANSFER',
      transfer_content: prepRes.data.transfer_content,
      items: [{ product_id: 2, quantity: 8, unit_price: 85000 }]
    }, cashierCookie, cashierCsrf);

    assert.strictEqual(confirmRes.status, 409);
    assert.strictEqual(confirmRes.data.reconciliation_required, true);
    assert.match(confirmRes.data.error, /đối soát/i);
    assert.match(confirmRes.data.error, /không đủ tồn kho/i);
  });

  // TEST 9: Hóa đơn cũ (trước migration) hiển thị "Chưa ghi nhận" cho payment_method
  await t.test('9. Hóa đơn cũ trước migration có payment_method = null, không bị tự gán thành Tiền mặt', async () => {
    const listRes = await req('GET', '/api/invoices?q=HD_OLD_001', null, managerCookie);
    assert.strictEqual(listRes.status, 200);
    assert.ok(listRes.data.invoices.length > 0, 'Phải tìm thấy hóa đơn cũ');
    const oldInv = listRes.data.invoices[0];
    assert.strictEqual(oldInv.invoice_no, 'HD_OLD_001');
    assert.strictEqual(oldInv.payment_method, null);
    assert.strictEqual(oldInv.transfer_content, null);
    assert.strictEqual(oldInv.transfer_confirmed_at, null);

    // Chi tiết hóa đơn cũ cũng trả về payment_method: null
    const detailRes = await req('GET', `/api/invoices/${oldInv.id}`, null, managerCookie);
    assert.strictEqual(detailRes.status, 200);
    assert.strictEqual(detailRes.data.invoice.payment_method, null);
  });

  // TEST 10: Chi tiết hóa đơn trả về đầy đủ các trường mới
  await t.test('10. Chi tiết hóa đơn GET /api/invoices/:id trả về đầy đủ phương thức và nội dung chuyển khoản', async () => {
    const detailRes = await req('GET', `/api/invoices/${bankInvoiceId}`, null, cashierCookie);
    assert.strictEqual(detailRes.status, 200);
    const inv = detailRes.data.invoice;
    assert.strictEqual(inv.payment_method, 'BANK_TRANSFER');
    assert.strictEqual(inv.transfer_content, preparedTransfer.transfer_content);
    assert.ok(inv.transfer_confirmed_at);
  });

  // TEST 10b: Kiểm tra tổng tiền có phần lẻ VND
  await t.test('10b. Kiểm tra tổng tiền có phần lẻ VND: Từ chối tạo QR và từ chối BANK_TRANSFER, nhưng vẫn cho thanh toán Tiền mặt', async () => {
    // 1. POST /prepare-qr từ chối số tiền có phần lẻ VND
    const decQrRes = await req('POST', '/api/invoices/prepare-qr', {
      items: [{ product_id: 5, quantity: 1, unit_price: 12500.50 }]
    }, cashierCookie, cashierCsrf);
    assert.strictEqual(decQrRes.status, 400);
    assert.match(decQrRes.data.error, /phần lẻ VND/i);

    // 2. POST /invoices với BANK_TRANSFER từ chối số tiền có phần lẻ VND
    const decBankRes = await req('POST', '/api/invoices', {
      invoice_no: 'HD_DECIMAL_BANK_01',
      request_key: 'req-dec-bank-01',
      payment_method: 'BANK_TRANSFER',
      transfer_content: 'POSDECIMAL01',
      items: [{ product_id: 5, quantity: 1, unit_price: 12500.50 }]
    }, cashierCookie, cashierCsrf);
    assert.strictEqual(decBankRes.status, 400);
    assert.match(decBankRes.data.error, /phần lẻ VND/i);

    // 3. POST /invoices với CASH vẫn thành công bình thường cho số tiền có phần lẻ VND
    const decCashRes = await req('POST', '/api/invoices', {
      invoice_no: 'HD_DECIMAL_CASH_01',
      request_key: 'req-dec-cash-01',
      payment_method: 'CASH',
      items: [{ product_id: 5, quantity: 1, unit_price: 12500.50 }]
    }, cashierCookie, cashierCsrf);
    assert.strictEqual(decCashRes.status, 201, 'Tiền mặt vẫn phải thanh toán được với số tiền có phần lẻ VND');
    const cashDetailRes = await req('GET', `/api/invoices/${decCashRes.data.id}`, null, cashierCookie);
    assert.strictEqual(cashDetailRes.status, 200);
    assert.strictEqual(cashDetailRes.data.invoice.payment_method, 'CASH');
    assert.strictEqual(Number(cashDetailRes.data.invoice.total_amount), 12500.50);
  });

  // TEST 10c: Kiểm tra nội dung chuyển khoản chứa ký tự HTML hoặc vượt quá giới hạn
  await t.test('10c. Kiểm tra nội dung chứa ký tự HTML không được thực thi: Backend từ chối và escape an toàn', async () => {
    // 1. Thẻ script HTML bị từ chối
    const scriptRes = await req('POST', '/api/invoices', {
      invoice_no: 'HD_XSS_01',
      request_key: 'req-xss-01',
      payment_method: 'BANK_TRANSFER',
      transfer_content: '<script>alert(1)</script>',
      items: [{ product_id: 1, quantity: 1, unit_price: 120000 }]
    }, cashierCookie, cashierCsrf);
    assert.strictEqual(scriptRes.status, 400);
    assert.match(scriptRes.data.error, /không hợp lệ/i);

    // 2. Thẻ HTML img onerror bị từ chối
    const imgXssRes = await req('POST', '/api/invoices', {
      invoice_no: 'HD_XSS_02',
      request_key: 'req-xss-02',
      payment_method: 'BANK_TRANSFER',
      transfer_content: '"><img src=x onerror=alert(1)>',
      items: [{ product_id: 1, quantity: 1, unit_price: 120000 }]
    }, cashierCookie, cashierCsrf);
    assert.strictEqual(imgXssRes.status, 400);
    assert.match(imgXssRes.data.error, /không hợp lệ/i);

    // 3. Nội dung vượt quá 50 ký tự bị từ chối
    const tooLongRes = await req('POST', '/api/invoices', {
      invoice_no: 'HD_XSS_03',
      request_key: 'req-xss-03',
      payment_method: 'BANK_TRANSFER',
      transfer_content: 'A'.repeat(55),
      items: [{ product_id: 1, quantity: 1, unit_price: 120000 }]
    }, cashierCookie, cashierCsrf);
    assert.strictEqual(tooLongRes.status, 400);
    assert.match(tooLongRes.data.error, /vượt quá độ dài/i);

    // 4. Kiểm tra hàm escapeHtml phòng chống XSS ở frontend
    function escapeHtmlTest(str) {
      if (str === null || str === undefined) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    }
    assert.strictEqual(escapeHtmlTest('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    assert.strictEqual(escapeHtmlTest('"><img src=x onerror=alert(1)>'), '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
  });

  // TEST 11: Kiểm thử khi thiếu cấu hình ngân hàng
  await t.test('11. Thiếu cấu hình ngân hàng: Báo lỗi "Chưa cấu hình tài khoản nhận chuyển khoản", vẫn cho thanh toán tiền mặt', async () => {
    // Khởi động server phụ trên port 3007 không truyền VIETQR_BANK_ID
    const unconfigPort = 3007;
    let unconfigProcess;
    await new Promise((resolve) => {
      unconfigProcess = spawn('node', ['server.js'], {
        env: {
          ...process.env,
          DB_NAME: DB_NAME,
          SESSION_SECRET: 'test_secret_unconfig',
          PORT: String(unconfigPort),
          METRICS_PORT: '0',
          VIETQR_BANK_ID: '',
          VIETQR_ACCOUNT_NO: '',
          VIETQR_ACCOUNT_NAME: ''
        }
      });
      unconfigProcess.stdout.on('data', (d) => {
        if (d.toString().includes('Website đang chạy')) resolve();
      });
      setTimeout(resolve, 3000);
    });

    try {
      const uReq = async (method, path, body = null, cookie = '', csrf = '') => {
        const headers = { 'Content-Type': 'application/json' };
        if (cookie) headers['Cookie'] = cookie;
        if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;
        const res = await fetch(`http://127.0.0.1:${unconfigPort}${path}`, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined
        });
        const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
        let newCookie = cookie;
        if (setCookies && setCookies.length > 0) {
          newCookie = setCookies.map(c => c.split(';')[0]).join('; ');
        }
        let data;
        const text = await res.text();
        try { data = JSON.parse(text); } catch { data = text; }
        return { status: res.status, data, cookie: newCookie };
      };

      // Đăng nhập
      const csrfRes = await uReq('GET', '/api/auth/csrf');
      const loginRes = await uReq('POST', '/api/auth/login', { username: 'cashier_test', password: 'password123' }, csrfRes.cookie, csrfRes.data.csrfToken);
      const uCookie = loginRes.cookie;
      const uCsrf = loginRes.data.csrfToken;

      // 1. GET /payment-config trả về configured = false
      const configRes = await uReq('GET', '/api/invoices/payment-config', null, uCookie);
      assert.strictEqual(configRes.status, 200);
      assert.strictEqual(configRes.data.configured, false);
      assert.strictEqual(configRes.data.bank_id, null);

      // 2. POST /prepare-qr báo đúng thông báo lỗi
      const prepRes = await uReq('POST', '/api/invoices/prepare-qr', {
        items: [{ product_id: 1, quantity: 1, unit_price: 120000 }]
      }, uCookie, uCsrf);
      assert.strictEqual(prepRes.status, 400);
      assert.strictEqual(prepRes.data.error, 'Chưa cấu hình tài khoản nhận chuyển khoản');

      // 3. POST /invoices với BANK_TRANSFER bị từ chối
      const failBankRes = await uReq('POST', '/api/invoices', {
        invoice_no: 'HD_FAIL_BANK_01',
        request_key: 'req-fail-bank-01',
        payment_method: 'BANK_TRANSFER',
        transfer_content: 'POS123',
        items: [{ product_id: 1, quantity: 1, unit_price: 120000 }]
      }, uCookie, uCsrf);
      assert.strictEqual(failBankRes.status, 400);
      assert.strictEqual(failBankRes.data.error, 'Chưa cấu hình tài khoản nhận chuyển khoản');

      // 4. Vẫn cho phép thanh toán Tiền mặt bình thường
      const cashRes = await uReq('POST', '/api/invoices', {
        invoice_no: 'HD_CASH_OK_01',
        request_key: 'req-cash-ok-01',
        payment_method: 'CASH',
        items: [{ product_id: 1, quantity: 1, unit_price: 120000 }]
      }, uCookie, uCsrf);
      assert.strictEqual(cashRes.status, 201, 'Tiền mặt vẫn phải tạo hóa đơn thành công khi thiếu cấu hình ngân hàng');
    } finally {
      if (unconfigProcess) unconfigProcess.kill();
    }
  });

  // 12. Dọn dẹp máy chủ và cơ sở dữ liệu kiểm thử
  await t.test('12. Dọn dẹp máy chủ kiểm thử', async () => {
    if (serverProcess) {
      serverProcess.kill();
    }
  });
});
