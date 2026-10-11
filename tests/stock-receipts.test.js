require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert');
const mysql = require('mysql2/promise');
const { spawn } = require('child_process');

const testDbConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'pos_app',
  password: process.env.DB_PASSWORD || '290729',
  database: 'pos_store_receipts_test'
};

const BASE_URL = 'http://127.0.0.1:3003';

test('Stock Receipts Comprehensive Tests', async (t) => {
  let serverProcess;

  await t.test('1. Chuẩn bị CSDL kiểm thử độc lập và khởi động Server cổng 3003', async () => {
    const rootPool = mysql.createPool({
      host: testDbConfig.host,
      port: testDbConfig.port,
      user: process.env.ROOT_USER || 'root',
      password: process.env.ROOT_PASSWORD || process.env.DB_PASSWORD || '',
      multipleStatements: true
    });

    try {
      await rootPool.query('DROP DATABASE IF EXISTS pos_store_receipts_test');
      await rootPool.query('CREATE DATABASE pos_store_receipts_test');
      await rootPool.query('GRANT ALL PRIVILEGES ON pos_store_receipts_test.* TO "pos_app"@"localhost"');
      await rootPool.query('FLUSH PRIVILEGES');

      const schemaSql = require('fs').readFileSync('database/schema.sql', 'utf-8').replace(/\bpos_store\b/g, 'pos_store_receipts_test');
      const sessionSql = require('fs').readFileSync('database/migration_01_sessions.sql', 'utf-8').replace(/\bpos_store\b/g, 'pos_store_receipts_test');

      const parts = [...schemaSql.split(';'), ...sessionSql.split(';')].map(s => s.trim()).filter(s => s.length > 0);
      const conn = await rootPool.getConnection();
      try {
        await conn.query('USE pos_store_receipts_test');
        for (const sql of parts) {
          if (!sql.toUpperCase().startsWith('DELIMITER')) {
            await conn.query(sql);
          }
        }

        const bcrypt = require('bcryptjs');
        const hash = await bcrypt.hash('password123', 10);
        await conn.query('INSERT IGNORE INTO users (username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?)',
          ['manager_rcpt', hash, 'Manager Receipts', 'MANAGER', 1]);
        await conn.query('INSERT IGNORE INTO users (username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?)',
          ['cashier_rcpt', hash, 'Cashier Receipts', 'CASHIER', 1]);

        // Tạo 3 sản phẩm mẫu đang hoạt động và 1 sản phẩm ngừng kinh doanh
        await conn.query('INSERT INTO products (id, sku, name, unit, sale_price, stock_quantity, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [1, 'SP_R01', 'Sách Giáo Khoa Toán 1', 'Cuốn', 25000, 0, 1]);
        await conn.query('INSERT INTO products (id, sku, name, unit, sale_price, stock_quantity, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [2, 'SP_R02', 'Bút Dạ Quang Vàng', 'Cây', 15000, 5, 1]);
        await conn.query('INSERT INTO products (id, sku, name, unit, sale_price, stock_quantity, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [3, 'SP_R03', 'Hộp Bút Chì Màu 12 Cây', 'Hộp', 45000, 10, 1]);
        await conn.query('INSERT INTO products (id, sku, name, unit, sale_price, stock_quantity, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [4, 'SP_R04_INACTIVE', 'Bút Xóa Kéo Cũ', 'Cây', 20000, 0, 0]);
      } finally {
        conn.release();
      }
    } finally {
      await rootPool.end();
    }

    return new Promise((resolve) => {
      serverProcess = spawn('node', ['server.js'], {
        env: { ...process.env, DB_NAME: 'pos_store_receipts_test', SESSION_SECRET: 'test_rcpt_secret', PORT: '3003' }
      });
      serverProcess.stdout.on('data', (data) => {
        if (data.toString().includes('Website đang chạy')) {
          resolve();
        }
      });
      setTimeout(resolve, 3000);
    });
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

  let managerCookie = '';
  let managerCsrf = '';
  let cashierCookie = '';
  let cashierCsrf = '';

  await t.test('2. Đăng nhập Manager và Cashier', async () => {
    // Manager
    let csrfRes = await req('GET', '/api/auth/csrf');
    let loginRes = await req('POST', '/api/auth/login', { username: 'manager_rcpt', password: 'password123' }, csrfRes.cookie, csrfRes.data.csrfToken);
    assert.strictEqual(loginRes.status, 200);
    managerCookie = loginRes.cookie;
    managerCsrf = loginRes.data.csrfToken;

    // Cashier
    let csrfResC = await req('GET', '/api/auth/csrf');
    let loginResC = await req('POST', '/api/auth/login', { username: 'cashier_rcpt', password: 'password123' }, csrfResC.cookie, csrfResC.data.csrfToken);
    assert.strictEqual(loginResC.status, 200);
    cashierCookie = loginResC.cookie;
    cashierCsrf = loginResC.data.csrfToken;
  });

  await t.test('3. Phân quyền: CASHIER bị từ chối truy cập API nhập hàng (HTTP 403)', async () => {
    // Cashier GET
    let getRes = await req('GET', '/api/stock-receipts', null, cashierCookie);
    assert.strictEqual(getRes.status, 403, 'Cashier không được xem phiếu nhập');

    // Cashier POST
    let postRes = await req('POST', '/api/stock-receipts', {
      receipt_no: 'PN_CASHIER_TRY', request_key: 'k1',
      items: [{ product_id: 1, quantity: 10, unit_cost: 15000 }]
    }, cashierCookie, cashierCsrf);
    assert.strictEqual(postRes.status, 403, 'Cashier không được tạo phiếu nhập');
  });

  await t.test('4. Kiểm thử giỏ nhập trống (bị từ chối HTTP 400)', async () => {
    // items là mảng rỗng
    let resEmpty = await req('POST', '/api/stock-receipts', {
      receipt_no: 'PN_EMPTY_01', request_key: 'k_empty_1',
      items: []
    }, managerCookie, managerCsrf);
    assert.strictEqual(resEmpty.status, 400, 'Phải chặn giỏ nhập trống');

    // items null hoặc thiếu
    let resNull = await req('POST', '/api/stock-receipts', {
      receipt_no: 'PN_EMPTY_02', request_key: 'k_empty_2'
    }, managerCookie, managerCsrf);
    assert.strictEqual(resNull.status, 400, 'Phải chặn khi thiếu items');
  });

  await t.test('5. Kiểm thử dữ liệu sai ở backend (số lượng lẻ, <=0, giá âm, quá 2 số thập phân, SP ngừng KD)', async () => {
    // 5.1. Số lượng lẻ (1.5)
    let resFloat = await req('POST', '/api/stock-receipts', {
      receipt_no: 'PN_ERR_FLOAT', request_key: 'k_err_1',
      items: [{ product_id: 1, quantity: 1.5, unit_cost: 10000 }]
    }, managerCookie, managerCsrf);
    assert.strictEqual(resFloat.status, 400, 'Phải chặn số lượng không nguyên');

    // 5.2. Số lượng bằng 0 hoặc âm
    let resZeroQty = await req('POST', '/api/stock-receipts', {
      receipt_no: 'PN_ERR_ZERO_QTY', request_key: 'k_err_2',
      items: [{ product_id: 1, quantity: 0, unit_cost: 10000 }]
    }, managerCookie, managerCsrf);
    assert.strictEqual(resZeroQty.status, 400, 'Phải chặn số lượng = 0');

    let resNegQty = await req('POST', '/api/stock-receipts', {
      receipt_no: 'PN_ERR_NEG_QTY', request_key: 'k_err_3',
      items: [{ product_id: 1, quantity: -5, unit_cost: 10000 }]
    }, managerCookie, managerCsrf);
    assert.strictEqual(resNegQty.status, 400, 'Phải chặn số lượng âm');

    // 5.3. Giá nhập âm
    let resNegCost = await req('POST', '/api/stock-receipts', {
      receipt_no: 'PN_ERR_NEG_COST', request_key: 'k_err_4',
      items: [{ product_id: 1, quantity: 10, unit_cost: -500 }]
    }, managerCookie, managerCsrf);
    assert.strictEqual(resNegCost.status, 400, 'Phải chặn giá nhập âm');

    // 5.4. Giá nhập quá 2 chữ số thập phân
    let resDecCost = await req('POST', '/api/stock-receipts', {
      receipt_no: 'PN_ERR_DEC_COST', request_key: 'k_err_5',
      items: [{ product_id: 1, quantity: 10, unit_cost: 10000.999 }]
    }, managerCookie, managerCsrf);
    assert.strictEqual(resDecCost.status, 400, 'Phải chặn giá nhập quá 2 chữ số thập phân');

    // 5.5. Sản phẩm không tồn tại
    let resNoProd = await req('POST', '/api/stock-receipts', {
      receipt_no: 'PN_ERR_NO_PROD', request_key: 'k_err_6',
      items: [{ product_id: 999999, quantity: 10, unit_cost: 10000 }]
    }, managerCookie, managerCsrf);
    assert.strictEqual(resNoProd.status, 400, 'Phải chặn sản phẩm không tồn tại');

    // 5.6. Sản phẩm đã ngừng kinh doanh (ID 4)
    let resInactive = await req('POST', '/api/stock-receipts', {
      receipt_no: 'PN_ERR_INACTIVE', request_key: 'k_err_7',
      items: [{ product_id: 4, quantity: 10, unit_cost: 10000 }]
    }, managerCookie, managerCsrf);
    assert.strictEqual(resInactive.status, 400, 'Phải chặn nhập hàng cho sản phẩm ngừng kinh doanh');
    assert.ok(resInactive.data.error.includes('ngừng kinh doanh'));

    // 5.7. Chi tiết sản phẩm không phải object hợp lệ (null, mảng, chuỗi)
    let resBadItem = await req('POST', '/api/stock-receipts', {
      receipt_no: 'PN_ERR_BAD_ITEM', request_key: 'k_err_8',
      items: [null, "chuoi_sai", [1, 2]]
    }, managerCookie, managerCsrf);
    assert.strictEqual(resBadItem.status, 400, 'Phải chặn cấu trúc item không hợp lệ');
  });

  let createdReceiptId = null;

  await t.test('6. Lập phiếu nhập nhiều dòng & backend tự tính đúng tổng tiền', async () => {
    // Phiếu có 3 dòng:
    // Dòng 1: SP1 x 20 cái @ 15,000.50 = 300,010 đ
    // Dòng 2: SP2 x 10 cái @ 8,000 đ    =  80,000 đ
    // Dòng 3: SP3 x 5 cái @ 30,000 đ    = 150,000 đ
    // Tổng cộng kỳ vọng: 530,010 đ
    const reqKey = 'key_multi_' + Date.now();
    const payload = {
      receipt_no: 'PN_MULTI_01',
      request_key: reqKey,
      items: [
        { product_id: 1, quantity: 20, unit_cost: 15000.50 },
        { product_id: 2, quantity: 10, unit_cost: 8000 },
        { product_id: 3, quantity: 5, unit_cost: 30000 }
      ]
    };

    let res = await req('POST', '/api/stock-receipts', payload, managerCookie, managerCsrf);
    assert.strictEqual(res.status, 201, 'Tạo phiếu nhập nhiều dòng thất bại');
    assert.ok(res.data.id, 'Phải trả về ID phiếu nhập vừa tạo');
    createdReceiptId = res.data.id;

    // Kiểm tra chi tiết phiếu và tổng tiền lưu trong CSDL
    let detailRes = await req('GET', `/api/stock-receipts/${createdReceiptId}`, null, managerCookie);
    assert.strictEqual(detailRes.status, 200);
    assert.strictEqual(detailRes.data.receipt.receipt_no, 'PN_MULTI_01');
    assert.strictEqual(Number(detailRes.data.receipt.total_amount), 530010, 'Backend phải tính đúng tổng tiền 530,010 đ');
    assert.strictEqual(detailRes.data.items.length, 3, 'Phiếu phải có đúng 3 dòng chi tiết');

    // Kiểm tra snapshot từng dòng
    const it1 = detailRes.data.items.find(i => i.product_id === 1);
    assert.strictEqual(it1.sku, 'SP_R01');
    assert.strictEqual(it1.product_name_snapshot, 'Sách Giáo Khoa Toán 1');
    assert.strictEqual(it1.unit_snapshot, 'Cuốn');
    assert.strictEqual(Number(it1.quantity), 20);
    assert.strictEqual(Number(it1.unit_cost), 15000.50);
  });

  await t.test('7. Gửi lặp phiếu nhập (Idempotency, hash conflict và trùng receipt_no)', async () => {
    const origKey = 'key_idem_' + Date.now();
    const payloadValid = {
      receipt_no: 'PN_IDEM_01',
      request_key: origKey,
      items: [{ product_id: 1, quantity: 5, unit_cost: 15000 }]
    };

    // Lần 1: Tạo mới thành công (201)
    let res1 = await req('POST', '/api/stock-receipts', payloadValid, managerCookie, managerCsrf);
    assert.strictEqual(res1.status, 201);
    const firstId = res1.data.id;

    // Lấy tồn kho SP1 trước khi gửi lại
    let prodBefore = await req('GET', '/api/products/1', null, managerCookie);
    const stockBefore = prodBefore.data.stock_quantity;

    // Lần 2: Gửi lặp cùng request_key & cùng hash -> Trả về 200 idempotent, KHÔNG TĂNG TỒN LẦN 2
    let res2 = await req('POST', '/api/stock-receipts', payloadValid, managerCookie, managerCsrf);
    assert.strictEqual(res2.status, 200, 'Idempotent request phải trả về 200');
    assert.strictEqual(res2.data.id, firstId, 'Phải trả về ID của phiếu đã tạo');

    let prodAfter = await req('GET', '/api/products/1', null, managerCookie);
    assert.strictEqual(prodAfter.data.stock_quantity, stockBefore, 'Tồn kho không được tăng khi gửi lặp idempotent');

    // Lần 3: Trùng request_key nhưng đổi dữ liệu (khác hash) -> 409 Conflict
    const payloadConflict = {
      receipt_no: 'PN_IDEM_01',
      request_key: origKey,
      items: [{ product_id: 1, quantity: 15, unit_cost: 15000 }] // đổi số lượng
    };
    let resConflict = await req('POST', '/api/stock-receipts', payloadConflict, managerCookie, managerCsrf);
    assert.strictEqual(resConflict.status, 409, 'Phải báo 409 Conflict khi sai hash');

    // Lần 4: Trùng receipt_no nhưng dùng request_key mới -> 400 Bad Request
    const payloadDupNo = {
      receipt_no: 'PN_IDEM_01', // trùng mã phiếu
      request_key: 'new_key_' + Date.now(),
      items: [{ product_id: 1, quantity: 5, unit_cost: 15000 }]
    };
    let resDupNo = await req('POST', '/api/stock-receipts', payloadDupNo, managerCookie, managerCsrf);
    assert.strictEqual(resDupNo.status, 400, 'Phải chặn trùng mã phiếu nhập');
  });

  await t.test('8. Lỗi lưu không làm tăng tồn một phần (Rollback transaction toàn diện)', async () => {
    // SP2 ban đầu có tồn kho
    let sp2Before = await req('GET', '/api/products/2', null, managerCookie);
    const sp2StockInit = sp2Before.data.stock_quantity;

    // Gửi phiếu gồm dòng 1 hợp lệ (SP2) nhưng dòng 2 có lỗi (SP4 ngừng kinh doanh)
    const payloadFail = {
      receipt_no: 'PN_TX_FAIL',
      request_key: 'key_fail_' + Date.now(),
      items: [
        { product_id: 2, quantity: 10, unit_cost: 8000 },
        { product_id: 4, quantity: 5, unit_cost: 20000 } // lỗi do ngừng kinh doanh
      ]
    };

    let failRes = await req('POST', '/api/stock-receipts', payloadFail, managerCookie, managerCsrf);
    assert.strictEqual(failRes.status, 400, 'Phải thất bại toàn bộ transaction');

    // Kiểm tra SP2: Tồn kho KHÔNG ĐƯỢC TĂNG MỘT PHẦN
    let sp2After = await req('GET', '/api/products/2', null, managerCookie);
    assert.strictEqual(sp2After.data.stock_quantity, sp2StockInit, 'Tồn kho không được tăng một phần khi transaction thất bại');
  });

  await t.test('9. Đối chiếu tồn kho và lịch sử stock_movements sau khi nhập hàng', async () => {
    // Đối chiếu với kết quả phiếu nhiều dòng ở bước 6:
    // SP1 ban đầu 0, nhập 20 (bước 6) + nhập 5 (bước 7) = 25
    let p1 = await req('GET', '/api/products/1', null, managerCookie);
    assert.strictEqual(p1.data.stock_quantity, 25, 'Tồn kho SP1 phải đối chiếu chính xác');

    // SP2 ban đầu 5, nhập 10 (bước 6) = 15
    let p2 = await req('GET', '/api/products/2', null, managerCookie);
    assert.strictEqual(p2.data.stock_quantity, 15, 'Tồn kho SP2 phải đối chiếu chính xác');

    // SP3 ban đầu 10, nhập 5 (bước 6) = 15
    let p3 = await req('GET', '/api/products/3', null, managerCookie);
    assert.strictEqual(p3.data.stock_quantity, 15, 'Tồn kho SP3 phải đối chiếu chính xác');

    // Kiểm tra trực tiếp bảng stock_movements trong CSDL
    const pool = mysql.createPool(testDbConfig);
    try {
      const [moves] = await pool.query(
        `SELECT sm.*, sri.quantity, sri.receipt_id 
         FROM stock_movements sm
         JOIN stock_receipt_items sri ON sm.receipt_item_id = sri.id
         WHERE sri.receipt_id = ?
         ORDER BY sm.id ASC`,
        [createdReceiptId]
      );
      assert.strictEqual(moves.length, 3, 'Phải có đúng 3 bản ghi stock_movements cho phiếu nhập');
      for (const m of moves) {
        assert.ok(m.quantity_delta > 0, 'quantity_delta nhập kho phải dương');
        assert.strictEqual(m.quantity_delta, m.quantity, 'quantity_delta phải khớp số lượng chi tiết');
        assert.ok(m.balance_after >= m.quantity_delta, 'balance_after phải lớn hơn hoặc bằng delta');
      }
    } finally {
      await pool.end();
    }
  });

  await t.test('10. Danh sách tìm theo mã phiếu, lọc ngày và phân trang', async () => {
    // 10.1. Tìm theo mã phiếu
    let searchRes = await req('GET', '/api/stock-receipts?q=MULTI&paginate=true', null, managerCookie);
    assert.strictEqual(searchRes.status, 200);
    assert.ok(searchRes.data.receipts.some(r => r.receipt_no === 'PN_MULTI_01'));

    // 10.2. Lọc theo ngày hôm nay
    const today = new Date().toISOString().slice(0, 10);
    let dateRes = await req('GET', `/api/stock-receipts?from_date=${today}&to_date=${today}&paginate=true`, null, managerCookie);
    assert.strictEqual(dateRes.status, 200);
    assert.ok(dateRes.data.receipts.length >= 2, 'Phải lọc được các phiếu lập hôm nay');

    // 10.3. Phân trang
    let pageRes = await req('GET', '/api/stock-receipts?page=1&limit=1&paginate=true', null, managerCookie);
    assert.strictEqual(pageRes.status, 200);
    assert.strictEqual(pageRes.data.pagination.page, 1);
    assert.strictEqual(pageRes.data.pagination.limit, 1);
    assert.strictEqual(pageRes.data.receipts.length, 1);
    assert.ok(pageRes.data.pagination.total >= 2);
    assert.ok(pageRes.data.pagination.totalPages >= 2);
  });

  await t.test('11. Chặn sửa/xóa phiếu nhập đã ghi nhận (HTTP 405 Method Not Allowed)', async () => {
    // Thử sửa phiếu
    let putRes = await req('PUT', `/api/stock-receipts/${createdReceiptId}`, {
      items: [{ product_id: 1, quantity: 100, unit_cost: 1000 }]
    }, managerCookie, managerCsrf);
    assert.strictEqual(putRes.status, 405, 'Phải chặn PUT sửa phiếu đã ghi nhận');

    // Thử xóa phiếu
    let delRes = await req('DELETE', `/api/stock-receipts/${createdReceiptId}`, null, managerCookie, managerCsrf);
    assert.strictEqual(delRes.status, 405, 'Phải chặn DELETE xóa phiếu đã ghi nhận');
  });

  await t.test('12. Dọn dẹp máy chủ kiểm thử', async () => {
    if (serverProcess) {
      serverProcess.kill();
    }
  });
});
