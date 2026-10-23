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
  database: 'pos_store_inventory_test'
};

const BASE_URL = 'http://127.0.0.1:3004';

test('Inventory & Stock Movements Comprehensive Tests', async (t) => {
  let serverProcess;

  await t.test('1. Chuẩn bị CSDL kiểm thử độc lập và khởi động Server cổng 3004', async () => {
    const rootPool = mysql.createPool({
      host: testDbConfig.host,
      port: testDbConfig.port,
      user: process.env.ROOT_USER || 'root',
      password: process.env.ROOT_PASSWORD || process.env.DB_PASSWORD || '',
      multipleStatements: true
    });

    try {
      await rootPool.query('DROP DATABASE IF EXISTS pos_store_inventory_test');
      await rootPool.query('CREATE DATABASE pos_store_inventory_test');
      await rootPool.query('GRANT ALL PRIVILEGES ON pos_store_inventory_test.* TO "pos_app"@"localhost"');
      await rootPool.query('FLUSH PRIVILEGES');

      const schemaSql = require('fs').readFileSync('database/schema.sql', 'utf-8').replace(/\bpos_store\b/g, 'pos_store_inventory_test');
      const sessionSql = require('fs').readFileSync('database/migration_01_sessions.sql', 'utf-8').replace(/\bpos_store\b/g, 'pos_store_inventory_test');
      const mig02Sql = require('fs').readFileSync('database/migration_02_payment_methods.sql', 'utf-8').replace(/\bpos_store\b/g, 'pos_store_inventory_test');

      const parts = [...schemaSql.split(';'), ...sessionSql.split(';'), ...mig02Sql.split(';')].map(s => s.trim()).filter(s => s.length > 0);
      const conn = await rootPool.getConnection();
      try {
        await conn.query('USE pos_store_inventory_test');
        for (const sql of parts) {
          if (!sql.toUpperCase().startsWith('DELIMITER')) {
            await conn.query(sql);
          }
        }

        const bcrypt = require('bcryptjs');
        const hash = await bcrypt.hash('password123', 10);
        await conn.query('INSERT IGNORE INTO users (id, username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?, ?)',
          [1, 'manager_inv', hash, 'Nguyễn Quản Lý Tồn Kho', 'MANAGER', 1]);
        await conn.query('INSERT IGNORE INTO users (id, username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?, ?)',
          [2, 'cashier_inv', hash, 'Trần Thu Ngân Bán Hàng', 'CASHIER', 1]);

        // Sản phẩm 1: Tồn ban đầu = 0 để kiểm thử chuỗi nhập +10, bán -2 -> tồn sau 8
        await conn.query('INSERT INTO products (id, sku, name, unit, sale_price, stock_quantity, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [1, 'SP_INV_TEST1', 'Sách Lập Trình Node.js', 'Cuốn', 150000, 0, 1]);

        // Sản phẩm 2: Hết hàng sẵn (tồn = 0)
        await conn.query('INSERT INTO products (id, sku, name, unit, sale_price, stock_quantity, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [2, 'SP_INV_ZERO', 'Vở Kẻ Ngang 200 Trang', 'Cuốn', 12000, 0, 1]);

        // Sản phẩm 3: Tồn = 3 (sắp hết hàng với ngưỡng 5)
        await conn.query('INSERT INTO products (id, sku, name, unit, sale_price, stock_quantity, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [3, 'SP_INV_LOW', 'Bút Bi Gel Thiên Long', 'Cây', 5000, 3, 1]);

        // Sản phẩm 4: Tồn = 50 (còn hàng an toàn)
        await conn.query('INSERT INTO products (id, sku, name, unit, sale_price, stock_quantity, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [4, 'SP_INV_SAFE', 'Bút Chì Gỗ 2B', 'Cây', 4000, 50, 1]);
      } finally {
        conn.release();
      }
    } finally {
      await rootPool.end();
    }

    return new Promise((resolve) => {
      serverProcess = spawn('node', ['server.js'], {
        env: { ...process.env, DB_NAME: 'pos_store_inventory_test', SESSION_SECRET: 'test_inv_secret', PORT: '3004', METRICS_PORT: '0' }
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
    managerCsrf = r1.data.csrfToken;

    // Login Manager
    const r2 = await req('POST', '/api/auth/login', {
      username: 'manager_inv',
      password: 'password123'
    }, managerCookie, managerCsrf);
    assert.strictEqual(r2.status, 200);
    managerCookie = r2.cookie;
    managerCsrf = r2.data.csrfToken;

    // CSRF cho Cashier
    const r3 = await req('GET', '/api/auth/csrf');
    assert.strictEqual(r3.status, 200);
    cashierCookie = r3.cookie;
    cashierCsrf = r3.data.csrfToken;

    // Login Cashier
    const r4 = await req('POST', '/api/auth/login', {
      username: 'cashier_inv',
      password: 'password123'
    }, cashierCookie, cashierCsrf);
    assert.strictEqual(r4.status, 200);
    cashierCookie = r4.cookie;
    cashierCsrf = r4.data.csrfToken;
  });

  await t.test('3. Kiểm thử chuỗi nghiệp vụ: Nhập +10, Bán -2, Tồn sau 8', async () => {
    // 3.1. Quản lý lập phiếu nhập hàng +10 sản phẩm 1
    const receiptRes = await req('POST', '/api/stock-receipts', {
      receipt_no: 'PN-INV-001',
      request_key: 'req-inv-import-10',
      items: [
        { product_id: 1, quantity: 10, unit_cost: 95000 }
      ]
    }, managerCookie, managerCsrf);
    assert.strictEqual(receiptRes.status, 201, 'Quản lý lập phiếu nhập thành công');

    // Kiểm tra tồn kho sau khi nhập +10
    const checkStockAfterImport = await req('GET', '/api/inventory?q=SP_INV_TEST1', null, managerCookie);
    assert.strictEqual(checkStockAfterImport.status, 200);
    const prodAfterImport = checkStockAfterImport.data.products[0];
    assert.strictEqual(prodAfterImport.stock_quantity, 10, 'Tồn kho sau nhập phải là 10');

    // 3.2. Thu ngân lập hóa đơn bán -2 sản phẩm 1
    const invoiceRes = await req('POST', '/api/invoices', {
      invoice_no: 'HD-INV-001',
      request_key: 'req-inv-export-2',
      items: [
        { product_id: 1, quantity: 2, unit_price: 150000 }
      ]
    }, cashierCookie, cashierCsrf);
    assert.strictEqual(invoiceRes.status, 201, 'Thu ngân lập hóa đơn bán thành công');

    // 3.3. Kiểm tra tồn kho sau khi bán -2: Tồn sau phải chính xác là 8
    const checkStockAfterSale = await req('GET', '/api/inventory?q=SP_INV_TEST1', null, cashierCookie);
    assert.strictEqual(checkStockAfterSale.status, 200);
    const prodAfterSale = checkStockAfterSale.data.products[0];
    assert.strictEqual(prodAfterSale.stock_quantity, 8, 'Tồn kho sau bán phải là 8 (10 - 2 = 8)');
  });

  await t.test('4. Đối chiếu lịch sử biến động kho stock_movements của sản phẩm (MANAGER)', async () => {
    const movementsRes = await req('GET', '/api/inventory/1/movements', null, managerCookie);
    assert.strictEqual(movementsRes.status, 200);
    const data = movementsRes.data;
    assert(data.product, 'Có thông tin sản phẩm');
    assert.strictEqual(data.product.stock_quantity, 8, 'Tồn hiện tại là 8');

    const movements = data.movements;
    assert.strictEqual(movements.length, 2, 'Có đúng 2 dòng biến động kho');

    // Dòng 1 (gần nhất): Xuất bán -2, tồn sau 8, mã HD-INV-001, người thực hiện là Thu ngân
    const m1 = movements[0];
    assert.strictEqual(m1.quantity_delta, -2, 'Delta dòng 1 là -2');
    assert.strictEqual(m1.balance_after, 8, 'Tồn sau dòng 1 là 8');
    assert.strictEqual(m1.movement_type, 'EXPORT', 'Loại biến động là EXPORT');
    assert.strictEqual(m1.document_no, 'HD-INV-001', 'Mã chứng từ là HD-INV-001');
    assert(m1.performed_by.includes('Thu Ngân') || m1.performed_by.includes('cashier'), 'Người thực hiện là Thu ngân');
    assert(m1.created_at, 'Có thời gian ghi nhận');

    // Dòng 2: Nhập kho +10, tồn sau 10, mã PN-INV-001, người thực hiện là Quản lý
    const m2 = movements[1];
    assert.strictEqual(m2.quantity_delta, 10, 'Delta dòng 2 là +10');
    assert.strictEqual(m2.balance_after, 10, 'Tồn sau dòng 2 là 10');
    assert.strictEqual(m2.movement_type, 'IMPORT', 'Loại biến động là IMPORT');
    assert.strictEqual(m2.document_no, 'PN-INV-001', 'Mã chứng từ là PN-INV-001');
    assert(m2.performed_by.includes('Quản Lý') || m2.performed_by.includes('manager'), 'Người thực hiện là Quản lý');
  });

  await t.test('5. Phân quyền: CASHIER bị chặn truy cập API Lịch sử biến động kho (HTTP 403 Forbidden)', async () => {
    // Thu ngân cố gọi lịch sử sản phẩm 1
    const cashierProductMovements = await req('GET', '/api/inventory/1/movements', null, cashierCookie);
    assert.strictEqual(cashierProductMovements.status, 403, 'CASHIER bị từ chối 403 khi xem lịch sử sản phẩm');
    assert(cashierProductMovements.data.error.includes('Chỉ Quản lý') || cashierProductMovements.data.error.includes('MANAGER'));

    // Thu ngân cố gọi lịch sử toàn bộ kho
    const cashierAllMovements = await req('GET', '/api/inventory/movements', null, cashierCookie);
    assert.strictEqual(cashierAllMovements.status, 403, 'CASHIER bị từ chối 403 khi xem toàn bộ biến động kho');
  });

  await t.test('6. Cả MANAGER và CASHIER đều tra cứu được tồn kho (SKU, Tên, Đơn vị, Số lượng)', async () => {
    // Manager tra cứu
    const mgrRes = await req('GET', '/api/inventory', null, managerCookie);
    assert.strictEqual(mgrRes.status, 200);
    assert(Array.isArray(mgrRes.data.products), 'Trả về danh sách sản phẩm');
    assert(mgrRes.data.products.length >= 4, 'Đủ số lượng sản phẩm');

    // Cashier tra cứu
    const cshRes = await req('GET', '/api/inventory', null, cashierCookie);
    assert.strictEqual(cshRes.status, 200);
    const item1 = cshRes.data.products.find(p => p.sku === 'SP_INV_TEST1');
    assert(item1, 'Tìm thấy SP_INV_TEST1');
    assert.strictEqual(item1.sku, 'SP_INV_TEST1');
    assert.strictEqual(item1.name, 'Sách Lập Trình Node.js');
    assert.strictEqual(item1.unit, 'Cuốn');
    assert.strictEqual(item1.stock_quantity, 8);
  });

  await t.test('7. Tìm kiếm theo SKU hoặc Tên sản phẩm', async () => {
    // Tìm theo SKU
    const resBySku = await req('GET', '/api/inventory?q=SP_INV_TEST1', null, cashierCookie);
    assert.strictEqual(resBySku.status, 200);
    assert.strictEqual(resBySku.data.products.length, 1);
    assert.strictEqual(resBySku.data.products[0].sku, 'SP_INV_TEST1');

    // Tìm theo Tên
    const resByName = await req('GET', '/api/inventory?q=Lập Trình', null, managerCookie);
    assert.strictEqual(resByName.status, 200);
    assert.strictEqual(resByName.data.products.length, 1);
    assert.strictEqual(resByName.data.products[0].name, 'Sách Lập Trình Node.js');
  });

  await t.test('8. Lọc hết hàng (out_of_stock) và sắp hết hàng (low_stock) với ngưỡng minh bạch', async () => {
    // 8.1. Lọc hết hàng: Chỉ lấy tồn = 0
    const outRes = await req('GET', '/api/inventory?status=out_of_stock', null, cashierCookie);
    assert.strictEqual(outRes.status, 200);
    assert(outRes.data.products.every(p => p.stock_quantity === 0), 'Tất cả sản phẩm đều có tồn = 0');
    assert(outRes.data.products.some(p => p.sku === 'SP_INV_ZERO'), 'Có SP_INV_ZERO');

    // 8.2. Lọc sắp hết hàng với ngưỡng mặc định (threshold = 5):
    // SP_INV_LOW (tồn 3) nằm trong khoảng (0, 5] -> phải có trong danh sách
    // SP_INV_TEST1 (tồn 8) > 5 -> KHÔNG có trong danh sách
    const lowResDefault = await req('GET', '/api/inventory?status=low_stock&threshold=5', null, managerCookie);
    assert.strictEqual(lowResDefault.status, 200);
    assert.strictEqual(lowResDefault.data.threshold, 5);
    assert(lowResDefault.data.products.some(p => p.sku === 'SP_INV_LOW'), 'Tồn 3 phải thuộc sắp hết hàng với ngưỡng 5');
    assert(!lowResDefault.data.products.some(p => p.sku === 'SP_INV_TEST1'), 'Tồn 8 không thuộc sắp hết hàng với ngưỡng 5');

    // 8.3. Lọc sắp hết hàng với ngưỡng nâng lên 10:
    // SP_INV_TEST1 (tồn 8 <= 10) -> LẦN NÀY PHẢI CÓ trong danh sách
    const lowRes10 = await req('GET', '/api/inventory?status=low_stock&threshold=10', null, managerCookie);
    assert.strictEqual(lowRes10.status, 200);
    assert.strictEqual(lowRes10.data.threshold, 10);
    assert(lowRes10.data.products.some(p => p.sku === 'SP_INV_TEST1'), 'Tồn 8 phải thuộc sắp hết hàng khi nâng ngưỡng lên 10');
  });

  await t.test('9. Tuyệt đối không cho sửa tồn trực tiếp (HTTP 405 Method Not Allowed)', async () => {
    // Thử PUT tới /api/inventory
    const putRes = await req('PUT', '/api/inventory', { stock_quantity: 999 }, managerCookie, managerCsrf);
    assert.strictEqual(putRes.status, 405, 'Bị chặn 405 khi cố tình PUT /api/inventory');
    assert(putRes.data.error.includes('Không cho phép'));

    // Thử POST tới /api/inventory
    const postRes = await req('POST', '/api/inventory', { stock_quantity: 999 }, managerCookie, managerCsrf);
    assert.strictEqual(postRes.status, 405, 'Bị chặn 405 khi cố tình POST /api/inventory');

    // Thử PATCH tới /api/inventory/1
    const patchRes = await req('PATCH', '/api/inventory/1', { stock_quantity: 999 }, managerCookie, managerCsrf);
    assert.strictEqual(patchRes.status, 405, 'Bị chặn 405 khi cố tình PATCH /api/inventory/:id');

    // Thử DELETE tới /api/inventory/1
    const deleteRes = await req('DELETE', '/api/inventory/1', null, managerCookie, managerCsrf);
    assert.strictEqual(deleteRes.status, 405, 'Bị chặn 405 khi cố tình DELETE /api/inventory/:id');
  });

  await t.test('10. Kiểm thử toàn diện Bộ lọc khoảng ngày cho Lịch sử biến động kho', async (t2) => {
    // 10.1. Kiểm tra ngày không tồn tại và sai định dạng (HTTP 400 tiếng Việt)
    const errInvalidDate = await req('GET', '/api/inventory/movements?from_date=2026-02-30', null, managerCookie);
    assert.strictEqual(errInvalidDate.status, 400);
    assert.strictEqual(errInvalidDate.data.error, 'Định dạng Từ ngày không hợp lệ hoặc không tồn tại trên lịch.');

    const errInvalidToDate = await req('GET', '/api/inventory/1/movements?to_date=2026-04-31', null, managerCookie);
    assert.strictEqual(errInvalidToDate.status, 400);
    assert.strictEqual(errInvalidToDate.data.error, 'Định dạng Đến ngày không hợp lệ hoặc không tồn tại trên lịch.');

    const errFormatDate = await req('GET', '/api/inventory/movements?from_date=abc', null, managerCookie);
    assert.strictEqual(errFormatDate.status, 400);
    assert.strictEqual(errFormatDate.data.error, 'Định dạng Từ ngày không hợp lệ hoặc không tồn tại trên lịch.');

    // 10.2. Kiểm tra năm nhuận và không nhuận
    // 2023 không phải năm nhuận -> 2023-02-29 không hợp lệ (HTTP 400)
    const errNonLeap = await req('GET', '/api/inventory/movements?from_date=2023-02-29', null, managerCookie);
    assert.strictEqual(errNonLeap.status, 400);

    // 2024 là năm nhuận -> 2024-02-29 hợp lệ (HTTP 200, trả về mảng hợp lệ)
    const resLeap = await req('GET', '/api/inventory/movements?from_date=2024-02-29&to_date=2024-02-29', null, managerCookie);
    assert.strictEqual(resLeap.status, 200);
    assert(Array.isArray(resLeap.data), 'Năm nhuận hợp lệ trả về mảng kết quả');

    // 10.3. Kiểm tra khoảng ngày đảo ngược (Từ ngày > Đến ngày -> HTTP 400)
    const errReversed = await req('GET', '/api/inventory/movements?from_date=2026-05-20&to_date=2026-05-10', null, managerCookie);
    assert.strictEqual(errReversed.status, 400);
    assert.strictEqual(errReversed.data.error, 'Từ ngày không được lớn hơn Đến ngày.');

    const errReversedProd = await req('GET', '/api/inventory/1/movements?from_date=2026-05-20&to_date=2026-05-10', null, managerCookie);
    assert.strictEqual(errReversedProd.status, 400);
    assert.strictEqual(errReversedProd.data.error, 'Từ ngày không được lớn hơn Đến ngày.');

    // 10.4. Thiết lập mốc thời gian biên đầu ngày (00:00:00) và cuối ngày (23:59:59) trong CSDL test
    const testConn = await mysql.createConnection(testDbConfig);
    try {
      await testConn.query("UPDATE stock_movements SET created_at = '2026-05-15 00:00:00' WHERE id = 1");
      await testConn.query("UPDATE stock_movements SET created_at = '2026-05-15 23:59:59' WHERE id = 2");
    } finally {
      await testConn.end();
    }

    // 10.5. Không nhập ngày: giữ hành vi hiện tại (trả về cả 2 giao dịch)
    const resNoDate = await req('GET', '/api/inventory/movements', null, managerCookie);
    assert.strictEqual(resNoDate.status, 200);
    assert.strictEqual(resNoDate.data.length, 2);

    const resProdNoDate = await req('GET', '/api/inventory/1/movements', null, managerCookie);
    assert.strictEqual(resProdNoDate.status, 200);
    assert.strictEqual(resProdNoDate.data.movements.length, 2);

    // 10.6. Chỉ nhập Từ ngày (from_date):
    // Từ 2026-05-15: phải bao gồm cả bản ghi 00:00:00 và 23:59:59
    const resFromDateMatch = await req('GET', '/api/inventory/movements?from_date=2026-05-15', null, managerCookie);
    assert.strictEqual(resFromDateMatch.status, 200);
    assert.strictEqual(resFromDateMatch.data.length, 2);

    // Từ 2026-05-16: không còn bản ghi nào
    const resFromDateFuture = await req('GET', '/api/inventory/movements?from_date=2026-05-16', null, managerCookie);
    assert.strictEqual(resFromDateFuture.status, 200);
    assert.strictEqual(resFromDateFuture.data.length, 0);

    // 10.7. Chỉ nhập Đến ngày (to_date):
    // Đến 2026-05-15: bao gồm cả ngày 15 (< 2026-05-16 00:00:00) -> lấy đủ 2 bản ghi
    const resToDateMatch = await req('GET', '/api/inventory/1/movements?to_date=2026-05-15', null, managerCookie);
    assert.strictEqual(resToDateMatch.status, 200);
    assert.strictEqual(resToDateMatch.data.movements.length, 2);

    // Đến 2026-05-14: trước ngày 15 -> không có bản ghi nào
    const resToDatePast = await req('GET', '/api/inventory/1/movements?to_date=2026-05-14', null, managerCookie);
    assert.strictEqual(resToDatePast.status, 200);
    assert.strictEqual(resToDatePast.data.movements.length, 0);

    // 10.8. Khoảng ngày hợp lệ bao gồm trọn vẹn cả đầu ngày và cuối ngày:
    const resExactDay = await req('GET', '/api/inventory/movements?from_date=2026-05-15&to_date=2026-05-15', null, managerCookie);
    assert.strictEqual(resExactDay.status, 200);
    assert.strictEqual(resExactDay.data.length, 2, 'Lọc đúng ngày 2026-05-15 bao gồm cả 00:00:00 và 23:59:59');

    // 10.9. Khoảng ngày không có giao dịch:
    const resEmptyRange = await req('GET', '/api/inventory/movements?from_date=2026-05-01&to_date=2026-05-10', null, managerCookie);
    assert.strictEqual(resEmptyRange.status, 200);
    assert.strictEqual(resEmptyRange.data.length, 0, 'Khoảng ngày không có giao dịch trả về mảng rỗng');

    // 10.10. Kết hợp ngày với từ khóa tìm kiếm (q) và sản phẩm cụ thể:
    // Tìm mã hóa đơn 'HD-INV-001' trong ngày 2026-05-15 -> đúng 1 bản ghi
    const resCombinedSearch = await req('GET', '/api/inventory/movements?from_date=2026-05-15&to_date=2026-05-15&q=HD-INV-001', null, managerCookie);
    assert.strictEqual(resCombinedSearch.status, 200);
    assert.strictEqual(resCombinedSearch.data.length, 1);
    assert.strictEqual(resCombinedSearch.data[0].document_no, 'HD-INV-001');

    // Lịch sử sản phẩm 1 trong ngày 2026-05-15 -> đủ 2 giao dịch
    const resProdCombined = await req('GET', '/api/inventory/1/movements?from_date=2026-05-15&to_date=2026-05-15', null, managerCookie);
    assert.strictEqual(resProdCombined.status, 200);
    assert.strictEqual(resProdCombined.data.movements.length, 2);

    // Tìm kiếm trong lịch sử sản phẩm 1:
    // a. Bằng SKU sản phẩm ('SP_INV_TEST1')
    const resProdBySku = await req('GET', '/api/inventory/1/movements?q=SP_INV_TEST1', null, managerCookie);
    assert.strictEqual(resProdBySku.status, 200);
    assert.strictEqual(resProdBySku.data.movements.length, 2, 'Tìm kiếm theo SKU trong lịch sử SP');

    // b. Bằng Tên sản phẩm ('Node.js')
    const resProdByName = await req('GET', '/api/inventory/1/movements?q=Node.js', null, managerCookie);
    assert.strictEqual(resProdByName.status, 200);
    assert.strictEqual(resProdByName.data.movements.length, 2, 'Tìm kiếm theo Tên trong lịch sử SP');

    // c. Bằng Mã chứng từ phiếu nhập ('PN-INV-001')
    const resProdByDoc = await req('GET', '/api/inventory/1/movements?q=PN-INV-001', null, managerCookie);
    assert.strictEqual(resProdByDoc.status, 200);
    assert.strictEqual(resProdByDoc.data.movements.length, 1);
    assert.strictEqual(resProdByDoc.data.movements[0].document_no, 'PN-INV-001');

    // d. Từ khóa không khớp -> trả về danh sách rỗng []
    const resProdNoMatch = await req('GET', '/api/inventory/1/movements?q=KHONG_KHOP_XYZ_999', null, managerCookie);
    assert.strictEqual(resProdNoMatch.status, 200);
    assert.strictEqual(resProdNoMatch.data.movements.length, 0, 'Từ khóa không khớp phải trả danh sách rỗng');

    // Lịch sử sản phẩm 2 (chưa có giao dịch) -> mảng rỗng
    const resProd2 = await req('GET', '/api/inventory/2/movements?from_date=2026-05-15&to_date=2026-05-15', null, managerCookie);
    assert.strictEqual(resProd2.status, 200);
    assert.strictEqual(resProd2.data.movements.length, 0);

    // 10.11. Thu ngân (CASHIER) gọi trực tiếp cả 2 API kèm ngày vẫn bị từ chối 403 Forbidden
    const cashierAllWithDate = await req('GET', '/api/inventory/movements?from_date=2026-05-15&to_date=2026-05-15', null, cashierCookie);
    assert.strictEqual(cashierAllWithDate.status, 403, 'CASHIER bị chặn khi gọi /api/inventory/movements');

    const cashierProdWithDate = await req('GET', '/api/inventory/1/movements?from_date=2026-05-15&to_date=2026-05-15', null, cashierCookie);
    assert.strictEqual(cashierProdWithDate.status, 403, 'CASHIER bị chặn khi gọi /api/inventory/1/movements');
  });

  await t.test('11. Dọn dẹp máy chủ kiểm thử', async () => {
    if (serverProcess) {
      serverProcess.kill();
    }
  });
});
