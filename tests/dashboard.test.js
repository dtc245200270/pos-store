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
  database: 'pos_store_dashboard_test'
};

const BASE_URL = 'http://127.0.0.1:3005';

test('Dashboard Stats Comprehensive Tests', async (t) => {
  let serverProcess;

  await t.test('1. Chuẩn bị CSDL kiểm thử độc lập và khởi động Server cổng 3005', async () => {
    const rootPool = mysql.createPool({
      host: testDbConfig.host,
      port: testDbConfig.port,
      user: process.env.ROOT_USER || 'root',
      password: process.env.ROOT_PASSWORD || process.env.DB_PASSWORD || '',
      multipleStatements: true
    });

    try {
      await rootPool.query('DROP DATABASE IF EXISTS pos_store_dashboard_test');
      await rootPool.query('CREATE DATABASE pos_store_dashboard_test');
      await rootPool.query('GRANT ALL PRIVILEGES ON pos_store_dashboard_test.* TO "pos_app"@"localhost"');
      await rootPool.query('FLUSH PRIVILEGES');

      const schemaSql = require('fs').readFileSync('database/schema.sql', 'utf-8').replace(/\bpos_store\b/g, 'pos_store_dashboard_test');
      const sessionSql = require('fs').readFileSync('database/migration_01_sessions.sql', 'utf-8').replace(/\bpos_store\b/g, 'pos_store_dashboard_test');
      const mig02Sql = require('fs').readFileSync('database/migration_02_payment_methods.sql', 'utf-8').replace(/\bpos_store\b/g, 'pos_store_dashboard_test');

      const parts = [...schemaSql.split(';'), ...sessionSql.split(';'), ...mig02Sql.split(';')].map(s => s.trim()).filter(s => s.length > 0);
      const conn = await rootPool.getConnection();
      try {
        await conn.query('USE pos_store_dashboard_test');
        for (const sql of parts) {
          if (!sql.toUpperCase().startsWith('DELIMITER')) {
            await conn.query(sql);
          }
        }

        const bcrypt = require('bcryptjs');
        const hash = await bcrypt.hash('password123', 10);
        await conn.query('INSERT IGNORE INTO users (id, username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?, ?)',
          [1, 'manager_dash', hash, 'Nguyễn Quản Lý Tổng Quan', 'MANAGER', 1]);
        await conn.query('INSERT IGNORE INTO users (id, username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?, ?)',
          [2, 'cashier_dash', hash, 'Trần Thu Ngân Bán Hàng', 'CASHIER', 1]);

        // Sản phẩm 1: Tồn = 0 (hết hàng)
        await conn.query('INSERT INTO products (id, sku, name, unit, sale_price, stock_quantity, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [1, 'SP_DASH_OUT', 'Sổ Bìa Cứng A4', 'Cuốn', 45000, 0, 1]);

        // Sản phẩm 2: Tồn = 3 (sắp hết hàng với ngưỡng <= 5)
        await conn.query('INSERT INTO products (id, sku, name, unit, sale_price, stock_quantity, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [2, 'SP_DASH_LOW', 'Bút Bi Xanh Baoke', 'Cây', 6000, 3, 1]);

        // Sản phẩm 3: Tồn = 50 (còn hàng an toàn)
        await conn.query('INSERT INTO products (id, sku, name, unit, sale_price, stock_quantity, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [3, 'SP_DASH_SAFE', 'Tập Giấy A4 Double A', 'Gam', 85000, 50, 1]);

        // Sản phẩm 4: Ngừng kinh doanh (is_active = 0)
        await conn.query('INSERT INTO products (id, sku, name, unit, sale_price, stock_quantity, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [4, 'SP_DASH_INACTIVE', 'Băng Keo Giấy Cũ', 'Cuộn', 10000, 0, 0]);

        // Hóa đơn hôm qua: 500,000 đ
        const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
        await conn.query(`
          INSERT INTO invoices (invoice_no, created_by, request_key, request_hash, total_amount, created_at)
          VALUES ('HD-YESTERDAY-01', 2, 'req-key-yesterday', ?, 500000.00, ?)
        `, ['c'.repeat(64), yesterday]);
      } finally {
        conn.release();
      }
    } finally {
      await rootPool.end();
    }

    return new Promise((resolve) => {
      serverProcess = spawn('node', ['server.js'], {
        env: { ...process.env, DB_NAME: 'pos_store_dashboard_test', SESSION_SECRET: 'test_dash_secret', PORT: '3005', METRICS_PORT: '0' }
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

  await t.test('2. Đăng nhập Quản lý (MANAGER) và Thu ngân (CASHIER)', async () => {
    // CSRF cho Manager
    const r1 = await req('GET', '/api/auth/csrf');
    assert.strictEqual(r1.status, 200);
    managerCookie = r1.cookie;

    // Login Manager
    const r2 = await req('POST', '/api/auth/login', {
      username: 'manager_dash',
      password: 'password123'
    }, managerCookie, r1.data.csrfToken);
    assert.strictEqual(r2.status, 200);
    managerCookie = r2.cookie;
    managerCsrf = r2.data.csrfToken;

    // CSRF cho Cashier
    const r3 = await req('GET', '/api/auth/csrf');
    assert.strictEqual(r3.status, 200);
    cashierCookie = r3.cookie;

    // Login Cashier
    const r4 = await req('POST', '/api/auth/login', {
      username: 'cashier_dash',
      password: 'password123'
    }, cashierCookie, r3.data.csrfToken);
    assert.strictEqual(r4.status, 200);
    cashierCookie = r4.cookie;
    cashierCsrf = r4.data.csrfToken;
  });

  await t.test('3. Phân quyền: CASHIER bị chặn truy cập API thống kê (HTTP 403 Forbidden)', async () => {
    const cshRes = await req('GET', '/api/dashboard/stats', null, cashierCookie);
    assert.strictEqual(cshRes.status, 403, 'CASHIER không được phép truy cập API thống kê');
    assert(cshRes.data.error.includes('Chỉ Quản lý') || cshRes.data.error.includes('MANAGER'));
  });

  await t.test('4. Tạo giao dịch hôm nay: 2 Hóa đơn bán hàng & 1 Phiếu nhập hàng', async () => {
    // Hóa đơn 1 hôm nay: 2 x 85,000 = 170,000 đ
    const inv1 = await req('POST', '/api/invoices', {
      invoice_no: 'HD-TODAY-01',
      request_key: 'req-today-inv-01',
      items: [{ product_id: 3, quantity: 2, unit_price: 85000 }]
    }, cashierCookie, cashierCsrf);
    assert.strictEqual(inv1.status, 201, 'Tạo hóa đơn 1 thành công');

    // Hóa đơn 2 hôm nay: 3 x 85,000 = 255,000 đ
    const inv2 = await req('POST', '/api/invoices', {
      invoice_no: 'HD-TODAY-02',
      request_key: 'req-today-inv-02',
      items: [{ product_id: 3, quantity: 3, unit_price: 85000 }]
    }, cashierCookie, cashierCsrf);
    assert.strictEqual(inv2.status, 201, 'Tạo hóa đơn 2 thành công');

    // Phiếu nhập hàng hôm nay: 10 x 50,000 = 500,000 đ (TIỀN NHẬP)
    const rcpt = await req('POST', '/api/stock-receipts', {
      receipt_no: 'PN-TODAY-01',
      request_key: 'req-today-rcpt-01',
      items: [{ product_id: 3, quantity: 10, unit_cost: 50000 }]
    }, managerCookie, managerCsrf);
    assert.strictEqual(rcpt.status, 201, 'Tạo phiếu nhập hàng thành công');
  });

  await t.test('5. Kiểm tra đối chiếu tổng tiền & số hóa đơn hôm nay (Loại trừ tiền nhập & hóa đơn cũ)', async () => {
    const statsRes = await req('GET', '/api/dashboard/stats', null, managerCookie);
    assert.strictEqual(statsRes.status, 200, 'Quản lý lấy thống kê thành công');

    const summary = statsRes.data.summary;
    console.log('  -> Dữ liệu thống kê tổng quan:', summary);

    // Tổng doanh thu hôm nay phải là 170,000 + 255,000 = 425,000 đ
    // (Tuyệt đối KHÔNG cộng 500,000 đ tiền nhập hàng và KHÔNG cộng 500,000 đ hóa đơn ngày hôm qua)
    assert.strictEqual(Number(summary.todayRevenue), 425000, 'Doanh thu hôm nay đúng 425,000 đ');
    assert.strictEqual(summary.todayInvoicesCount, 2, 'Số hóa đơn hôm nay đúng bằng 2');

    // Đối chiếu với danh sách hóa đơn cùng ngày từ API /api/invoices
    const todayStr = statsRes.data.date;
    const invListRes = await req('GET', `/api/invoices?from_date=${todayStr}&to_date=${todayStr}&limit=50`, null, managerCookie);
    assert.strictEqual(invListRes.status, 200);

    const invoicesToday = invListRes.data.invoices;
    assert.strictEqual(invoicesToday.length, 2, 'Danh sách hóa đơn cùng ngày có đúng 2 hóa đơn');

    const sumToday = invoicesToday.reduce((sum, inv) => sum + Number(inv.total_amount), 0);
    assert.strictEqual(sumToday, summary.todayRevenue, 'Tổng tiền đối chiếu giữa Dashboard và danh sách Hóa đơn khớp 100%');
  });

  await t.test('6. Kiểm tra số sản phẩm đang kinh doanh và danh sách sản phẩm hết/sắp hết hàng', async () => {
    const statsRes = await req('GET', '/api/dashboard/stats', null, managerCookie);
    assert.strictEqual(statsRes.status, 200);

    // Sản phẩm đang kinh doanh: SP1, SP2, SP3 (loại trừ SP4 ngừng kinh doanh)
    assert.strictEqual(statsRes.data.summary.activeProductsCount, 3, 'Có đúng 3 sản phẩm đang kinh doanh');

    // Danh sách hết/sắp hết hàng (ngưỡng 5): SP1 (tồn 0), SP2 (tồn 3)
    const lowStock = statsRes.data.lowStockProducts;
    assert.strictEqual(lowStock.length, 2, 'Có đúng 2 sản phẩm hết hoặc sắp hết');
    assert.strictEqual(lowStock[0].sku, 'SP_DASH_OUT', 'Sản phẩm hết hàng (tồn 0) đứng đầu');
    assert.strictEqual(lowStock[1].sku, 'SP_DASH_LOW', 'Sản phẩm sắp hết hàng (tồn 3) đứng kế tiếp');
  });

  await t.test('7. Kiểm tra danh sách hóa đơn gần đây có liên kết và người lập', async () => {
    const statsRes = await req('GET', '/api/dashboard/stats', null, managerCookie);
    assert.strictEqual(statsRes.status, 200);

    const recent = statsRes.data.recentInvoices;
    assert(recent.length >= 2, 'Có danh sách hóa đơn gần đây');
    assert(recent[0].invoice_no.startsWith('HD-'), 'Mã hóa đơn đúng định dạng');
    assert(recent[0].created_by_name.includes('Thu Ngân') || recent[0].created_by_name.includes('cashier'), 'Có tên người lập');
  });

  await t.test('8. Dọn dẹp máy chủ kiểm thử', async () => {
    if (serverProcess) {
      serverProcess.kill();
    }
  });
});
