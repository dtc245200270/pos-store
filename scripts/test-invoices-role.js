require('dotenv').config();
const assert = require('assert');
const { spawn } = require('child_process');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const TEST_PORT = 3006;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

async function run() {
  console.log('=== KIỂM THỬ PHÂN QUYỀN VÀ TÍNH NĂNG HÓA ĐƠN THEO VAI TRÒ ===\n');

  // 1. Chuẩn bị dữ liệu kiểm thử trong pos_store_test
  const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'pos_app',
    password: process.env.DB_PASSWORD || '290729',
    database: 'pos_store_test',
    timezone: '+07:00'
  });

  const hash = await bcrypt.hash('password123', 10);

  // Tạo / đảm bảo có 1 Manager và 2 Cashiers riêng biệt
  await pool.query('INSERT IGNORE INTO users (username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?)',
    ['inv_mgr', hash, 'Quản Lý Cửa Hàng', 'MANAGER', 1]);
  await pool.query('INSERT IGNORE INTO users (username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?)',
    ['inv_csh1', hash, 'Thu Ngân Số 1', 'CASHIER', 1]);
  await pool.query('INSERT IGNORE INTO users (username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?)',
    ['inv_csh2', hash, 'Thu Ngân Số 2', 'CASHIER', 1]);

  const [mgrUsers] = await pool.query('SELECT id FROM users WHERE username = ?', ['inv_mgr']);
  const [csh1Users] = await pool.query('SELECT id FROM users WHERE username = ?', ['inv_csh1']);
  const [csh2Users] = await pool.query('SELECT id FROM users WHERE username = ?', ['inv_csh2']);

  const mgrId = mgrUsers[0].id;
  const csh1Id = csh1Users[0].id;
  const csh2Id = csh2Users[0].id;

  // Tạo sản phẩm để bán
  const [prodCheck] = await pool.query('SELECT id FROM products WHERE sku = ?', ['TEST_INV_PROD']);
  let prodId;
  if (prodCheck.length === 0) {
    const [insProd] = await pool.query(
      'INSERT INTO products (sku, name, unit, sale_price, stock_quantity, is_active) VALUES (?, ?, ?, ?, ?, ?)',
      ['TEST_INV_PROD', 'Sản Phẩm Hóa Đơn Test', 'Hộp', 100000, 500, 1]
    );
    prodId = insProd.insertId;
  } else {
    prodId = prodCheck[0].id;
    await pool.query('UPDATE products SET stock_quantity = 500, sale_price = 100000, name = "Sản Phẩm Hóa Đơn Test", unit = "Hộp", is_active = 1 WHERE id = ?', [prodId]);
  }

  await pool.end();

  // 2. Khởi động server test trên port TEST_PORT
  console.log(`1. Khởi động server kiểm thử trên cổng ${TEST_PORT}...`);
  const serverProcess = spawn('node', ['server.js'], {
    env: { ...process.env, DB_NAME: 'pos_store_test', SESSION_SECRET: 'test_inv_secret_123', PORT: String(TEST_PORT), METRICS_PORT: '0' }
  });

  await new Promise((resolve) => {
    serverProcess.stdout.on('data', (d) => {
      if (d.toString().includes('Website đang chạy')) resolve();
    });
    setTimeout(resolve, 3000);
  });
  console.log('✓ Server kiểm thử đã khởi động thành công.\n');

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

  try {
    // Đăng nhập 3 tài khoản: Quản lý, Thu ngân 1, Thu ngân 2
    console.log('--- Đăng nhập 3 tài khoản (1 Quản lý, 2 Thu ngân) ---');
    // Manager
    const cMgr = await req('GET', '/api/auth/csrf');
    const lMgr = await req('POST', '/api/auth/login', { username: 'inv_mgr', password: 'password123' }, cMgr.cookie, cMgr.data.csrfToken);
    assert.strictEqual(lMgr.status, 200, 'Manager đăng nhập thành công');
    const mgrCookie = lMgr.cookie;
    const mgrCsrf = lMgr.data.csrfToken;

    // Cashier 1
    const cCsh1 = await req('GET', '/api/auth/csrf');
    const lCsh1 = await req('POST', '/api/auth/login', { username: 'inv_csh1', password: 'password123' }, cCsh1.cookie, cCsh1.data.csrfToken);
    assert.strictEqual(lCsh1.status, 200, 'Cashier 1 đăng nhập thành công');
    const csh1Cookie = lCsh1.cookie;
    const csh1Csrf = lCsh1.data.csrfToken;

    // Cashier 2
    const cCsh2 = await req('GET', '/api/auth/csrf');
    const lCsh2 = await req('POST', '/api/auth/login', { username: 'inv_csh2', password: 'password123' }, cCsh2.cookie, cCsh2.data.csrfToken);
    assert.strictEqual(lCsh2.status, 200, 'Cashier 2 đăng nhập thành công');
    const csh2Cookie = lCsh2.cookie;
    const csh2Csrf = lCsh2.data.csrfToken;

    console.log('✓ Đã đăng nhập 3 tài khoản.\n');

    // Tạo hóa đơn cho từng tài khoản
    console.log('--- Tạo hóa đơn cho từng tài khoản ---');
    const nowTime = Date.now();
    const invNoMgr = `HD_MGR_${nowTime}`;
    const invNoCsh1_A = `HD_CSH1_A_${nowTime}`;
    const invNoCsh1_B = `HD_CSH1_B_${nowTime}`;
    const invNoCsh2_A = `HD_CSH2_A_${nowTime}`;

    // Manager tạo HD_MGR
    const resMgr = await req('POST', '/api/invoices', {
      invoice_no: invNoMgr,
      request_key: `key_mgr_${nowTime}`,
      items: [{ product_id: prodId, quantity: 1, unit_price: 100000 }]
    }, mgrCookie, mgrCsrf);
    assert.strictEqual(resMgr.status, 201, 'Manager tạo hóa đơn thành công');
    const idMgr = resMgr.data.id;

    // Cashier 1 tạo HD_CSH1_A
    const resCsh1_A = await req('POST', '/api/invoices', {
      invoice_no: invNoCsh1_A,
      request_key: `key_csh1_a_${nowTime}`,
      items: [{ product_id: prodId, quantity: 2, unit_price: 100000 }]
    }, csh1Cookie, csh1Csrf);
    assert.strictEqual(resCsh1_A.status, 201, 'Cashier 1 tạo hóa đơn A thành công');
    const idCsh1_A = resCsh1_A.data.id;

    // Cashier 1 tạo HD_CSH1_B
    const resCsh1_B = await req('POST', '/api/invoices', {
      invoice_no: invNoCsh1_B,
      request_key: `key_csh1_b_${nowTime}`,
      items: [{ product_id: prodId, quantity: 1, unit_price: 100000 }]
    }, csh1Cookie, csh1Csrf);
    assert.strictEqual(resCsh1_B.status, 201, 'Cashier 1 tạo hóa đơn B thành công');
    const idCsh1_B = resCsh1_B.data.id;

    // Cashier 2 tạo HD_CSH2_A
    const resCsh2_A = await req('POST', '/api/invoices', {
      invoice_no: invNoCsh2_A,
      request_key: `key_csh2_a_${nowTime}`,
      items: [{ product_id: prodId, quantity: 3, unit_price: 100000 }]
    }, csh2Cookie, csh2Csrf);
    assert.strictEqual(resCsh2_A.status, 201, 'Cashier 2 tạo hóa đơn A thành công');
    const idCsh2_A = resCsh2_A.data.id;

    console.log(`✓ Đã tạo 4 hóa đơn:`);
    console.log(`  - Quản lý: ID ${idMgr} (${invNoMgr})`);
    console.log(`  - Thu ngân 1: ID ${idCsh1_A} (${invNoCsh1_A}), ID ${idCsh1_B} (${invNoCsh1_B})`);
    console.log(`  - Thu ngân 2: ID ${idCsh2_A} (${invNoCsh2_A})\n`);

    // ------------------------------------------------------------------------
    // TEST 1: PHÂN QUYỀN DANH SÁCH HÓA ĐƠN
    // ------------------------------------------------------------------------
    console.log('--- TEST 1: Phân quyền danh sách hóa đơn theo vai trò ---');
    // Manager xem danh sách: thấy tất cả
    const listMgr = await req('GET', '/api/invoices?page=1&limit=50', null, mgrCookie);
    assert.strictEqual(listMgr.status, 200);
    const mgrInvoices = listMgr.data.invoices;
    const mgrIds = mgrInvoices.map(i => i.id);
    assert.ok(mgrIds.includes(idMgr), 'Quản lý phải thấy hóa đơn của mình');
    assert.ok(mgrIds.includes(idCsh1_A), 'Quản lý phải thấy hóa đơn của Thu ngân 1 (A)');
    assert.ok(mgrIds.includes(idCsh1_B), 'Quản lý phải thấy hóa đơn của Thu ngân 1 (B)');
    assert.ok(mgrIds.includes(idCsh2_A), 'Quản lý phải thấy hóa đơn của Thu ngân 2 (A)');
    console.log('✓ Quản lý xem toàn bộ hóa đơn thành công.');

    // Cashier 1 xem danh sách: chỉ thấy của Cashier 1
    const listCsh1 = await req('GET', '/api/invoices?page=1&limit=50', null, csh1Cookie);
    assert.strictEqual(listCsh1.status, 200);
    const csh1Invoices = listCsh1.data.invoices;
    const csh1Ids = csh1Invoices.map(i => i.id);
    assert.ok(csh1Ids.includes(idCsh1_A), 'Thu ngân 1 thấy hóa đơn của mình (A)');
    assert.ok(csh1Ids.includes(idCsh1_B), 'Thu ngân 1 thấy hóa đơn của mình (B)');
    assert.ok(!csh1Ids.includes(idMgr), 'Thu ngân 1 TUYỆT ĐỐI KHÔNG thấy hóa đơn của Quản lý');
    assert.ok(!csh1Ids.includes(idCsh2_A), 'Thu ngân 1 TUYỆT ĐỐI KHÔNG thấy hóa đơn của Thu ngân 2');
    console.log('✓ Thu ngân 1 chỉ thấy hóa đơn do chính mình lập.');

    // Cashier 2 xem danh sách: chỉ thấy của Cashier 2
    const listCsh2 = await req('GET', '/api/invoices?page=1&limit=50', null, csh2Cookie);
    assert.strictEqual(listCsh2.status, 200);
    const csh2Invoices = listCsh2.data.invoices;
    const csh2Ids = csh2Invoices.map(i => i.id);
    assert.ok(csh2Ids.includes(idCsh2_A), 'Thu ngân 2 thấy hóa đơn của mình (A)');
    assert.ok(!csh2Ids.includes(idMgr), 'Thu ngân 2 TUYỆT ĐỐI KHÔNG thấy hóa đơn của Quản lý');
    assert.ok(!csh2Ids.includes(idCsh1_A), 'Thu ngân 2 TUYỆT ĐỐI KHÔNG thấy hóa đơn của Thu ngân 1 (A)');
    assert.ok(!csh2Ids.includes(idCsh1_B), 'Thu ngân 2 TUYỆT ĐỐI KHÔNG thấy hóa đơn của Thu ngân 1 (B)');
    console.log('✓ Thu ngân 2 chỉ thấy hóa đơn do chính mình lập.\n');

    // ------------------------------------------------------------------------
    // TEST 2: KIỂM TRA QUYỀN SỞ HỮU CHI TIẾT & CASHIER THAY ĐỔI ID BẰNG URL/API
    // ------------------------------------------------------------------------
    console.log('--- TEST 2: Kiểm tra quyền sở hữu chi tiết (truy cập trực tiếp API bằng ID) ---');
    // Quản lý xem chi tiết bất kỳ hóa đơn nào: đều 200
    const dMgr_Mgr = await req('GET', `/api/invoices/${idMgr}`, null, mgrCookie);
    assert.strictEqual(dMgr_Mgr.status, 200, 'Quản lý xem chi tiết hóa đơn Quản lý');
    const dMgr_Csh1 = await req('GET', `/api/invoices/${idCsh1_A}`, null, mgrCookie);
    assert.strictEqual(dMgr_Csh1.status, 200, 'Quản lý xem chi tiết hóa đơn Thu ngân 1');
    const dMgr_Csh2 = await req('GET', `/api/invoices/${idCsh2_A}`, null, mgrCookie);
    assert.strictEqual(dMgr_Csh2.status, 200, 'Quản lý xem chi tiết hóa đơn Thu ngân 2');
    console.log('✓ Quản lý truy cập trực tiếp mọi hóa đơn bằng ID thành công.');

    // Cashier 1 xem hóa đơn của mình: 200
    const dCsh1_Own = await req('GET', `/api/invoices/${idCsh1_A}`, null, csh1Cookie);
    assert.strictEqual(dCsh1_Own.status, 200, 'Thu ngân 1 xem được hóa đơn của chính mình');

    // Cashier 1 đổi ID sang hóa đơn của Cashier 2: 404
    const dCsh1_StealCsh2 = await req('GET', `/api/invoices/${idCsh2_A}`, null, csh1Cookie);
    assert.strictEqual(dCsh1_StealCsh2.status, 404, 'Thu ngân 1 đổi ID sang Thu ngân 2 phải bị từ chối 404');
    assert.ok(dCsh1_StealCsh2.data.error.includes('không có quyền') || dCsh1_StealCsh2.data.error.includes('Không tìm thấy'));
    console.log('✓ Thu ngân 1 thay ID sang hóa đơn Thu ngân 2 bị chặn (404 Not Found).');

    // Cashier 1 đổi ID sang hóa đơn của Manager: 404
    const dCsh1_StealMgr = await req('GET', `/api/invoices/${idMgr}`, null, csh1Cookie);
    assert.strictEqual(dCsh1_StealMgr.status, 404, 'Thu ngân 1 đổi ID sang Quản lý phải bị từ chối 404');
    console.log('✓ Thu ngân 1 thay ID sang hóa đơn Quản lý bị chặn (404 Not Found).');

    // Cashier 2 xem hóa đơn của mình: 200
    const dCsh2_Own = await req('GET', `/api/invoices/${idCsh2_A}`, null, csh2Cookie);
    assert.strictEqual(dCsh2_Own.status, 200, 'Thu ngân 2 xem được hóa đơn của chính mình');

    // Cashier 2 đổi ID sang hóa đơn của Cashier 1: 404
    const dCsh2_StealCsh1 = await req('GET', `/api/invoices/${idCsh1_A}`, null, csh2Cookie);
    assert.strictEqual(dCsh2_StealCsh1.status, 404, 'Thu ngân 2 đổi ID sang Thu ngân 1 phải bị từ chối 404');
    console.log('✓ Thu ngân 2 thay ID sang hóa đơn Thu ngân 1 bị chặn (404 Not Found).');

    // Cashier 2 đổi ID sang hóa đơn của Manager: 404
    const dCsh2_StealMgr = await req('GET', `/api/invoices/${idMgr}`, null, csh2Cookie);
    assert.strictEqual(dCsh2_StealMgr.status, 404, 'Thu ngân 2 đổi ID sang Quản lý phải bị từ chối 404');
    console.log('✓ Thu ngân 2 thay ID sang hóa đơn Quản lý bị chặn (404 Not Found).\n');

    // ------------------------------------------------------------------------
    // TEST 3: TÌM THEO MÃ HÓA ĐƠN & BỘ LỌC NGÀY (GIỜ VIỆT NAM)
    // ------------------------------------------------------------------------
    console.log('--- TEST 3: Tìm theo mã hóa đơn & Lọc theo ngày (Giờ VN) ---');
    // Tìm kiếm theo mã hóa đơn chính xác
    const searchRes = await req('GET', `/api/invoices?q=${invNoCsh1_A}&page=1`, null, mgrCookie);
    assert.strictEqual(searchRes.status, 200);
    assert.strictEqual(searchRes.data.invoices.length, 1, 'Tìm chính xác theo mã hóa đơn trả về đúng 1 kết quả');
    assert.strictEqual(searchRes.data.invoices[0].invoice_no, invNoCsh1_A);
    console.log('✓ Tìm theo mã hóa đơn thành công.');

    // Tìm kiếm một phần mã hóa đơn
    const partialSearch = await req('GET', `/api/invoices?q=HD_CSH1&page=1`, null, mgrCookie);
    assert.strictEqual(partialSearch.status, 200);
    assert.ok(partialSearch.data.invoices.length >= 2, 'Tìm partial mã hóa đơn trả về các hóa đơn khớp');
    console.log('✓ Tìm theo phần ký tự mã hóa đơn thành công.');

    // Thu ngân 1 tìm mã hóa đơn của Thu ngân 2: không thấy (0 kết quả)
    const cshSearchOther = await req('GET', `/api/invoices?q=${invNoCsh2_A}&page=1`, null, csh1Cookie);
    assert.strictEqual(cshSearchOther.status, 200);
    assert.strictEqual(cshSearchOther.data.invoices.length, 0, 'Thu ngân 1 tìm mã của Thu ngân 2 trả về 0 kết quả');
    console.log('✓ Thu ngân tìm mã hóa đơn người khác không lộ kết quả.');

    // Lọc theo ngày hôm nay (theo giờ VN)
    const todayVN = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
    const dateFilterToday = await req('GET', `/api/invoices?from_date=${todayVN}&to_date=${todayVN}&page=1`, null, mgrCookie);
    assert.strictEqual(dateFilterToday.status, 200);
    assert.ok(dateFilterToday.data.invoices.length >= 4, 'Hóa đơn lập hôm nay xuất hiện khi lọc ngày hôm nay theo giờ VN');
    console.log(`✓ Lọc ngày hôm nay (${todayVN} giờ VN) thành công.`);

    // Lọc theo ngày trong tương lai (không có kết quả)
    const dateFilterFuture = await req('GET', `/api/invoices?from_date=2099-01-01&to_date=2099-12-31&page=1`, null, mgrCookie);
    assert.strictEqual(dateFilterFuture.status, 200);
    assert.strictEqual(dateFilterFuture.data.invoices.length, 0);
    assert.strictEqual(dateFilterFuture.data.total, 0, 'Tổng số hóa đơn bằng 0 khi lọc ngày tương lai');
    console.log('✓ Lọc ngày không có hóa đơn trả về mảng rỗng và total = 0.');

    // ------------------------------------------------------------------------
    // TEST 4: QUẢN LÝ LỌC THEO NGƯỜI BÁN & BẢO VỆ PHÂN QUYỀN API SELLERS
    // ------------------------------------------------------------------------
    console.log('\n--- TEST 4: Quản lý lọc theo người bán & Phân quyền API người bán ---');
    // Quản lý gọi API danh sách người bán: 200
    const sellersRes = await req('GET', '/api/invoices/sellers', null, mgrCookie);
    assert.strictEqual(sellersRes.status, 200, 'Quản lý lấy được danh sách người bán');
    assert.ok(Array.isArray(sellersRes.data) && sellersRes.data.length > 0, 'Phải trả về mảng người bán');

    // Thu ngân gọi API danh sách người bán: 403 Forbidden
    const sellersCsh = await req('GET', '/api/invoices/sellers', null, csh1Cookie);
    assert.strictEqual(sellersCsh.status, 403, 'Thu ngân không được truy cập API danh sách người bán');
    console.log('✓ API danh sách người bán được bảo vệ, chỉ Quản lý mới được truy cập.');

    // Quản lý lọc theo Thu ngân 1
    const filterByCsh1 = await req('GET', `/api/invoices?seller_id=${csh1Id}&page=1`, null, mgrCookie);
    assert.strictEqual(filterByCsh1.status, 200);
    const csh1List = filterByCsh1.data.invoices;
    assert.ok(csh1List.length >= 2);
    csh1List.forEach(inv => {
      assert.strictEqual(inv.created_by_name, 'Thu Ngân Số 1', 'Tất cả hóa đơn phải do Thu ngân 1 lập');
    });
    console.log('✓ Quản lý lọc hóa đơn theo Thu ngân 1 chính xác.');

    // Quản lý lọc theo Thu ngân 2
    const filterByCsh2 = await req('GET', `/api/invoices?seller_id=${csh2Id}&page=1`, null, mgrCookie);
    assert.strictEqual(filterByCsh2.status, 200);
    const csh2List = filterByCsh2.data.invoices;
    assert.ok(csh2List.length >= 1);
    csh2List.forEach(inv => {
      assert.strictEqual(inv.created_by_name, 'Thu Ngân Số 2', 'Tất cả hóa đơn phải do Thu ngân 2 lập');
    });
    console.log('✓ Quản lý lọc hóa đơn theo Thu ngân 2 chính xác.');

    // Thu ngân 1 cố gắng truyền seller_id = Thu ngân 2 -> Backend phớt lờ, chỉ trả về hóa đơn Thu ngân 1
    const csh1AttemptOverride = await req('GET', `/api/invoices?seller_id=${csh2Id}&page=1`, null, csh1Cookie);
    assert.strictEqual(csh1AttemptOverride.status, 200);
    const hackedList = csh1AttemptOverride.data.invoices;
    hackedList.forEach(inv => {
      assert.strictEqual(inv.created_by_name, 'Thu Ngân Số 1', 'Thu ngân truyền seller_id người khác bị bỏ qua');
    });
    console.log('✓ Thu ngân cố gắng truyền seller_id người khác bị vô hiệu hóa tại backend.');

    // ------------------------------------------------------------------------
    // TEST 5: PHÂN TRANG VÀ THÔNG BÁO KHI KHÔNG CÓ KẾT QUẢ
    // ------------------------------------------------------------------------
    console.log('\n--- TEST 5: Phân trang và thông báo khi không có kết quả ---');
    // Quản lý phân trang limit = 2
    const page1Res = await req('GET', '/api/invoices?page=1&limit=2', null, mgrCookie);
    assert.strictEqual(page1Res.status, 200);
    assert.strictEqual(page1Res.data.invoices.length, 2, 'Trang 1 có 2 hóa đơn');
    assert.strictEqual(page1Res.data.page, 1);
    assert.ok(page1Res.data.total >= 4, 'Tổng số hóa đơn >= 4');
    assert.ok(page1Res.data.totalPages >= 2, 'Tổng số trang >= 2');

    const page2Res = await req('GET', '/api/invoices?page=2&limit=2', null, mgrCookie);
    assert.strictEqual(page2Res.status, 200);
    assert.strictEqual(page2Res.data.page, 2);
    assert.ok(page2Res.data.invoices.length >= 1, 'Trang 2 có hóa đơn tiếp theo');
    // Hai trang không được trùng id
    const page1Ids = page1Res.data.invoices.map(i => i.id);
    const page2Ids = page2Res.data.invoices.map(i => i.id);
    page1Ids.forEach(id => {
      assert.ok(!page2Ids.includes(id), `Hóa đơn ID ${id} không được trùng lặp giữa các trang`);
    });
    console.log('✓ Phân trang hoạt động chính xác không trùng lặp.');

    // Tìm kiếm không có kết quả
    const emptySearch = await req('GET', '/api/invoices?q=MA_HOA_DON_KHONG_TON_TAI_99999&page=1', null, mgrCookie);
    assert.strictEqual(emptySearch.status, 200);
    assert.strictEqual(emptySearch.data.invoices.length, 0);
    assert.strictEqual(emptySearch.data.total, 0);
    assert.strictEqual(emptySearch.data.totalPages, 0);
    console.log('✓ Trả về total = 0 và mảng rỗng khi không có kết quả.');

    // ------------------------------------------------------------------------
    // TEST 6: GIỮ NGUYÊN SNAPSHOT DỮ LIỆU ĐÃ LƯU KHI SỬA SẢN PHẨM VỀ SAU
    // ------------------------------------------------------------------------
    console.log('\n--- TEST 6: Giữ nguyên snapshot (tên, SKU, đơn vị, giá bán) khi sửa sản phẩm về sau ---');
    // Kiểm tra chi tiết hóa đơn C1_A trước khi sửa sản phẩm
    const beforeEdit = await req('GET', `/api/invoices/${idCsh1_A}`, null, csh1Cookie);
    assert.strictEqual(beforeEdit.status, 200);
    const originalItem = beforeEdit.data.items[0];
    assert.strictEqual(originalItem.product_name_snapshot, 'Sản Phẩm Hóa Đơn Test');
    assert.strictEqual(originalItem.unit_snapshot, 'Hộp');
    assert.strictEqual(Number(originalItem.unit_price), 100000);
    assert.strictEqual(originalItem.sku, 'TEST_INV_PROD');

    // Sửa thông tin sản phẩm trong bảng products: đổi tên, đơn vị, giá bán
    const pEdit = mysql.createPool({
      host: process.env.DB_HOST || '127.0.0.1',
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER || 'pos_app',
      password: process.env.DB_PASSWORD || '290729',
      database: 'pos_store_test'
    });
    await pEdit.query(
      'UPDATE products SET name = ?, unit = ?, sale_price = ? WHERE id = ?',
      ['Tên Đã Thay Đổi Hoàn Toàn', 'Thùng', 999999, prodId]
    );
    await pEdit.end();

    // Lấy lại chi tiết hóa đơn C1_A sau khi sản phẩm bị sửa
    const afterEdit = await req('GET', `/api/invoices/${idCsh1_A}`, null, csh1Cookie);
    assert.strictEqual(afterEdit.status, 200);
    const itemAfter = afterEdit.data.items[0];
    assert.strictEqual(itemAfter.product_name_snapshot, 'Sản Phẩm Hóa Đơn Test', 'Tên sản phẩm snapshot phải giữ nguyên giá trị tại thời điểm bán');
    assert.strictEqual(itemAfter.unit_snapshot, 'Hộp', 'Đơn vị tính snapshot phải giữ nguyên giá trị tại thời điểm bán');
    assert.strictEqual(Number(itemAfter.unit_price), 100000, 'Đơn giá snapshot phải giữ nguyên 100.000 đ, không bị nhảy lên 999.999 đ');
    assert.strictEqual(itemAfter.sku, 'TEST_INV_PROD', 'Mã SKU vẫn giữ nguyên');
    console.log('✓ Dữ liệu snapshot trong hóa đơn được bảo toàn 100% khi sản phẩm thay đổi.');

    // ------------------------------------------------------------------------
    // TEST 7: XEM VÀ LẤY DỮ LIỆU IN KHÔNG TẠO HÓA ĐƠN VÀ KHÔNG ĐỔI TỒN KHO
    // ------------------------------------------------------------------------
    console.log('\n--- TEST 7: Xem hoặc in không tạo thêm hóa đơn và không đổi tồn kho ---');
    const pCheck = mysql.createPool({
      host: process.env.DB_HOST || '127.0.0.1',
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER || 'pos_app',
      password: process.env.DB_PASSWORD || '290729',
      database: 'pos_store_test'
    });
    const [stockBefore] = await pCheck.query('SELECT stock_quantity FROM products WHERE id = ?', [prodId]);
    const [invCountBefore] = await pCheck.query('SELECT COUNT(*) as count FROM invoices');
    await pCheck.end();

    // Thực hiện nhiều thao tác xem danh sách và xem chi tiết (được dùng để in)
    for (let i = 0; i < 5; i++) {
      await req('GET', '/api/invoices', null, mgrCookie);
      await req('GET', `/api/invoices/${idCsh1_A}`, null, csh1Cookie);
      await req('GET', `/api/invoices/${idCsh2_A}`, null, csh2Cookie);
    }

    const pCheckAfter = mysql.createPool({
      host: process.env.DB_HOST || '127.0.0.1',
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER || 'pos_app',
      password: process.env.DB_PASSWORD || '290729',
      database: 'pos_store_test'
    });
    const [stockAfter] = await pCheckAfter.query('SELECT stock_quantity FROM products WHERE id = ?', [prodId]);
    const [invCountAfter] = await pCheckAfter.query('SELECT COUNT(*) as count FROM invoices');
    await pCheckAfter.end();

    assert.strictEqual(stockAfter[0].stock_quantity, stockBefore[0].stock_quantity, 'Tồn kho không được thay đổi khi xem/in hóa đơn');
    assert.strictEqual(invCountAfter[0].count, invCountBefore[0].count, 'Số lượng hóa đơn không được tăng thêm khi xem/in');
    console.log('✓ Thao tác xem và in là Read-Only tuyệt đối, không đổi tồn kho và không tạo hóa đơn.');

    // ------------------------------------------------------------------------
    // TEST 8: KHÔNG CÓ API SỬA / XÓA HÓA ĐƠN ĐÃ HOÀN TẤT
    // ------------------------------------------------------------------------
    console.log('\n--- TEST 8: Kiểm tra không có API sửa/xóa hóa đơn đã hoàn tất ---');
    const putRes = await req('PUT', `/api/invoices/${idCsh1_A}`, { total_amount: 50000 }, mgrCookie, mgrCsrf);
    assert.ok(putRes.status === 404 || putRes.status === 405, 'Không cho phép PUT sửa hóa đơn');

    const delRes = await req('DELETE', `/api/invoices/${idCsh1_A}`, null, mgrCookie, mgrCsrf);
    assert.ok(delRes.status === 404 || delRes.status === 405, 'Không cho phép DELETE xóa hóa đơn');
    console.log('✓ Hệ thống không có endpoint sửa/xóa hóa đơn đã hoàn tất.');

    console.log('\n======================================================');
    console.log('🎉 TẤT CẢ KIỂM THỬ PHÂN QUYỀN VÀ HÓA ĐƠN ĐÃ VƯỢT QUA 100%!');
    console.log('======================================================\n');

  } catch (err) {
    console.error('❌ LỖI TRONG QUÁ TRÌNH KIỂM THỬ:', err);
    process.exitCode = 1;
  } finally {
    serverProcess.kill();
  }
}

run();
