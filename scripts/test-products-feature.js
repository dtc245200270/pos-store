require('dotenv').config();
const assert = require('assert');
const { spawn } = require('child_process');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const PORT = 3009;
const BASE_URL = `http://127.0.0.1:${PORT}`;

let serverProcess;

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

  let text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }

  return { status: res.status, headers: res.headers, data, text, cookie: newCookie };
};

async function runTests() {
  console.log('=== BẮT ĐẦU KIỂM THỬ TÍNH NĂNG TRANG SẢN PHẨM ===\n');

  const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'pos_app',
    password: process.env.DB_PASSWORD || '290729',
    database: 'pos_store_test',
    timezone: '+07:00'
  });

  // Chuẩn bị tài khoản test trong pos_store_test
  const hash = await bcrypt.hash('password123', 10);
  await pool.query('DELETE FROM users WHERE username IN (?, ?)', ['prod_test_mgr', 'prod_test_csh']);
  await pool.query(
    'INSERT INTO users (username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, 1)',
    ['prod_test_mgr', hash, 'Quản Lý Test SP', 'MANAGER']
  );
  await pool.query(
    'INSERT INTO users (username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, 1)',
    ['prod_test_csh', hash, 'Thu Ngân Test SP', 'CASHIER']
  );

  // Khởi động server test
  console.log(`1. Khởi động server test trên cổng ${PORT}...`);
  serverProcess = spawn('node', ['server.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DB_NAME: 'pos_store_test',
      SESSION_SECRET: 'test_products_secret_999'
    }
  });

  await new Promise((resolve) => {
    serverProcess.stdout.on('data', (d) => {
      if (d.toString().includes('Website đang chạy')) resolve();
    });
    setTimeout(resolve, 3000);
  });
  console.log('✓ Server test đã sẵn sàng.\n');

  try {
    // Đăng nhập Manager và Cashier
    const cMgr = await req('GET', '/api/auth/csrf');
    const lMgr = await req('POST', '/api/auth/login', { username: 'prod_test_mgr', password: 'password123' }, cMgr.cookie, cMgr.data.csrfToken);
    assert.strictEqual(lMgr.status, 200, 'Login Manager failed');
    const mgrCookie = lMgr.cookie;
    const mgrCsrf = lMgr.data.csrfToken;

    const cCsh = await req('GET', '/api/auth/csrf');
    const lCsh = await req('POST', '/api/auth/login', { username: 'prod_test_csh', password: 'password123' }, cCsh.cookie, cCsh.data.csrfToken);
    assert.strictEqual(lCsh.status, 200, 'Login Cashier failed');
    const cshCookie = lCsh.cookie;
    const cshCsrf = lCsh.data.csrfToken;

    console.log('✓ Đăng nhập thành công Manager và Cashier.\n');

    // Dọn dẹp các SKU test trước đó
    const testSkus = ['SP_TEST_NEW1', 'SP_TEST_NEW2', 'SP_TEST_NEW2_MODIFIED', 'SP_TEST_PRICE', 'SP_TEST_DELETE', 'SP_TEST_STOCK_DEL'];
    await pool.query('DELETE FROM products WHERE sku IN (?)', [testSkus]);

    // ------------------------------------------------------------------------
    // TEST 1: THÊM MỚI SẢN PHẨM - TỒN BAN ĐẦU = 0, ACTIVE = 1
    // ------------------------------------------------------------------------
    console.log('--- TEST 1: Thêm mới sản phẩm (Tồn ban đầu = 0, Active = 1) ---');
    const addRes = await req('POST', '/api/products', {
      sku: 'SP_TEST_NEW1',
      name: 'Sản Phẩm Test Mới 1',
      unit: 'Hộp',
      sale_price: 50000
    }, mgrCookie, mgrCsrf);

    assert.strictEqual(addRes.status, 201, 'Tạo sản phẩm thành công');
    const prodId1 = addRes.data.id;
    assert.ok(prodId1 > 0);

    const [rows1] = await pool.query('SELECT * FROM products WHERE id = ?', [prodId1]);
    assert.strictEqual(rows1[0].stock_quantity, 0, 'Tồn kho ban đầu phải là 0');
    assert.strictEqual(rows1[0].is_active, 1, 'Trạng thái ban đầu phải là 1 (Active)');
    console.log('✓ Thêm mới thành công: SKU SP_TEST_NEW1, tồn = 0, is_active = 1.\n');

    // ------------------------------------------------------------------------
    // TEST 2: KIỂM TRA SKU TRÙNG (KHI THÊM VÀ KHI SỬA)
    // ------------------------------------------------------------------------
    console.log('--- TEST 2: Kiểm tra SKU trùng ---');
    // Thêm mới trùng SKU
    const dupAddRes = await req('POST', '/api/products', {
      sku: 'SP_TEST_NEW1',
      name: 'Sản Phẩm Trùng SKU',
      unit: 'Cái',
      sale_price: 20000
    }, mgrCookie, mgrCsrf);
    assert.strictEqual(dupAddRes.status, 400, 'Phải từ chối thêm mới trùng SKU');
    assert.ok(dupAddRes.data.error.includes('SKU đã tồn tại'));

    // Tạo sản phẩm 2 để test sửa trùng
    const addRes2 = await req('POST', '/api/products', {
      sku: 'SP_TEST_NEW2',
      name: 'Sản Phẩm Test 2',
      unit: 'Cái',
      sale_price: 30000
    }, mgrCookie, mgrCsrf);
    const prodId2 = addRes2.data.id;

    // Sửa sản phẩm 2 với SKU của sản phẩm 1
    const dupEditRes = await req('PUT', `/api/products/${prodId2}`, {
      sku: 'SP_TEST_NEW1',
      name: 'Sản Phẩm 2 Đổi Trùng SKU',
      unit: 'Cái',
      sale_price: 30000
    }, mgrCookie, mgrCsrf);
    assert.strictEqual(dupEditRes.status, 400, 'Phải từ chối sửa thành SKU của sản phẩm khác');
    assert.ok(dupEditRes.data.error.includes('SKU đã tồn tại ở sản phẩm khác'));
    console.log('✓ Chặn SKU trùng khi thêm mới và sửa thành công.\n');

    // ------------------------------------------------------------------------
    // TEST 3: SỬA SKU THEO ID NỘI BỘ
    // ------------------------------------------------------------------------
    console.log('--- TEST 3: Sửa SKU theo ID nội bộ ---');
    const validEditRes = await req('PUT', `/api/products/${prodId2}`, {
      sku: 'SP_TEST_NEW2_MODIFIED',
      name: 'Sản Phẩm 2 Tên Mới',
      unit: 'Thùng',
      sale_price: 35000
    }, mgrCookie, mgrCsrf);
    assert.strictEqual(validEditRes.status, 200, 'Cập nhật sản phẩm thành công');

    const [rows2] = await pool.query('SELECT sku, name, unit, sale_price FROM products WHERE id = ?', [prodId2]);
    assert.strictEqual(rows2[0].sku, 'SP_TEST_NEW2_MODIFIED');
    assert.strictEqual(rows2[0].name, 'Sản Phẩm 2 Tên Mới');
    assert.strictEqual(rows2[0].unit, 'Thùng');
    assert.strictEqual(Number(rows2[0].sale_price), 35000);
    console.log('✓ Sửa SKU và thông tin theo ID nội bộ thành công.\n');

    // ------------------------------------------------------------------------
    // TEST 4: KIỂM TRA GIÁ BÁN SAI (ÂM, 0, KHÔNG PHẢI SỐ)
    // ------------------------------------------------------------------------
    console.log('--- TEST 4: Kiểm tra giá bán sai ---');
    // Giá âm
    const negPriceRes = await req('POST', '/api/products', {
      sku: 'SP_TEST_PRICE',
      name: 'Sản Phẩm Giá Âm',
      unit: 'Cái',
      sale_price: -1000
    }, mgrCookie, mgrCsrf);
    assert.strictEqual(negPriceRes.status, 400);

    // Giá 0
    const zeroPriceRes = await req('POST', '/api/products', {
      sku: 'SP_TEST_PRICE',
      name: 'Sản Phẩm Giá 0',
      unit: 'Cái',
      sale_price: 0
    }, mgrCookie, mgrCsrf);
    assert.strictEqual(zeroPriceRes.status, 400);

    // Giá chữ
    const textPriceRes = await req('POST', '/api/products', {
      sku: 'SP_TEST_PRICE',
      name: 'Sản Phẩm Giá Chữ',
      unit: 'Cái',
      sale_price: 'khongphaiso'
    }, mgrCookie, mgrCsrf);
    assert.strictEqual(textPriceRes.status, 400);
    console.log('✓ Chặn giá âm, giá 0 và giá không phải số ở backend thành công.\n');

    // ------------------------------------------------------------------------
    // TEST 5: KHÔNG CHO SỬA TỒN TRỰC TIẾP TRONG BIỂU MẪU SẢN PHẨM
    // ------------------------------------------------------------------------
    console.log('--- TEST 5: Không cho sửa tồn trực tiếp trong biểu mẫu sản phẩm ---');
    await req('PUT', `/api/products/${prodId1}`, {
      sku: 'SP_TEST_NEW1',
      name: 'Sản Phẩm 1 Sửa Tồn',
      unit: 'Hộp',
      sale_price: 50000,
      stock_quantity: 9999
    }, mgrCookie, mgrCsrf);

    const [rowsAfterStockEdit] = await pool.query('SELECT stock_quantity FROM products WHERE id = ?', [prodId1]);
    assert.strictEqual(rowsAfterStockEdit[0].stock_quantity, 0, 'stock_quantity không được phép bị thay đổi qua PUT /api/products');
    console.log('✓ Tồn kho không bị thay đổi trực tiếp qua API sản phẩm.\n');

    // ------------------------------------------------------------------------
    // TEST 6: PHÂN QUYỀN - CHỈ MANAGER ĐƯỢC CHỈNH SỬA, CASHIER BỊ TỪ CHỐI
    // ------------------------------------------------------------------------
    console.log('--- TEST 6: Phân quyền - CASHIER bị từ chối 403 Forbidden ---');
    const cshAdd = await req('POST', '/api/products', {
      sku: 'CSH_TEST',
      name: 'Cashier Add',
      unit: 'Cái',
      sale_price: 10000
    }, cshCookie, cshCsrf);
    assert.strictEqual(cshAdd.status, 403);

    const cshEdit = await req('PUT', `/api/products/${prodId1}`, {
      sku: 'SP_TEST_NEW1',
      name: 'Cashier Edit',
      unit: 'Hộp',
      sale_price: 55000
    }, cshCookie, cshCsrf);
    assert.strictEqual(cshEdit.status, 403);

    const cshToggle = await req('PATCH', `/api/products/${prodId1}/toggle-active`, {
      is_active: false
    }, cshCookie, cshCsrf);
    assert.strictEqual(cshToggle.status, 403);

    const cshDel = await req('DELETE', `/api/products/${prodId1}`, null, cshCookie, cshCsrf);
    assert.strictEqual(cshDel.status, 403);
    console.log('✓ Thu ngân (CASHIER) bị chặn hoàn toàn các thao tác thêm, sửa, khóa, xóa.\n');

    // ------------------------------------------------------------------------
    // TEST 7: TÌM THEO SKU/TÊN VÀ PHÂN TRANG
    // ------------------------------------------------------------------------
    console.log('--- TEST 7: Tìm kiếm theo SKU/tên & Phân trang ---');
    // Phân trang
    const pageRes = await req('GET', '/api/products?page=1&limit=2', null, mgrCookie);
    assert.strictEqual(pageRes.status, 200);
    assert.ok(pageRes.data.pagination, 'Phải có object pagination');
    assert.strictEqual(pageRes.data.pagination.page, 1);
    assert.strictEqual(pageRes.data.pagination.limit, 2);
    assert.ok(pageRes.data.pagination.total >= 2);
    assert.strictEqual(pageRes.data.data.length, 2);

    // Tìm theo SKU
    const searchSkuRes = await req('GET', '/api/products?q=SP_TEST_NEW1&page=1&limit=10', null, mgrCookie);
    assert.ok(searchSkuRes.data.data.some(p => p.sku === 'SP_TEST_NEW1'));

    // Tìm theo tên
    const searchNameRes = await req('GET', '/api/products?q=Sản Phẩm 2 Tên Mới&page=1&limit=10', null, mgrCookie);
    assert.ok(searchNameRes.data.data.some(p => p.sku === 'SP_TEST_NEW2_MODIFIED'));

    // Lọc trạng thái
    const activeFilterRes = await req('GET', '/api/products?status=active&page=1&limit=10', null, mgrCookie);
    assert.ok(activeFilterRes.data.data.every(p => p.is_active === 1));
    console.log('✓ Tìm theo SKU, tên, lọc trạng thái và phân trang hoạt động hoàn hảo.\n');

    // ------------------------------------------------------------------------
    // TEST 8: NGỪNG KINH DOANH, CHẶN BÁN MỚI VÀ KÍCH HOẠT LẠI
    // ------------------------------------------------------------------------
    console.log('--- TEST 8: Ngừng kinh doanh, chặn bán mới và kích hoạt lại ---');
    // Cấp tồn 10 cho sản phẩm prodId1 để test bán hàng
    await pool.query('UPDATE products SET stock_quantity = 10 WHERE id = ?', [prodId1]);

    // Ngừng kinh doanh sản phẩm prodId1
    const toggleOff = await req('PATCH', `/api/products/${prodId1}/toggle-active`, {
      is_active: false
    }, mgrCookie, mgrCsrf);
    assert.strictEqual(toggleOff.status, 200);

    const [rowInactive] = await pool.query('SELECT is_active FROM products WHERE id = ?', [prodId1]);
    assert.strictEqual(rowInactive[0].is_active, 0, 'Sản phẩm đã chuyển sang is_active = 0');

    // Thử tạo hóa đơn bán sản phẩm đã ngừng kinh doanh
    const invNo1 = `HD_INACTIVE_${Date.now()}`;
    const invoiceAttempt = await req('POST', '/api/invoices', {
      invoice_no: invNo1,
      request_key: `REQ_INACTIVE_${Date.now()}`,
      items: [{ product_id: prodId1, quantity: 1, unit_price: 50000 }]
    }, cshCookie, cshCsrf);
    assert.strictEqual(invoiceAttempt.status, 400, 'Backend phải từ chối bán sản phẩm ngừng kinh doanh');
    assert.ok(invoiceAttempt.data.error && invoiceAttempt.data.error.includes('ngừng kinh doanh'));

    // Kích hoạt lại
    const toggleOn = await req('PATCH', `/api/products/${prodId1}/toggle-active`, {
      is_active: true
    }, mgrCookie, mgrCsrf);
    assert.strictEqual(toggleOn.status, 200);

    const [rowActive] = await pool.query('SELECT is_active FROM products WHERE id = ?', [prodId1]);
    assert.strictEqual(rowActive[0].is_active, 1, 'Sản phẩm đã được kích hoạt lại');
    console.log('✓ Ngừng kinh doanh chặn bán mới ở backend và kích hoạt lại thành công.\n');

    // ------------------------------------------------------------------------
    // TEST 9: ĐIỀU KIỆN XÓA SẢN PHẨM & GIẢI THÍCH LÝ DO
    // ------------------------------------------------------------------------
    console.log('--- TEST 9: Điều kiện xóa sản phẩm & giải thích lý do ---');
    // 9.1: Sản phẩm có tồn > 0 -> Không được xóa
    const delStockRes = await req('DELETE', `/api/products/${prodId1}`, null, mgrCookie, mgrCsrf);
    assert.strictEqual(delStockRes.status, 400, 'Phải từ chối xóa sản phẩm còn tồn kho');
    assert.ok(delStockRes.data.error.includes('tồn kho bằng 0'));
    assert.ok(delStockRes.data.suggest.includes('Ngừng kinh doanh'));
    console.log('✓ Chặn xóa sản phẩm còn tồn kho (>0) và gợi ý Ngừng kinh doanh.');

    // 9.2: Tạo giao dịch hóa đơn cho prodId1
    const invNo2 = `HD_PROD_SUCC_${Date.now()}`;
    const invoiceSuccess = await req('POST', '/api/invoices', {
      invoice_no: invNo2,
      request_key: `REQ_INVOICE_PROD_${Date.now()}`,
      items: [{ product_id: prodId1, quantity: 10, unit_price: 50000 }]
    }, cshCookie, cshCsrf);
    assert.strictEqual(invoiceSuccess.status, 201, 'Bán hết 10 sản phẩm để đưa tồn về 0');

    // Tồn bây giờ đã về 0, nhưng đã CÓ GIAO DỊCH (hóa đơn, biến động kho)
    const [rowZeroStock] = await pool.query('SELECT stock_quantity FROM products WHERE id = ?', [prodId1]);
    assert.strictEqual(rowZeroStock[0].stock_quantity, 0, 'Tồn kho đã về 0');

    const delTxRes = await req('DELETE', `/api/products/${prodId1}`, null, mgrCookie, mgrCsrf);
    assert.strictEqual(delTxRes.status, 400, 'Phải từ chối xóa sản phẩm đã có lịch sử chứng từ');
    assert.strictEqual(delTxRes.data.error, 'Sản phẩm đã có lịch sử giao dịch. Vui lòng dùng chức năng Khóa.');
    assert.ok(delTxRes.data.message.includes('hóa đơn bán hàng') || delTxRes.data.message.includes('biến động kho'));
    console.log('✓ Chặn xóa sản phẩm đã có lịch sử chứng từ/biến động kho dù tồn đã về 0.');

    // 9.3: Tạo sản phẩm mới chưa từng phát sinh chứng từ, tồn = 0 -> Xóa thành công
    const addClean = await req('POST', '/api/products', {
      sku: 'SP_TEST_DELETE',
      name: 'Sản Phẩm Chưa Giao Dịch',
      unit: 'Cái',
      sale_price: 15000
    }, mgrCookie, mgrCsrf);
    const cleanId = addClean.data.id;

    const delCleanRes = await req('DELETE', `/api/products/${cleanId}`, null, mgrCookie, mgrCsrf);
    assert.strictEqual(delCleanRes.status, 200, 'Xóa thành công sản phẩm thỏa mãn điều kiện');
    assert.strictEqual(delCleanRes.data.message, 'Xóa sản phẩm thành công');

    const [cleanCheck] = await pool.query('SELECT id FROM products WHERE id = ?', [cleanId]);
    assert.strictEqual(cleanCheck.length, 0, 'Sản phẩm đã được xóa khỏi database');
    console.log('✓ Xóa thành công sản phẩm có tồn = 0 và không có giao dịch.');

    // 9.4: Kiểm tra không cascade xóa lịch sử: Hóa đơn của prodId1 vẫn nguyên vẹn
    const [invRows] = await pool.query('SELECT id, invoice_no FROM invoices WHERE invoice_no = ?', [invoiceSuccess.data.invoice_no]);
    assert.strictEqual(invRows.length, 1, 'Hóa đơn phải còn nguyên');
    const [invItemRows] = await pool.query('SELECT id, product_id, quantity FROM invoice_items WHERE invoice_id = ?', [invRows[0].id]);
    assert.strictEqual(invItemRows.length, 1, 'Chi tiết hóa đơn phải còn nguyên');
    console.log('✓ Không cascade xóa lịch sử: Chứng từ và biến động kho được bảo toàn 100%.\n');

    console.log('=== TẤT CẢ 9 BÀI KIỂM THỬ TRANG SẢN PHẨM ĐÃ ĐẠT 100% ===');
  } catch (error) {
    console.error('❌ Kiểm thử thất bại:', error);
    process.exitCode = 1;
  } finally {
    if (serverProcess) {
      serverProcess.kill();
    }
    await pool.end();
  }
}

runTests();
