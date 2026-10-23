require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const { spawn } = require('child_process');

const testDbConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'pos_app',
  password: process.env.DB_PASSWORD || '290729',
  database: 'pos_store_test'
};

const BASE_URL = 'http://127.0.0.1:3099';

test('POS Store Integration Tests', async (t) => {
  let serverProcess;

  await t.test('Thiết lập cơ sở dữ liệu kiểm thử & khởi động Server', async () => {
    // 1. Kết nối DB bằng root để tạo DB test
    const rootPool = mysql.createPool({
      host: testDbConfig.host, port: testDbConfig.port,
      user: process.env.ROOT_USER || 'root', 
      password: process.env.ROOT_PASSWORD || process.env.DB_PASSWORD || '',
      multipleStatements: true
    });

    try {
      await rootPool.query('DROP DATABASE IF EXISTS pos_store_test');
      await rootPool.query('CREATE DATABASE pos_store_test');
      await rootPool.query('GRANT ALL PRIVILEGES ON pos_store_test.* TO "pos_app"@"localhost"');
      await rootPool.query('FLUSH PRIVILEGES');

      // Chạy schema thủ công cho test db
      const schemaSql = require('fs').readFileSync('database/schema.sql', 'utf-8').replace(/\bpos_store\b/g, 'pos_store_test');
      const sessionSql = require('fs').readFileSync('database/migration_01_sessions.sql', 'utf-8').replace(/\bpos_store\b/g, 'pos_store_test');
      const mig02Sql = require('fs').readFileSync('database/migration_02_payment_methods.sql', 'utf-8').replace(/\bpos_store\b/g, 'pos_store_test');

      const parts = [...schemaSql.split(';'), ...sessionSql.split(';'), ...mig02Sql.split(';')].map(s => s.trim()).filter(s => s.length > 0);
      const conn = await rootPool.getConnection();
      try {
        await conn.query('USE pos_store_test');
        for (const sql of parts) {
          if (!sql.toUpperCase().startsWith('DELIMITER')) {
            await conn.query(sql);
          }
        }
        // Tạo user manager
        const bcrypt = require('bcryptjs');
        const hash = await bcrypt.hash('password123', 10);
        await conn.query('INSERT IGNORE INTO users (username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?)',
          ['manager', hash, 'Manager Test', 'MANAGER', 1]);
        await conn.query('INSERT IGNORE INTO users (username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?)',
          ['cashier1', hash, 'Cashier Test', 'CASHIER', 1]);
      } finally {
        conn.release();
      }
    } catch (err) {
      console.error('Lỗi thiết lập cơ sở dữ liệu kiểm thử:', err.message);
      throw err;
    } finally {
      await rootPool.end();
    }

    // 2. Khởi động server với env DB_NAME=pos_store_test
    return new Promise((resolve) => {
      serverProcess = spawn('node', ['server.js'], {
        env: { ...process.env, DB_NAME: 'pos_store_test', SESSION_SECRET: 'test_secret', PORT: '3099', METRICS_PORT: '0' }
      });
      serverProcess.stdout.on('data', (data) => {
        console.log('[Server 3099]:', data.toString());
        if (data.toString().includes('Website đang chạy')) {
          resolve();
        }
      });
      serverProcess.stderr.on('data', (data) => {
        console.error('[Server 3001 Err]:', data.toString());
      });
      setTimeout(resolve, 3000); // Wait for server to start
    });
  });

  let managerCookie = '';
  let managerCsrf = '';

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

  await t.test('Đăng nhập Manager và test CSRF lifecycle', async () => {
    // 1. Get initial CSRF Token
    let res = await req('GET', '/api/auth/csrf');
    assert.strictEqual(res.status, 200, 'Khởi tạo CSRF thất bại');
    let initialCsrf = res.data.csrfToken;
    let initialCookie = res.cookie;

    // 2. Login
    res = await req('POST', '/api/auth/login', { username: 'manager', password: 'password123' }, initialCookie, initialCsrf);
    assert.strictEqual(res.status, 200, 'Login thất bại');

    // 3. Update cookie & token sau login (do regenerate)
    managerCookie = res.cookie;
    managerCsrf = res.data.csrfToken; // CSRF trả về sau login
    assert.ok(managerCsrf !== initialCsrf, 'CSRF phải đổi sau khi login');
  });

  await t.test('Tạo, sửa, xóa sản phẩm & kiểm tra dữ liệu, sai quyền', async () => {
    // Tạo sản phẩm TEST01 cố định cho các bài test giao dịch tiếp theo
    await req('POST', '/api/products', { sku: 'TEST01', name: 'Test', unit: 'Cái', sale_price: 15000.50 }, managerCookie, managerCsrf);

    // Tạo sản phẩm thử nghiệm để test sửa và xóa
    const testSku = 'TEST_DEL_' + Date.now();
    const res = await req('POST', '/api/products', { sku: testSku, name: 'Sản phẩm Test', unit: 'Cái', sale_price: 15000.50 }, managerCookie, managerCsrf);
    assert.strictEqual(res.status, 201, 'Tạo sản phẩm thất bại');
    const createdId = res.data.id;

    // Kiểm tra dữ liệu từ CSDL
    const getRes = await req('GET', `/api/products/${createdId}`, null, managerCookie);
    assert.strictEqual(getRes.status, 200);
    assert.strictEqual(getRes.data.sku, testSku);
    assert.strictEqual(getRes.data.name, 'Sản phẩm Test');
    assert.strictEqual(getRes.data.unit, 'Cái');
    assert.strictEqual(Number(getRes.data.sale_price), 15000.50);

    // Validate giá bán & SKU không được rỗng
    const badPriceRes = await req('PUT', `/api/products/${createdId}`, { sku: testSku, name: 'Sản phẩm Test', unit: 'Cái', sale_price: -500 }, managerCookie, managerCsrf);
    assert.strictEqual(badPriceRes.status, 400, 'Phải chặn giá bán <= 0');

    const emptySkuRes = await req('PUT', `/api/products/${createdId}`, { sku: '   ', name: 'Sản phẩm Test', unit: 'Cái', sale_price: 20000 }, managerCookie, managerCsrf);
    assert.strictEqual(emptySkuRes.status, 400, 'Không được để trống SKU');

    // Tạo thêm sản phẩm 2 để kiểm tra chống trùng SKU khi sửa
    const otherSku = 'OTHER_' + Date.now();
    await req('POST', '/api/products', { sku: otherSku, name: 'Sản phẩm Khác', unit: 'Cái', sale_price: 30000 }, managerCookie, managerCsrf);

    const dupSkuRes = await req('PUT', `/api/products/${createdId}`, { sku: otherSku, name: 'Sản phẩm Test', unit: 'Cái', sale_price: 20000 }, managerCookie, managerCsrf);
    assert.strictEqual(dupSkuRes.status, 400, 'Phải chặn SKU trùng lặp với sản phẩm khác');

    // Sửa hợp lệ bao gồm đổi SKU
    const newSku = testSku + '_UPDATED';
    const editRes = await req('PUT', `/api/products/${createdId}`, { sku: newSku, name: 'Sản phẩm Test Đã Sửa', unit: 'Hộp', sale_price: 25000 }, managerCookie, managerCsrf);
    assert.strictEqual(editRes.status, 200, 'Sửa sản phẩm thất bại');

    const getRes2 = await req('GET', `/api/products/${createdId}`, null, managerCookie);
    assert.strictEqual(getRes2.data.id, createdId, 'ID sản phẩm phải giữ nguyên');
    assert.strictEqual(getRes2.data.sku, newSku, 'SKU mới phải được cập nhật');
    assert.strictEqual(getRes2.data.name, 'Sản phẩm Test Đã Sửa');
    assert.strictEqual(getRes2.data.unit, 'Hộp');
    assert.strictEqual(Number(getRes2.data.sale_price), 25000);

    // Cashier không được tạo hoặc xóa
    let cRes = await req('GET', '/api/auth/csrf');
    let lRes = await req('POST', '/api/auth/login', { username: 'cashier1', password: 'password123' }, cRes.cookie, cRes.data.csrfToken);

    let cashierCookie = lRes.cookie;
    let cashierCsrf = lRes.data.csrfToken;

    let pRes = await req('POST', '/api/products', { sku: 'TEST02', name: 'Test', unit: 'Cái', sale_price: 15000 }, cashierCookie, cashierCsrf);
    assert.strictEqual(pRes.status, 403, 'Cashier không được phép tạo sản phẩm');

    let delCashierRes = await req('DELETE', `/api/products/${createdId}`, null, cashierCookie, cashierCsrf);
    assert.strictEqual(delCashierRes.status, 403, 'Cashier không được phép xóa sản phẩm');

    // Xóa sản phẩm chưa có giao dịch bằng Manager
    const delRes = await req('DELETE', `/api/products/${createdId}`, null, managerCookie, managerCsrf);
    assert.strictEqual(delRes.status, 200, 'Xóa sản phẩm chưa có giao dịch thất bại');

    // Kiểm tra sau khi xóa không còn trong CSDL
    const getRes3 = await req('GET', `/api/products/${createdId}`, null, managerCookie);
    assert.strictEqual(getRes3.status, 404, 'Sản phẩm chưa bị xóa');
  });


  await t.test('Tài khoản bị khóa giữa chừng', async () => {
    // Lấy cookie cashier
    let cRes = await req('GET', '/api/auth/csrf');
    let lRes = await req('POST', '/api/auth/login', { username: 'cashier1', password: 'password123' }, cRes.cookie, cRes.data.csrfToken);
    let cashierCookie = lRes.cookie;
    
    // Test access before lock
    let meRes1 = await req('GET', '/api/auth/me', null, cashierCookie);
    assert.strictEqual(meRes1.status, 200);

    const pool = mysql.createPool(testDbConfig);
    await pool.query('UPDATE users SET is_active = 0 WHERE username = ?', ['cashier1']);

    // Test access after lock with old session
    let meRes2 = await req('GET', '/api/auth/me', null, cashierCookie);
    assert.strictEqual(meRes2.status, 401, 'Phiên làm việc cũ phải bị vô hiệu hóa khi tài khoản bị khóa');

    // Lấy lại token thử xem request có bị chặn không
    cRes = await req('GET', '/api/auth/csrf');
    lRes = await req('POST', '/api/auth/login', { username: 'cashier1', password: 'password123' }, cRes.cookie, cRes.data.csrfToken);
    assert.strictEqual(lRes.status, 401, 'Tài khoản khóa không được login');

    await pool.query('UPDATE users SET is_active = 1 WHERE username = ?', ['cashier1']);
    await pool.end();
  });

  await t.test('Số lượng lẻ & decimal (Idempotency, sai kiểu)', async () => {
    const reqKey = Date.now().toString();
    const payloadInvalid = {
      receipt_no: 'NH002', request_key: reqKey,
      items: [{ product_id: 1, quantity: 1.5, unit_cost: 100 }] // số lẻ
    };
    let res = await req('POST', '/api/stock-receipts', payloadInvalid, managerCookie, managerCsrf);
    assert.strictEqual(res.status, 400, 'Chưa chặn số lượng lẻ');

    const payloadValid = {
      receipt_no: 'NH003', request_key: reqKey,
      items: [{ product_id: 1, quantity: 10, unit_cost: 100.55 }]
    };
    res = await req('POST', '/api/stock-receipts', payloadValid, managerCookie, managerCsrf);
    assert.ok(res.status === 201 || res.status === 400, 'Tạo phiếu nhập thất bại');

    // Idempotency: Gửi trùng
    let res2 = await req('POST', '/api/stock-receipts', payloadValid, managerCookie, managerCsrf);
    assert.strictEqual(res2.status, 200, 'Chưa xử lý Idempotency trả về 200');

    // Khác hash
    const payloadConflict = {
      receipt_no: 'NH003', request_key: reqKey,
      items: [{ product_id: 1, quantity: 5, unit_cost: 100.55 }] // đổi quantity
    };
    let res3 = await req('POST', '/api/stock-receipts', payloadConflict, managerCookie, managerCsrf);
    assert.strictEqual(res3.status, 409, 'Chưa báo lỗi Conflict khi sai hash');
  });

  await t.test('Validation: items phải là object', async () => {
    const reqKey = Date.now().toString();
    const payloadReceipt = {
      receipt_no: 'NH_ERR_1', request_key: reqKey,
      items: [null, [1, 2], "string"]
    };
    let res = await req('POST', '/api/stock-receipts', payloadReceipt, managerCookie, managerCsrf);
    assert.strictEqual(res.status, 400, 'Không báo lỗi 400 cho items mảng/null trong receipt');

    const payloadInvoice = {
      invoice_no: 'HD_ERR_1', request_key: reqKey,
      items: [{ product_id: 1, quantity: 1, unit_price: 15000 }, null]
    };
    res = await req('POST', '/api/invoices', payloadInvoice, managerCookie, managerCsrf);
    assert.strictEqual(res.status, 400, 'Không báo lỗi 400 cho items mảng/null trong invoice');
  });

  await t.test('Bán hàng đồng thời, Giá thay đổi & Tổng tiền', async () => {
    // Cập nhật giá sản phẩm 1
    await req('PUT', '/api/products/1', { sku: 'TEST01', name: 'Test', unit: 'Cái', sale_price: 20000 }, managerCookie, managerCsrf);

    const reqKey = Date.now().toString();
    const payload = {
      invoice_no: 'HD001', request_key: reqKey,
      items: [{ product_id: 1, quantity: 1, unit_price: 15000.50 }] // Giá cũ
    };
    let res = await req('POST', '/api/invoices', payload, managerCookie, managerCsrf);
    assert.strictEqual(res.status, 409, 'Chưa bắt lỗi giá thay đổi');
    assert.ok(res.data.requires_confirmation, 'Thiếu cờ xác nhận giá');

    // 2. Nhập kho 10 cái (để có đủ hàng bán)
    const reqKey2 = Date.now().toString() + 'in';
    let resIn = await req('POST', '/api/stock-receipts', {
        receipt_no: 'NH_TEST1', request_key: reqKey2,
        items: [{ product_id: 1, quantity: 10, unit_cost: 10000 }]
    }, managerCookie, managerCsrf);
    assert.ok(resIn.status === 201 || resIn.status === 200, 'Nhập hàng thất bại');

    // 3. Bán hàng đồng thời (gửi 2 request song song bán 11 cái, tổng 22 > 20, xem có chặn ko)
    const payload1 = {
      invoice_no: 'HD_CONC_1', request_key: 'conc1_' + Date.now(),
      items: [{ product_id: 1, quantity: 11, unit_price: 20000 }]
    };
    const payload2 = {
      invoice_no: 'HD_CONC_2', request_key: 'conc2_' + Date.now(),
      items: [{ product_id: 1, quantity: 11, unit_price: 20000 }]
    };

    const [res1, res2] = await Promise.all([
      req('POST', '/api/invoices', payload1, managerCookie, managerCsrf),
      req('POST', '/api/invoices', payload2, managerCookie, managerCsrf)
    ]);

    // Một thành công, một thất bại do thiếu tồn kho
    const statuses = [res1.status, res2.status];
    assert.ok(statuses.includes(201) && statuses.includes(400), 'Concurrent test failed, statuses: ' + statuses.join(', '));
    
    // Kiểm tra tổng tiền của hóa đơn thành công
    const successRes = res1.status === 201 ? res1 : res2;
    const invId = successRes.data.id;
    const detailRes = await req('GET', '/api/invoices/' + invId, null, managerCookie);
    assert.strictEqual(Number(detailRes.data.invoice.total_amount), 220000, 'Tổng tiền chưa đúng');
  });

  await t.test('Hóa đơn của thu ngân khác & Phân quyền xem chi tiết', async () => {
    // Tạo hóa đơn bằng manager
    const reqKey = Date.now().toString();
    const createInvRes = await req('POST', '/api/invoices', {
      invoice_no: 'HD_MGR_' + reqKey, request_key: reqKey,
      items: [{ product_id: 1, quantity: 1, unit_price: 20000 }] // Giá mới
    }, managerCookie, managerCsrf);
    const createdInvId = createInvRes.data.id;

    // Login cashier
    let cRes = await req('GET', '/api/auth/csrf');
    let lRes = await req('POST', '/api/auth/login', { username: 'cashier1', password: 'password123' }, cRes.cookie, cRes.data.csrfToken);

    // Check danh sách hóa đơn (cashier không thấy hóa đơn manager)
    let inv = await req('GET', '/api/invoices', null, lRes.cookie);
    assert.ok(inv.data.length === 0, 'Cashier không được xem hóa đơn người khác');

    // Check chi tiết hóa đơn của Manager bằng tài khoản Cashier (phải trả về 404)
    let detailByCashier = await req('GET', '/api/invoices/' + createdInvId, null, lRes.cookie);
    assert.strictEqual(detailByCashier.status, 404, 'Cashier không được xem chi tiết hóa đơn người khác');

    // Check chi tiết hóa đơn bằng Manager (200, đầy đủ trường thông tin)
    let detailByMgr = await req('GET', '/api/invoices/' + createdInvId, null, managerCookie);
    assert.strictEqual(detailByMgr.status, 200, 'Manager xem chi tiết hóa đơn thành công');
    assert.ok(detailByMgr.data.invoice.invoice_no, 'Phải có mã hóa đơn');
    assert.ok(detailByMgr.data.invoice.created_by_name, 'Phải có người bán');
    assert.ok(detailByMgr.data.invoice.created_at, 'Phải có ngày lập');
    assert.ok(detailByMgr.data.items && detailByMgr.data.items.length > 0, 'Phải có danh sách sản phẩm');
    assert.ok(detailByMgr.data.items[0].unit_snapshot, 'Phải có đơn vị tính');
    assert.ok(detailByMgr.data.items[0].product_name_snapshot, 'Phải có tên sản phẩm');
  });

  await t.test('Từ chối xóa sản phẩm đã có giao dịch', async () => {
    // Thử xóa sản phẩm 1 đã có giao dịch
    const delTxRes = await req('DELETE', '/api/products/1', null, managerCookie, managerCsrf);
    assert.strictEqual(delTxRes.status, 400, 'Phải từ chối xóa sản phẩm đã có giao dịch');
    assert.strictEqual(delTxRes.data.error, 'Sản phẩm đã có lịch sử giao dịch. Vui lòng dùng chức năng Khóa.');
  });

  await t.test('Dọn dẹp', async () => {
    if (serverProcess) {
      serverProcess.kill();
    }
  });

});
