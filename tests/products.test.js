/**
 * POS Store - Bộ Kiểm Thử Quản Lý Danh Mục Sản Phẩm (Products Management Tests)
 * Đường dẫn: tests/products.test.js
 *
 * Điều kiện chuẩn bị:
 * - Khởi tạo cơ sở dữ liệu kiểm thử cô lập 'pos_store_products_test' và nạp cấu trúc bảng.
 * - Khởi động máy chủ ứng dụng độc lập trên cổng 3002.
 *
 * Thao tác kiểm tra:
 * - Kiểm tra tạo mới sản phẩm: Kiểm tra bắt buộc các trường, tính duy nhất của mã SKU, giá bán hợp lệ (> 0).
 * - Kiểm tra tồn kho khởi tạo: Khi tạo sản phẩm mới, số lượng tồn kho mặc định luôn bằng 0 (không cho phép nhập trực tiếp).
 * - Kiểm tra cập nhật sản phẩm: Đổi tên, đơn vị tính, giá bán, bật/tắt trạng thái kinh doanh is_active.
 * - Kiểm tra ràng buộc xóa (ON DELETE RESTRICT):
 *   + Sản phẩm chưa từng phát sinh chứng từ nhập/xuất: Cho phép xóa hoàn toàn khỏi hệ thống (200 OK).
 *   + Sản phẩm đã từng có trong hóa đơn hoặc phiếu nhập: Bị từ chối xóa với lỗi 400 và hướng dẫn chuyển sang ngừng kinh doanh.
 *
 * Kết quả mong đợi:
 * - Bảo đảm tính toàn vẹn dữ liệu, không có sản phẩm mồ côi và không vi phạm ràng buộc toàn vẹn khóa ngoại.
 *
 * Bước dọn dẹp:
 * - Dừng tiến trình máy chủ cổng 3002 và xóa database pos_store_products_test.
 */

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
  database: 'pos_store_products_test'
};

const BASE_URL = 'http://127.0.0.1:3002';

test('Products Management Comprehensive Tests', async (t) => {
  let serverProcess;

  await t.test('1. Chuẩn bị CSDL kiểm thử và khởi động Server cổng 3002', async () => {
    const rootPool = mysql.createPool({
      host: testDbConfig.host,
      port: testDbConfig.port,
      user: process.env.ROOT_USER || 'root',
      password: process.env.ROOT_PASSWORD || process.env.DB_PASSWORD || '',
      multipleStatements: true
    });

    try {
      await rootPool.query('DROP DATABASE IF EXISTS pos_store_products_test');
      await rootPool.query('CREATE DATABASE pos_store_products_test');
      await rootPool.query('GRANT ALL PRIVILEGES ON pos_store_products_test.* TO "pos_app"@"localhost"');
      await rootPool.query('FLUSH PRIVILEGES');

      const schemaSql = require('fs').readFileSync('database/schema.sql', 'utf-8').replace(/\bpos_store\b/g, 'pos_store_products_test');
      const sessionSql = require('fs').readFileSync('database/migration_01_sessions.sql', 'utf-8').replace(/\bpos_store\b/g, 'pos_store_products_test');
      const mig02Sql = require('fs').readFileSync('database/migration_02_payment_methods.sql', 'utf-8').replace(/\bpos_store\b/g, 'pos_store_products_test');

      const parts = [...schemaSql.split(';'), ...sessionSql.split(';'), ...mig02Sql.split(';')].map(s => s.trim()).filter(s => s.length > 0);
      const conn = await rootPool.getConnection();
      try {
        await conn.query('USE pos_store_products_test');
        for (const sql of parts) {
          if (!sql.toUpperCase().startsWith('DELIMITER')) {
            await conn.query(sql);
          }
        }

        const bcrypt = require('bcryptjs');
        const hash = await bcrypt.hash('password123', 10);
        await conn.query('INSERT IGNORE INTO users (username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?)',
          ['manager_prod', hash, 'Manager Products', 'MANAGER', 1]);
        await conn.query('INSERT IGNORE INTO users (username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?)',
          ['cashier_prod', hash, 'Cashier Products', 'CASHIER', 1]);
      } finally {
        conn.release();
      }
    } finally {
      await rootPool.end();
    }

    return new Promise((resolve) => {
      serverProcess = spawn('node', ['server.js'], {
        env: { ...process.env, DB_NAME: 'pos_store_products_test', SESSION_SECRET: 'test_prod_secret', PORT: '3002', METRICS_PORT: '0' }
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

  await t.test('2. Đăng nhập tài khoản Quản lý (MANAGER) và Thu ngân (CASHIER)', async () => {
    // Manager
    let csrfRes = await req('GET', '/api/auth/csrf');
    let loginRes = await req('POST', '/api/auth/login', { username: 'manager_prod', password: 'password123' }, csrfRes.cookie, csrfRes.data.csrfToken);
    assert.strictEqual(loginRes.status, 200);
    managerCookie = loginRes.cookie;
    managerCsrf = loginRes.data.csrfToken;

    // Cashier
    let csrfResCashier = await req('GET', '/api/auth/csrf');
    let loginResCashier = await req('POST', '/api/auth/login', { username: 'cashier_prod', password: 'password123' }, csrfResCashier.cookie, csrfResCashier.data.csrfToken);
    assert.strictEqual(loginResCashier.status, 200);
    cashierCookie = loginResCashier.cookie;
    cashierCsrf = loginResCashier.data.csrfToken;
  });

  await t.test('3. Phân quyền: Thu ngân (CASHIER) bị từ chối sửa/xóa/thêm sản phẩm', async () => {
    // CASHIER tạo sản phẩm -> 403
    let res = await req('POST', '/api/products', { sku: 'TEST_NO_ROLE', name: 'Test', unit: 'Cái', sale_price: 10000 }, cashierCookie, cashierCsrf);
    assert.strictEqual(res.status, 403, 'CASHIER không được tạo sản phẩm');

    // CASHIER sửa sản phẩm -> 403
    res = await req('PUT', '/api/products/1', { sku: 'TEST_NO_ROLE', name: 'Test', unit: 'Cái', sale_price: 10000 }, cashierCookie, cashierCsrf);
    assert.strictEqual(res.status, 403, 'CASHIER không được sửa sản phẩm');

    // CASHIER đổi trạng thái -> 403
    res = await req('PATCH', '/api/products/1/toggle-active', { is_active: false }, cashierCookie, cashierCsrf);
    assert.strictEqual(res.status, 403, 'CASHIER không được đổi trạng thái sản phẩm');

    // CASHIER xóa sản phẩm -> 403
    res = await req('DELETE', '/api/products/1', null, cashierCookie, cashierCsrf);
    assert.strictEqual(res.status, 403, 'CASHIER không được xóa sản phẩm');
  });

  let prodAId = null;
  let prodBId = null;

  await t.test('4. Thêm sản phẩm mới (SKU, tên, đơn vị, giá bán; tồn ban đầu mặc định 0)', async () => {
    // Thêm sản phẩm A, gửi kèm stock_quantity = 50 để kiểm tra chống sửa tồn trực tiếp
    const payload = {
      sku: 'SKU_ALPHA',
      name: 'Bút Bi Thiên Long',
      unit: 'Cây',
      sale_price: 5000,
      stock_quantity: 50
    };
    let res = await req('POST', '/api/products', payload, managerCookie, managerCsrf);
    assert.strictEqual(res.status, 201, 'Thêm sản phẩm A thất bại');
    assert.ok(res.data.id, 'Phải trả về ID sản phẩm vừa tạo');
    prodAId = res.data.id;

    // Kiểm tra CSDL: tồn ban đầu phải bằng 0 và is_active = 1
    let detailRes = await req('GET', `/api/products/${prodAId}`, null, managerCookie);
    assert.strictEqual(detailRes.status, 200);
    assert.strictEqual(detailRes.data.sku, 'SKU_ALPHA');
    assert.strictEqual(detailRes.data.name, 'Bút Bi Thiên Long');
    assert.strictEqual(detailRes.data.unit, 'Cây');
    assert.strictEqual(Number(detailRes.data.sale_price), 5000);
    assert.strictEqual(Number(detailRes.data.stock_quantity), 0, 'Tồn ban đầu phải bằng 0, không được nhận từ client');
    assert.strictEqual(Number(detailRes.data.is_active), 1, 'Trạng thái ban đầu phải là đang hoạt động');

    // Thêm sản phẩm B
    let resB = await req('POST', '/api/products', {
      sku: 'SKU_BETA',
      name: 'Tập Vở 96 Trang',
      unit: 'Cuốn',
      sale_price: 12000.50
    }, managerCookie, managerCsrf);
    assert.strictEqual(resB.status, 201);
    prodBId = resB.data.id;
  });

  await t.test('5. Kiểm tra chống trùng SKU khi thêm mới', async () => {
    const dupPayload = {
      sku: 'SKU_ALPHA', // trùng với sản phẩm A
      name: 'Sản phẩm trùng mã',
      unit: 'Cái',
      sale_price: 20000
    };
    let res = await req('POST', '/api/products', dupPayload, managerCookie, managerCsrf);
    assert.strictEqual(res.status, 400, 'Phải từ chối thêm sản phẩm trùng SKU');
    assert.ok(res.data.error.includes('SKU'), 'Thông báo lỗi phải đề cập đến mã SKU');
  });

  await t.test('6. Sửa SKU theo ID nội bộ và kiểm tra SKU duy nhất', async () => {
    // 6.1. Đổi SKU của sản phẩm A sang SKU mới hợp lệ
    let updateRes = await req('PUT', `/api/products/${prodAId}`, {
      sku: 'SKU_ALPHA_NEW',
      name: 'Bút Bi Thiên Long Đã Sửa',
      unit: 'Cây',
      sale_price: 6000
    }, managerCookie, managerCsrf);
    assert.strictEqual(updateRes.status, 200, 'Sửa SKU hợp lệ thất bại');

    let checkA = await req('GET', `/api/products/${prodAId}`, null, managerCookie);
    assert.strictEqual(checkA.data.id, prodAId, 'ID nội bộ phải giữ nguyên');
    assert.strictEqual(checkA.data.sku, 'SKU_ALPHA_NEW', 'SKU mới phải được cập nhật');
    assert.strictEqual(checkA.data.name, 'Bút Bi Thiên Long Đã Sửa');
    assert.strictEqual(Number(checkA.data.sale_price), 6000);

    // 6.2. Sửa SKU của sản phẩm A thành SKU của sản phẩm B -> Bị chặn trùng SKU
    let dupRes = await req('PUT', `/api/products/${prodAId}`, {
      sku: 'SKU_BETA', // SKU của sản phẩm B
      name: 'Cố tình trùng SKU',
      unit: 'Cây',
      sale_price: 6000
    }, managerCookie, managerCsrf);
    assert.strictEqual(dupRes.status, 400, 'Phải chặn khi sửa SKU trùng với sản phẩm khác');
    assert.ok(dupRes.data.error.includes('SKU'), 'Báo lỗi trùng SKU');

    // 6.3. Giữ nguyên SKU của chính nó khi cập nhật tên/giá -> Thành công
    let sameSkuRes = await req('PUT', `/api/products/${prodAId}`, {
      sku: 'SKU_ALPHA_NEW',
      name: 'Bút Bi Thiên Long 0.5mm',
      unit: 'Hộp',
      sale_price: 6500
    }, managerCookie, managerCsrf);
    assert.strictEqual(sameSkuRes.status, 200, 'Cập nhật giữ nguyên SKU phải thành công');
  });

  await t.test('7. Kiểm tra giá bán ở backend (từ chối giá âm, =0, sai kiểu, quá 2 số thập phân)', async () => {
    // Giá âm khi thêm mới
    let resNegative = await req('POST', '/api/products', {
      sku: 'TEST_PRICE_NEG', name: 'Test', unit: 'Cái', sale_price: -100
    }, managerCookie, managerCsrf);
    assert.strictEqual(resNegative.status, 400, 'Phải chặn giá bán âm khi POST');

    // Giá bằng 0 khi thêm mới
    let resZero = await req('POST', '/api/products', {
      sku: 'TEST_PRICE_ZERO', name: 'Test', unit: 'Cái', sale_price: 0
    }, managerCookie, managerCsrf);
    assert.strictEqual(resZero.status, 400, 'Phải chặn giá bán bằng 0 khi POST');

    // Giá âm khi sửa (PUT)
    let resPutNeg = await req('PUT', `/api/products/${prodAId}`, {
      sku: 'SKU_ALPHA_NEW', name: 'Test', unit: 'Cái', sale_price: -5000
    }, managerCookie, managerCsrf);
    assert.strictEqual(resPutNeg.status, 400, 'Phải chặn giá bán âm khi PUT');

    // Giá chuỗi không hợp lệ
    let resPutStr = await req('PUT', `/api/products/${prodAId}`, {
      sku: 'SKU_ALPHA_NEW', name: 'Test', unit: 'Cái', sale_price: 'abc'
    }, managerCookie, managerCsrf);
    assert.strictEqual(resPutStr.status, 400, 'Phải chặn giá bán không phải số');

    // Giá có quá 2 chữ số thập phân
    let resPutDec = await req('PUT', `/api/products/${prodAId}`, {
      sku: 'SKU_ALPHA_NEW', name: 'Test', unit: 'Cái', sale_price: 15.999
    }, managerCookie, managerCsrf);
    assert.strictEqual(resPutDec.status, 400, 'Phải chặn giá bán quá 2 chữ số thập phân');

    // Giá vượt quá giới hạn hệ thống
    let resPutOverflow = await req('PUT', `/api/products/${prodAId}`, {
      sku: 'SKU_ALPHA_NEW', name: 'Test', unit: 'Cái', sale_price: 10000000000000
    }, managerCookie, managerCsrf);
    assert.strictEqual(resPutOverflow.status, 400, 'Phải chặn giá vượt quá giới hạn');
  });

  await t.test('8. Không cho sửa tồn kho trực tiếp trong biểu mẫu sản phẩm (PUT)', async () => {
    let putStockRes = await req('PUT', `/api/products/${prodAId}`, {
      sku: 'SKU_ALPHA_NEW',
      name: 'Bút Bi Thiên Long 0.5mm',
      unit: 'Hộp',
      sale_price: 6500,
      stock_quantity: 9999 // Thử gửi trường tồn kho
    }, managerCookie, managerCsrf);
    assert.strictEqual(putStockRes.status, 200);

    let checkStock = await req('GET', `/api/products/${prodAId}`, null, managerCookie);
    assert.strictEqual(Number(checkStock.data.stock_quantity), 0, 'Tồn kho không được thay đổi qua form sửa sản phẩm');
  });

  await t.test('9. Tìm theo SKU/tên và phân trang', async () => {
    // Tìm theo SKU
    let resSku = await req('GET', '/api/products?q=ALPHA&paginate=true', null, managerCookie);
    assert.strictEqual(resSku.status, 200);
    assert.ok(resSku.data.data.some(p => p.sku === 'SKU_ALPHA_NEW'), 'Phải tìm thấy sản phẩm theo SKU');

    // Tìm theo Tên
    let resName = await req('GET', '/api/products?q=Bút+Bi&paginate=true', null, managerCookie);
    assert.strictEqual(resName.status, 200);
    assert.ok(resName.data.data.some(p => p.name.includes('Bút Bi')), 'Phải tìm thấy sản phẩm theo tên');

    // Phân trang
    let resPaging = await req('GET', '/api/products?page=1&limit=1&paginate=true', null, managerCookie);
    assert.strictEqual(resPaging.status, 200);
    assert.strictEqual(resPaging.data.pagination.page, 1);
    assert.strictEqual(resPaging.data.pagination.limit, 1);
    assert.strictEqual(resPaging.data.data.length, 1);
    assert.ok(resPaging.data.pagination.total >= 2);
    assert.ok(resPaging.data.pagination.totalPages >= 2);
  });

  await t.test('10. Ngừng kinh doanh và kích hoạt lại (backend chặn bán mới sản phẩm ngừng KD)', async () => {
    // Nhập hàng cho sản phẩm B để có tồn kho bán
    let inRes = await req('POST', '/api/stock-receipts', {
      receipt_no: 'NH_PROD_01',
      request_key: 'req_nh_01',
      items: [{ product_id: prodBId, quantity: 20, unit_cost: 8000 }]
    }, managerCookie, managerCsrf);
    assert.ok(inRes.status === 201 || inRes.status === 200);

    // 10.1. Ngừng kinh doanh sản phẩm B
    let toggleRes = await req('PATCH', `/api/products/${prodBId}/toggle-active`, { is_active: false }, managerCookie, managerCsrf);
    assert.strictEqual(toggleRes.status, 200);
    assert.strictEqual(toggleRes.data.is_active, 0);

    let checkB = await req('GET', `/api/products/${prodBId}`, null, managerCookie);
    assert.strictEqual(Number(checkB.data.is_active), 0);

    // 10.2. Thử tạo hóa đơn với sản phẩm B đã ngừng kinh doanh -> Bị backend từ chối
    let invRes = await req('POST', '/api/invoices', {
      invoice_no: 'HD_PROD_ERR',
      request_key: 'req_inv_err_' + Date.now(),
      items: [{ product_id: prodBId, quantity: 1, unit_price: 12000.50 }]
    }, managerCookie, managerCsrf);
    assert.strictEqual(invRes.status, 400, 'Backend phải chặn bán mới sản phẩm đã ngừng kinh doanh');
    assert.ok(invRes.data.error.includes('ngừng kinh doanh'), 'Thông báo phải nêu rõ sản phẩm đã ngừng kinh doanh');

    // 10.3. Kích hoạt lại sản phẩm B
    let reactiveRes = await req('PATCH', `/api/products/${prodBId}/toggle-active`, { is_active: true }, managerCookie, managerCsrf);
    assert.strictEqual(reactiveRes.status, 200);
    assert.strictEqual(reactiveRes.data.is_active, 1);

    // 10.4. Bán hàng thành công sau khi kích hoạt lại
    let invSuccessRes = await req('POST', '/api/invoices', {
      invoice_no: 'HD_PROD_OK',
      request_key: 'req_inv_ok_' + Date.now(),
      items: [{ product_id: prodBId, quantity: 2, unit_price: 12000.50 }]
    }, managerCookie, managerCsrf);
    assert.strictEqual(invSuccessRes.status, 201, 'Bán hàng thành công sau khi kích hoạt lại');
  });

  await t.test('11. Điều kiện xóa sản phẩm an toàn (Từ chối khi có chứng từ/còn tồn; Giải thích & gợi ý ngừng kinh doanh; Xóa khi đủ điều kiện)', async () => {
    // 11.1. Thử xóa sản phẩm B (đã có phiếu nhập, hóa đơn, biến động kho)
    let delBRes = await req('DELETE', `/api/products/${prodBId}`, null, managerCookie, managerCsrf);
    assert.strictEqual(delBRes.status, 400, 'Không được xóa sản phẩm đã có giao dịch');
    assert.ok(delBRes.data.error || delBRes.data.message);
    assert.ok(delBRes.data.message.includes('lịch sử giao dịch'), 'Phải giải thích lý do có lịch sử giao dịch');
    assert.ok(delBRes.data.suggest.includes('Ngừng kinh doanh'), 'Phải gợi ý sử dụng Ngừng kinh doanh');
    assert.strictEqual(delBRes.data.can_toggle, true, 'Cung cấp cờ cho phép chuyển trạng thái');

    // Kiểm tra chứng từ của sản phẩm B vẫn nguyên vẹn (Không bị cascade xóa)
    let invCheck = await req('GET', '/api/invoices', null, managerCookie);
    assert.ok(invCheck.data.some(i => i.invoice_no === 'HD_PROD_OK'), 'Hóa đơn cũ không bị xóa cascade');

    // 11.2. Tạo sản phẩm C có tồn kho > 0 nhưng chưa có bán hàng
    let prodCRes = await req('POST', '/api/products', {
      sku: 'SKU_CHARLIE', name: 'Thước Kẻ 20cm', unit: 'Cây', sale_price: 7000
    }, managerCookie, managerCsrf);
    const prodCId = prodCRes.data.id;

    // Nhập hàng cho C
    await req('POST', '/api/stock-receipts', {
      receipt_no: 'NH_PROD_02',
      request_key: 'req_nh_02',
      items: [{ product_id: prodCId, quantity: 5, unit_cost: 4000 }]
    }, managerCookie, managerCsrf);

    // Xóa C -> Bị từ chối do đã có chứng từ phiếu nhập
    let delCRes = await req('DELETE', `/api/products/${prodCId}`, null, managerCookie, managerCsrf);
    assert.strictEqual(delCRes.status, 400);
    assert.ok(delCRes.data.message.includes('phiếu nhập hàng') || delCRes.data.message.includes('lịch sử giao dịch'));
    assert.ok(delCRes.data.suggest.includes('Ngừng kinh doanh'));

    // 11.3. Xóa sản phẩm A: Tồn kho = 0 và CHƯA từng có hóa đơn/phiếu nhập/biến động kho
    let delARes = await req('DELETE', `/api/products/${prodAId}`, null, managerCookie, managerCsrf);
    assert.strictEqual(delARes.status, 200, 'Xóa thành công sản phẩm tồn = 0 và chưa có chứng từ');

    // Kiểm tra sản phẩm A đã không còn trong CSDL
    let getARes = await req('GET', `/api/products/${prodAId}`, null, managerCookie);
    assert.strictEqual(getARes.status, 404, 'Sản phẩm A đã bị xóa vĩnh viễn');
  });

  await t.test('12. Dọn dẹp máy chủ kiểm thử', async () => {
    if (serverProcess) {
      serverProcess.kill();
    }
  });
});
