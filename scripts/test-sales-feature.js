require('dotenv').config();
const assert = require('assert');
const { spawn } = require('child_process');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const TEST_PORT = 3007;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

async function run() {
  console.log('=== BẮT ĐẦU KIỂM THỬ TOÀN DIỆN TÍNH NĂNG TRANG BÁN HÀNG ===\n');

  // 1. Chuẩn bị dữ liệu kiểm thử trong pos_store_test (không động chạm pos_store)
  const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'pos_app',
    password: process.env.DB_PASSWORD || '290729',
    database: 'pos_store_test',
    timezone: '+07:00'
  });

  const hash = await bcrypt.hash('password123', 10);
  await pool.query('INSERT INTO users (username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), is_active = 1',
    ['sales_mgr', hash, 'Quản Lý Bán Hàng', 'MANAGER', 1]);
  await pool.query('INSERT INTO users (username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), is_active = 1',
    ['sales_csh1', hash, 'Thu Ngân Bán Hàng 1', 'CASHIER', 1]);
  await pool.query('INSERT INTO users (username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), is_active = 1',
    ['sales_csh2', hash, 'Thu Ngân Bán Hàng 2', 'CASHIER', 1]);

  // Tạo sản phẩm test:
  // 1) Sản phẩm tồn ít: PROD_LOW_STOCK tồn = 3, giá = 50.000
  // 2) Sản phẩm hết hàng: PROD_OUT_STOCK tồn = 0, giá = 20.000
  // 3) Sản phẩm ngừng kinh doanh: PROD_INACTIVE tồn = 10, is_active = 0
  // 4) Sản phẩm dồi dào: PROD_NORMAL tồn = 100, giá = 30.000
  await pool.query('DELETE FROM products WHERE sku IN ("PROD_LOW_STOCK", "PROD_OUT_STOCK", "PROD_INACTIVE", "PROD_NORMAL")');

  const [ins1] = await pool.query(
    'INSERT INTO products (sku, name, unit, sale_price, stock_quantity, is_active) VALUES (?, ?, ?, ?, ?, ?)',
    ['PROD_LOW_STOCK', 'Sản Phẩm Tồn Ít', 'Cái', 50000, 3, 1]
  );
  const lowStockProdId = ins1.insertId;

  const [ins2] = await pool.query(
    'INSERT INTO products (sku, name, unit, sale_price, stock_quantity, is_active) VALUES (?, ?, ?, ?, ?, ?)',
    ['PROD_OUT_STOCK', 'Sản Phẩm Hết Hàng', 'Gói', 20000, 0, 1]
  );
  const outStockProdId = ins2.insertId;

  const [ins3] = await pool.query(
    'INSERT INTO products (sku, name, unit, sale_price, stock_quantity, is_active) VALUES (?, ?, ?, ?, ?, ?)',
    ['PROD_INACTIVE', 'Sản Phẩm Ngừng Bán', 'Chai', 45000, 10, 0]
  );
  const inactiveProdId = ins3.insertId;

  const [ins4] = await pool.query(
    'INSERT INTO products (sku, name, unit, sale_price, stock_quantity, is_active) VALUES (?, ?, ?, ?, ?, ?)',
    ['PROD_NORMAL', 'Sản Phẩm Thông Thường', 'Hộp', 30000, 100, 1]
  );
  const normalProdId = ins4.insertId;

  await pool.end();

  // 2. Khởi động server test trên port TEST_PORT
  console.log(`1. Khởi động server kiểm thử Bán hàng trên cổng ${TEST_PORT}...`);
  const serverProcess = spawn('node', ['server.js'], {
    env: { ...process.env, DB_NAME: 'pos_store_test', SESSION_SECRET: 'test_sales_secret_999', PORT: String(TEST_PORT), METRICS_PORT: '0' }
  });

  await new Promise((resolve) => {
    serverProcess.stdout.on('data', (d) => {
      if (d.toString().includes('Website đang chạy')) resolve();
    });
    setTimeout(resolve, 3000);
  });
  console.log('✓ Server kiểm thử đã sẵn sàng.\n');

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
    // Đăng nhập Cashier 1 & Cashier 2
    console.log('--- Đăng nhập các tài khoản bán hàng ---');
    const c1 = await req('GET', '/api/auth/csrf');
    const l1 = await req('POST', '/api/auth/login', { username: 'sales_csh1', password: 'password123' }, c1.cookie, c1.data.csrfToken);
    assert.strictEqual(l1.status, 200);
    const csh1Cookie = l1.cookie;
    const csh1Csrf = l1.data.csrfToken;

    const c2 = await req('GET', '/api/auth/csrf');
    const l2 = await req('POST', '/api/auth/login', { username: 'sales_csh2', password: 'password123' }, c2.cookie, c2.data.csrfToken);
    assert.strictEqual(l2.status, 200);
    const csh2Cookie = l2.cookie;
    const csh2Csrf = l2.data.csrfToken;

    console.log('✓ Đăng nhập thành công Cashier 1 và Cashier 2.\n');

    // ------------------------------------------------------------------------
    // TEST 1: TÌM SẢN PHẨM THEO TÊN HOẶC SKU, CHỈ LẤY ACTIVE, HIỂN THỊ ĐVT, GIÁ, TỒN
    // ------------------------------------------------------------------------
    console.log('--- TEST 1: Tìm kiếm sản phẩm theo tên hoặc SKU & kiểm tra thông tin ---');
    // Tìm theo SKU
    const searchSku = await req('GET', '/api/products?active_only=true&q=LOW_STOCK', null, csh1Cookie);
    assert.strictEqual(searchSku.status, 200);
    assert.ok(searchSku.data.some(p => p.sku === 'PROD_LOW_STOCK'));

    // Tìm theo Tên
    const searchName = await req('GET', '/api/products?active_only=true&q=Thông Thường', null, csh1Cookie);
    assert.strictEqual(searchName.status, 200);
    assert.ok(searchName.data.some(p => p.name === 'Sản Phẩm Thông Thường'));

    // Kiểm tra sản phẩm ngừng kinh doanh không xuất hiện khi active_only=true
    const activeProducts = await req('GET', '/api/products?active_only=true', null, csh1Cookie);
    assert.strictEqual(activeProducts.status, 200);
    assert.ok(!activeProducts.data.some(p => p.sku === 'PROD_INACTIVE'), 'Sản phẩm is_active=0 không được hiển thị khi bán');
    console.log('✓ Tìm kiếm sản phẩm theo tên/SKU thành công, loại trừ sản phẩm ngừng kinh doanh.');

    // ------------------------------------------------------------------------
    // TEST 2: KIỂM THỬ SỐ LƯỢNG 0, ÂM, THẬP PHÂN
    // ------------------------------------------------------------------------
    console.log('\n--- TEST 2: Kiểm thử số lượng không hợp lệ (0, âm, thập phân, chữ) ---');
    // 1. Số lượng = 0
    const resZero = await req('POST', '/api/invoices', {
      invoice_no: `HD_INV_${Date.now()}_0`,
      request_key: `key_zero_${Date.now()}`,
      items: [{ product_id: normalProdId, quantity: 0, unit_price: 30000 }]
    }, csh1Cookie, csh1Csrf);
    assert.strictEqual(resZero.status, 400, 'Số lượng 0 phải bị từ chối');

    // 2. Số lượng âm (-2)
    const resNeg = await req('POST', '/api/invoices', {
      invoice_no: `HD_INV_${Date.now()}_neg`,
      request_key: `key_neg_${Date.now()}`,
      items: [{ product_id: normalProdId, quantity: -2, unit_price: 30000 }]
    }, csh1Cookie, csh1Csrf);
    assert.strictEqual(resNeg.status, 400, 'Số lượng âm phải bị từ chối');

    // 3. Số lượng thập phân (1.5)
    const resDec = await req('POST', '/api/invoices', {
      invoice_no: `HD_INV_${Date.now()}_dec`,
      request_key: `key_dec_${Date.now()}`,
      items: [{ product_id: normalProdId, quantity: 1.5, unit_price: 30000 }]
    }, csh1Cookie, csh1Csrf);
    assert.strictEqual(resDec.status, 400, 'Số lượng thập phân phải bị từ chối');

    // 4. Số lượng chuỗi không phải số
    const resStr = await req('POST', '/api/invoices', {
      invoice_no: `HD_INV_${Date.now()}_str`,
      request_key: `key_str_${Date.now()}`,
      items: [{ product_id: normalProdId, quantity: 'abc', unit_price: 30000 }]
    }, csh1Cookie, csh1Csrf);
    assert.strictEqual(resStr.status, 400, 'Số lượng chữ phải bị từ chối');
    console.log('✓ Tất cả các trường hợp số lượng không nguyên dương đều bị từ chối (HTTP 400).');

    // ------------------------------------------------------------------------
    // TEST 3: GIỎ TRỐNG KHÔNG ĐƯỢC THANH TOÁN
    // ------------------------------------------------------------------------
    console.log('\n--- TEST 3: Kiểm thử giỏ hàng trống ---');
    const resEmpty = await req('POST', '/api/invoices', {
      invoice_no: `HD_INV_${Date.now()}_empty`,
      request_key: `key_empty_${Date.now()}`,
      items: []
    }, csh1Cookie, csh1Csrf);
    assert.strictEqual(resEmpty.status, 400, 'Giỏ trống phải bị từ chối (400)');
    assert.ok(resEmpty.data.error.includes('ít nhất 1 sản phẩm'));
    console.log('✓ Giỏ hàng trống bị từ chối chính xác.');

    // ------------------------------------------------------------------------
    // TEST 4: SẢN PHẨM HẾT HÀNG / NGỪNG KINH DOANH
    // ------------------------------------------------------------------------
    console.log('\n--- TEST 4: Kiểm thử sản phẩm hết hàng hoặc ngừng kinh doanh ---');
    // Bán sản phẩm hết hàng (tồn = 0)
    const resOutStock = await req('POST', '/api/invoices', {
      invoice_no: `HD_INV_${Date.now()}_out`,
      request_key: `key_out_${Date.now()}`,
      items: [{ product_id: outStockProdId, quantity: 1, unit_price: 20000 }]
    }, csh1Cookie, csh1Csrf);
    assert.strictEqual(resOutStock.status, 400, 'Bán sản phẩm hết hàng phải bị từ chối');
    assert.ok(resOutStock.data.error.includes('không đủ tồn kho'));

    // Bán sản phẩm ngừng kinh doanh (is_active = 0)
    const resInactive = await req('POST', '/api/invoices', {
      invoice_no: `HD_INV_${Date.now()}_inact`,
      request_key: `key_inact_${Date.now()}`,
      items: [{ product_id: inactiveProdId, quantity: 1, unit_price: 45000 }]
    }, csh1Cookie, csh1Csrf);
    assert.strictEqual(resInactive.status, 400, 'Bán sản phẩm ngừng kinh doanh phải bị từ chối');
    assert.ok(resInactive.data.error.includes('ngừng kinh doanh'));
    console.log('✓ Sản phẩm hết hàng hoặc ngừng kinh doanh bị chặn chính xác.');

    // ------------------------------------------------------------------------
    // TEST 5: THÊM VƯỢT TỒN & CỘNG DỒN VƯỢT TỒN
    // ------------------------------------------------------------------------
    console.log('\n--- TEST 5: Kiểm thử thêm vượt tồn & cộng dồn vượt tồn ---');
    // PROD_LOW_STOCK có tồn = 3. Mua 5 cây -> Vượt tồn
    const resOver = await req('POST', '/api/invoices', {
      invoice_no: `HD_INV_${Date.now()}_over`,
      request_key: `key_over_${Date.now()}`,
      items: [{ product_id: lowStockProdId, quantity: 5, unit_price: 50000 }]
    }, csh1Cookie, csh1Csrf);
    assert.strictEqual(resOver.status, 400, 'Mua vượt tồn phải bị từ chối');
    assert.ok(resOver.data.error.includes('không đủ tồn kho'));

    // Cộng dồn vượt tồn: cùng sản phẩm gửi 2 item (2 + 2 = 4 > tồn 3)
    const resMergedOver = await req('POST', '/api/invoices', {
      invoice_no: `HD_INV_${Date.now()}_merged_over`,
      request_key: `key_merged_${Date.now()}`,
      items: [
        { product_id: lowStockProdId, quantity: 2, unit_price: 50000 },
        { product_id: lowStockProdId, quantity: 2, unit_price: 50000 }
      ]
    }, csh1Cookie, csh1Csrf);
    assert.strictEqual(resMergedOver.status, 400, 'Cộng dồn vượt tồn kho phải bị từ chối');
    assert.ok(resMergedOver.data.error.includes('không đủ tồn kho'));
    console.log('✓ Thêm vượt tồn và cộng dồn vượt tồn đều bị từ chối.');

    // ------------------------------------------------------------------------
    // TEST 6: BẤM THANH TOÁN LIÊN TIẾP (DOUBLE SUBMIT / CÙNG REQUEST KEY)
    // ------------------------------------------------------------------------
    console.log('\n--- TEST 6: Bấm thanh toán liên tiếp (Chống gửi trùng lặp với cùng request_key) ---');
    const spamKey = `spam_key_${Date.now()}`;
    const spamInvNo = `HD_SPAM_${Date.now()}`;
    const spamPayload = {
      invoice_no: spamInvNo,
      request_key: spamKey,
      items: [{ product_id: normalProdId, quantity: 1, unit_price: 30000 }]
    };

    // Bấm đồng thời 2 lần cùng 1 payload và request_key
    const [spamRes1, spamRes2] = await Promise.all([
      req('POST', '/api/invoices', spamPayload, csh1Cookie, csh1Csrf),
      req('POST', '/api/invoices', spamPayload, csh1Cookie, csh1Csrf)
    ]);

    // Một request trả về 201 (tạo mới), request còn lại nhận phản hồi thành công (200) hoặc 201
    assert.ok((spamRes1.status === 201 && spamRes2.status === 200) || (spamRes1.status === 200 && spamRes2.status === 201) || (spamRes1.status === 201 && spamRes2.status === 201));
    assert.strictEqual(spamRes1.data.id, spamRes2.data.id, 'Cả hai lần gửi trùng chỉ tạo đúng 1 hóa đơn');
    console.log('✓ Cơ chế chống tạo trùng xử lý hoàn hảo, không trừ tồn kho 2 lần.');

    // ------------------------------------------------------------------------
    // TEST 7: HAI PHIÊN CÙNG BÁN MỘT SẢN PHẨM CÓ TỒN ÍT (CONCURRENT RACE CONDITION)
    // ------------------------------------------------------------------------
    console.log('\n--- TEST 7: Hai phiên cùng bán 1 sản phẩm có tồn ít (Locking FOR UPDATE) ---');
    // PROD_LOW_STOCK có tồn = 3.
    // Phiên 1 (sales_csh1) mua 2 cây.
    // Phiên 2 (sales_csh2) mua 2 cây.
    // Tổng yêu cầu = 4 > 3 -> Khóa FOR UPDATE trong transaction bắt buộc CHỈ 1 PHIÊN THÀNH CÔNG, phiên còn lại báo lỗi tồn kho.
    const raceInv1 = `HD_RACE_1_${Date.now()}`;
    const raceInv2 = `HD_RACE_2_${Date.now()}`;

    const [raceRes1, raceRes2] = await Promise.all([
      req('POST', '/api/invoices', {
        invoice_no: raceInv1,
        request_key: `key_race_1_${Date.now()}`,
        items: [{ product_id: lowStockProdId, quantity: 2, unit_price: 50000 }]
      }, csh1Cookie, csh1Csrf),
      req('POST', '/api/invoices', {
        invoice_no: raceInv2,
        request_key: `key_race_2_${Date.now()}`,
        items: [{ product_id: lowStockProdId, quantity: 2, unit_price: 50000 }]
      }, csh2Cookie, csh2Csrf)
    ]);

    const successes = [raceRes1, raceRes2].filter(r => r.status === 201);
    const failures = [raceRes1, raceRes2].filter(r => r.status === 400);

    assert.strictEqual(successes.length, 1, 'Bắt buộc chính xác 1 phiên thành công');
    assert.strictEqual(failures.length, 1, 'Bắt buộc phiên còn lại bị từ chối do không đủ tồn kho');
    assert.ok(failures[0].data.error.includes('không đủ tồn kho'), 'Lỗi trả về đúng thông báo không đủ tồn');

    // Kiểm tra tồn kho sau giao dịch: ban đầu 3, bán 2 -> còn đúng 1
    const pCheck = mysql.createPool({
      host: process.env.DB_HOST || '127.0.0.1',
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER || 'pos_app',
      password: process.env.DB_PASSWORD || '290729',
      database: 'pos_store_test'
    });
    const [finalStock] = await pCheck.query('SELECT stock_quantity FROM products WHERE id = ?', [lowStockProdId]);
    await pCheck.end();
    assert.strictEqual(finalStock[0].stock_quantity, 1, 'Tồn kho còn lại phải chính xác là 1');
    console.log('✓ Khóa dòng và transaction bảo vệ tồn kho 100% trước giao dịch đồng thời.');

    // ------------------------------------------------------------------------
    // TEST 8: TRẢ VỀ MÃ HÓA ĐƠN THỰC TẾ & XEM ĐƯỢC CHI TIẾT
    // ------------------------------------------------------------------------
    console.log('\n--- TEST 8: Kiểm tra mã hóa đơn thực tế trả về & lấy chi tiết ---');
    const createdId = successes[0].data.id;
    const createdNo = successes[0].data.invoice_no;
    assert.ok(createdId > 0, 'Phải có ID hóa đơn');
    assert.ok(createdNo && createdNo.startsWith('HD_RACE_'), 'Phải trả về đúng mã hóa đơn thực tế');

    const detailRes = await req('GET', `/api/invoices/${createdId}`, null, csh1Cookie);
    // Nếu do csh1 tạo thì 200, nếu do csh2 tạo thì csh1 là 404 (do phân quyền sở hữu đã làm ở mục trước)
    if (detailRes.status === 404) {
      const detailRes2 = await req('GET', `/api/invoices/${createdId}`, null, csh2Cookie);
      assert.strictEqual(detailRes2.status, 200);
      assert.strictEqual(detailRes2.data.invoice.invoice_no, createdNo);
    } else {
      assert.strictEqual(detailRes.status, 200);
      assert.strictEqual(detailRes.data.invoice.invoice_no, createdNo);
    }
    console.log('✓ Mã hóa đơn thực tế đã lưu và endpoint xem chi tiết hoạt động chính xác.');

    console.log('\n================================================================');
    console.log('🎉 TẤT CẢ KIỂM THỬ TÍNH NĂNG TRANG BÁN HÀNG ĐÃ VƯỢT QUA 100%!');
    console.log('================================================================\n');

  } catch (err) {
    console.error('❌ LỖI KIỂM THỬ:', err);
    process.exitCode = 1;
  } finally {
    serverProcess.kill();
  }
}

run();
