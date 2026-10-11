require('dotenv').config();
const assert = require('assert');
const { spawn } = require('child_process');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const TEST_PORT = 3006;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

async function run() {
  console.log('========================================================================');
  console.log('   BẮT ĐẦU KIỂM THỬ TẬP TRUNG 5 MỤC SỬA LỖI HỆ THỐNG POS STORE');
  console.log('========================================================================\n');

  // Kiểm tra an toàn: ghi nhận trạng thái pos_store để đảm bảo không bị ảnh hưởng
  const prodPool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'pos_app',
    password: process.env.DB_PASSWORD || '290729',
    database: process.env.DB_NAME || 'pos_store'
  });
  const [prodUsers] = await prodPool.query("SELECT id, username, role, is_active FROM users");
  console.log(`[An Toàn] CSDL chính pos_store hiện có ${prodUsers.length} tài khoản. Sẽ giữ nguyên 100% không reset.\n`);
  await prodPool.end();

  // Chuẩn bị CSDL kiểm thử riêng biệt: pos_store_test
  const testPool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'pos_app',
    password: process.env.DB_PASSWORD || '290729',
    database: 'pos_store_test'
  });

  const testPass = 'PasswordTest123!@#';
  const testHash = await bcrypt.hash(testPass, 10);

  // Tạo tài khoản quản lý và thu ngân kiểm thử trong pos_store_test
  await testPool.query("DELETE FROM users WHERE username LIKE 'bundle_%'");

  const [mgr1Res] = await testPool.query(
    "INSERT INTO users (username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, 'MANAGER', 1)",
    ['bundle_mgr_1', testHash, 'Quản Lý Bundle 1']
  );
  const mgr1Id = mgr1Res.insertId;

  const [mgr2Res] = await testPool.query(
    "INSERT INTO users (username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, 'MANAGER', 1)",
    ['bundle_mgr_2', testHash, 'Quản Lý Bundle 2']
  );
  const mgr2Id = mgr2Res.insertId;

  const [cshRes] = await testPool.query(
    "INSERT INTO users (username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, 'CASHIER', 1)",
    ['bundle_csh_1', testHash, 'Thu Ngân Bundle 1']
  );
  const csh1Id = cshRes.insertId;

  // Sản phẩm kiểm thử cho nhập kho
  await testPool.query("DELETE FROM products WHERE sku LIKE 'SKU_BUNDLE_%'");
  const [prodRes] = await testPool.query(
    "INSERT INTO products (sku, name, unit, sale_price, stock_quantity, is_active) VALUES ('SKU_BUNDLE_01', 'Sản Phẩm Bundle 01', 'Cái', 50000, 10, 1)"
  );
  const prodId = prodRes.insertId;

  await testPool.end();

  // Khởi động server test trên cổng TEST_PORT kết nối tới pos_store_test
  console.log(`Khởi động server kiểm thử trên cổng ${TEST_PORT} (CSDL: pos_store_test)...`);
  const serverProcess = spawn('node', ['server.js'], {
    env: { ...process.env, DB_NAME: 'pos_store_test', SESSION_SECRET: 'bundle_secret_123', PORT: String(TEST_PORT) }
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

  const results = {
    item1: 'CHƯA CHẠY',
    item2: 'CHƯA CHẠY',
    item3: 'CHƯA CHẠY',
    item4: 'CHƯA CHẠY',
    item5: 'CHƯA CHẠY'
  };

  try {
    // Đăng nhập tài khoản Quản lý bundle_mgr_1
    const csrfRes = await req('GET', '/api/auth/csrf');
    const loginMgr1 = await req('POST', '/api/auth/login', {
      username: 'bundle_mgr_1',
      password: testPass
    }, csrfRes.cookie, csrfRes.data.csrfToken);
    assert.strictEqual(loginMgr1.status, 200);
    const mgr1Cookie = loginMgr1.cookie;
    const mgr1Csrf = loginMgr1.data.csrfToken;

    // ========================================================================
    // BÀI 1: SO SÁNH CHÍNH XÁC USER_ID KHI XÓA SESSIONS
    // ========================================================================
    console.log('------------------------------------------------------------------------');
    console.log('BÀI 1: Xóa sessions theo so sánh chính xác JSON userId (ID 1 vs ID 10, 11, 100)');
    console.log('------------------------------------------------------------------------');
    {
      const db = mysql.createPool({
        host: process.env.DB_HOST || '127.0.0.1',
        port: process.env.DB_PORT || 3306,
        user: process.env.DB_USER || 'pos_app',
        password: process.env.DB_PASSWORD || '290729',
        database: 'pos_store_test'
      });

      // Tạo các phiên giả lập trong bảng sessions cho ID 1, 10, 11, 100
      const exp = Math.floor(Date.now() / 1000) + 86400;
      await db.query("DELETE FROM sessions WHERE session_id LIKE 'sess_test_%'");
      await db.query("INSERT INTO sessions (session_id, expires, data) VALUES (?, ?, ?)",
        ['sess_test_u1_a', exp, JSON.stringify({ cookie: {}, userId: 1, username: 'user_1' })]);
      await db.query("INSERT INTO sessions (session_id, expires, data) VALUES (?, ?, ?)",
        ['sess_test_u1_b', exp, JSON.stringify({ cookie: {}, userId: 1, username: 'user_1' })]);
      await db.query("INSERT INTO sessions (session_id, expires, data) VALUES (?, ?, ?)",
        ['sess_test_u10', exp, JSON.stringify({ cookie: {}, userId: 10, username: 'user_10' })]);
      await db.query("INSERT INTO sessions (session_id, expires, data) VALUES (?, ?, ?)",
        ['sess_test_u11', exp, JSON.stringify({ cookie: {}, userId: 11, username: 'user_11' })]);
      await db.query("INSERT INTO sessions (session_id, expires, data) VALUES (?, ?, ?)",
        ['sess_test_u100', exp, JSON.stringify({ cookie: {}, userId: 100, username: 'user_100' })]);

      // Quản lý thực hiện reset mật khẩu cho user ID 1 qua API /api/employees/1/reset-password
      // (hoặc nếu user 1 tồn tại trong pos_store_test)
      const [u1Check] = await db.query("SELECT id FROM users WHERE id = 1");
      let resetTargetId = 1;
      if (u1Check.length === 0) {
        // Tạo tạm user 1 để test API nếu chưa có
        await db.query("INSERT INTO users (id, username, password_hash, full_name, role, is_active) VALUES (1, 'bundle_user_1', ?, 'User 1', 'CASHIER', 1)", [testHash]);
      }

      const resetRes = await req('PATCH', `/api/employees/${resetTargetId}/reset-password`, {
        password: 'NewStrongPassword123!@#',
        confirm_password: 'NewStrongPassword123!@#'
      }, mgr1Cookie, mgr1Csrf);
      assert.strictEqual(resetRes.status, 200, 'Reset mật khẩu thành công');

      // Kiểm tra lại bảng sessions
      const [remainingSessions] = await db.query("SELECT session_id, data FROM sessions WHERE session_id LIKE 'sess_test_%'");
      const remainingIds = remainingSessions.map(s => s.session_id);

      // Các phiên của user ID 1 phải bị xóa hoàn toàn
      assert.ok(!remainingIds.includes('sess_test_u1_a'), 'Phiên A của user 1 phải bị xóa');
      assert.ok(!remainingIds.includes('sess_test_u1_b'), 'Phiên B của user 1 phải bị xóa');

      // Các phiên của ID 10, 11, 100 PHẢI ĐƯỢC GIỮ NGUYÊN 100%
      assert.ok(remainingIds.includes('sess_test_u10'), 'Phiên của user ID 10 PHẢI CÒN NGUYÊN');
      assert.ok(remainingIds.includes('sess_test_u11'), 'Phiên của user ID 11 PHẢI CÒN NGUYÊN');
      assert.ok(remainingIds.includes('sess_test_u100'), 'Phiên của user ID 100 PHẢI CÒN NGUYÊN');

      // Dọn dẹp
      await db.query("DELETE FROM sessions WHERE session_id LIKE 'sess_test_%'");
      await db.end();

      console.log('✓ Xóa chính xác phiên của ID 1, bảo toàn 100% phiên của ID 10, 11 và 100.');
      results.item1 = 'PASS';
    }

    // ========================================================================
    // BÀI 2: KIỂM TRA NGÀY HỢP LỆ VÀ CHẶN from_date > to_date
    // ========================================================================
    console.log('\n------------------------------------------------------------------------');
    console.log('BÀI 2: Kiểm tra ngày hợp lệ và chặn from_date > to_date ở stock-receipts');
    console.log('------------------------------------------------------------------------');
    {
      // 2.1 Backend trả 400 trước khi query khi from_date > to_date
      const reverseDateRes = await req('GET', '/api/stock-receipts?from_date=2026-10-20&to_date=2026-10-10', null, mgr1Cookie);
      assert.strictEqual(reverseDateRes.status, 400, 'Backend phải trả về HTTP 400 khi from_date > to_date');
      assert.strictEqual(reverseDateRes.data.error, 'Từ ngày không được lớn hơn Đến ngày.');
      console.log('✓ Backend trả HTTP 400 với thông báo: "' + reverseDateRes.data.error + '" khi from_date > to_date.');

      // 2.2 Backend trả 400 khi định dạng ngày sai
      const invalidDateRes = await req('GET', '/api/stock-receipts?from_date=invalid-date&to_date=2026-10-10', null, mgr1Cookie);
      assert.strictEqual(invalidDateRes.status, 400);
      assert.ok(invalidDateRes.data.error.includes('không hợp lệ'));
      console.log('✓ Backend từ chối định dạng ngày sai với HTTP 400: "' + invalidDateRes.data.error + '".');

      // 2.3 Khoảng ngày hợp lệ -> HTTP 200
      const validDateRes = await req('GET', '/api/stock-receipts?from_date=2026-10-01&to_date=2026-10-31', null, mgr1Cookie);
      assert.strictEqual(validDateRes.status, 200, 'Khoảng ngày hợp lệ trả về HTTP 200');
      console.log('✓ Khoảng ngày hợp lệ trả về kết quả thành công HTTP 200.');
      results.item2 = 'PASS';
    }

    // ========================================================================
    // BÀI 3: RETRY AN TOÀN KHI MẤT KẾT NỐI, KHÔNG CỘNG TỒN LẦN NỮA
    // ========================================================================
    console.log('\n------------------------------------------------------------------------');
    console.log('BÀI 3: Idempotency và Retry an toàn phiếu nhập khi mất kết nối');
    console.log('------------------------------------------------------------------------');
    {
      const db = mysql.createPool({
        host: process.env.DB_HOST || '127.0.0.1',
        port: process.env.DB_PORT || 3306,
        user: process.env.DB_USER || 'pos_app',
        password: process.env.DB_PASSWORD || '290729',
        database: 'pos_store_test'
      });

      // Lấy tồn kho ban đầu của sản phẩm
      const [[initProd]] = await db.query('SELECT stock_quantity FROM products WHERE id = ?', [prodId]);
      const initialStock = Number(initProd.stock_quantity);
      console.log(`  Tồn kho ban đầu của sản phẩm: ${initialStock}`);

      const requestKey = 'retry_key_' + Date.now();
      const receiptNo = 'PN_RETRY_' + Date.now();
      const payload = {
        receipt_no: receiptNo,
        request_key: requestKey,
        items: [{ product_id: prodId, quantity: 5, unit_cost: 40000 }]
      };

      // Yêu cầu lần 1: Máy chủ đã lưu và commit thành công (201)
      const res1 = await req('POST', '/api/stock-receipts', payload, mgr1Cookie, mgr1Csrf);
      assert.strictEqual(res1.status, 201, 'Lần 1 tạo thành công HTTP 201');
      const [[afterRes1]] = await db.query('SELECT stock_quantity FROM products WHERE id = ?', [prodId]);
      assert.strictEqual(Number(afterRes1.stock_quantity), initialStock + 5, 'Tồn kho tăng đúng 5 sau lần 1');
      console.log(`  Tồn kho sau lần 1: ${afterRes1.stock_quantity} (+5).`);

      // Giả lập tình huống client bị mất kết nối/chưa nhận được phản hồi lần 1 -> Bấm Thử Lại:
      // Gửi lại CHÍNH XÁC request_key, receipt_no và payload
      const res2 = await req('POST', '/api/stock-receipts', payload, mgr1Cookie, mgr1Csrf);
      assert.strictEqual(res2.status, 200, 'Lần thử lại phải nhận được HTTP 200 (Phiếu đã tạo trước đó)');
      assert.ok(res2.data.message.includes('đã được tạo trước đó'));
      assert.strictEqual(res2.data.receipt_no, receiptNo);

      // Kiểm tra lại tồn kho trong CSDL: TUYỆT ĐỐI KHÔNG ĐƯỢC TĂNG LẦN NỮA
      const [[afterRes2]] = await db.query('SELECT stock_quantity FROM products WHERE id = ?', [prodId]);
      assert.strictEqual(Number(afterRes2.stock_quantity), initialStock + 5, 'Tồn kho không được tăng thêm lần 2');
      console.log(`  Tồn kho sau khi Thử lại (Idempotent): ${afterRes2.stock_quantity} (Không bị cộng trùng).`);

      // Giả lập người dùng cố tình đổi nội dung khi cùng request_key -> Backend phải chặn Conflict 409
      const conflictPayload = {
        receipt_no: receiptNo,
        request_key: requestKey,
        items: [{ product_id: prodId, quantity: 99, unit_cost: 40000 }]
      };
      const resConflict = await req('POST', '/api/stock-receipts', conflictPayload, mgr1Cookie, mgr1Csrf);
      assert.strictEqual(resConflict.status, 409, 'Đổi nội dung khi đang chờ thử lại bị chặn với HTTP 409 Conflict');
      console.log('✓ Thử lại nhận đúng phiếu cũ (HTTP 200), không cộng trùng kho, chặn thay đổi nội dung (HTTP 409).');

      await db.end();
      results.item3 = 'PASS';
    }

    // ========================================================================
    // BÀI 4: KHÓA TRANSACTION THỐNG NHẤT VÀ CONCURRENCY BẢO VỆ QUẢN LÝ CUỐI CÙNG
    // ========================================================================
    console.log('\n------------------------------------------------------------------------');
    console.log('BÀI 4: Transaction & Khóa thống nhất chống Race Condition (2 yêu cầu đồng thời)');
    console.log('------------------------------------------------------------------------');
    {
      const db = mysql.createPool({
        host: process.env.DB_HOST || '127.0.0.1',
        port: process.env.DB_PORT || 3306,
        user: process.env.DB_USER || 'pos_app',
        password: process.env.DB_PASSWORD || '290729',
        database: 'pos_store_test'
      });

      // Đảm bảo chỉ có đúng 2 quản lý hoạt động: mgr1Id và mgr2Id
      await db.query("UPDATE users SET is_active = 0 WHERE role = 'MANAGER' AND id NOT IN (?, ?)", [mgr1Id, mgr2Id]);
      await db.query("UPDATE users SET role = 'MANAGER', is_active = 1 WHERE id IN (?, ?)", [mgr1Id, mgr2Id]);

      const [count2Mgr] = await db.query("SELECT COUNT(*) as count FROM users WHERE role = 'MANAGER' AND is_active = 1");
      assert.strictEqual(count2Mgr[0].count, 2, 'Trước khi chạy đồng thời, hệ thống có đúng 2 Quản lý active');
      console.log(`  Hệ thống chuẩn bị với đúng 2 Quản lý hoạt động: ID ${mgr1Id} và ID ${mgr2Id}.`);

      // Đăng nhập thêm tài khoản Quản lý 2 để có 2 phiên làm việc độc lập
      const csrf2 = await req('GET', '/api/auth/csrf');
      const loginMgr2 = await req('POST', '/api/auth/login', {
        username: 'bundle_mgr_2',
        password: testPass
      }, csrf2.cookie, csrf2.data.csrfToken);
      assert.strictEqual(loginMgr2.status, 200);
      const mgr2Cookie = loginMgr2.cookie;
      const mgr2Csrf = loginMgr2.data.csrfToken;

      // Thực hiện 2 yêu cầu ĐỒNG THỜI:
      // Request A (Quản lý 1 khóa Quản lý 2)
      // Request B (Quản lý 2 khóa Quản lý 1)
      console.log('  -> Đang gửi 2 yêu cầu KHÓA tài khoản đồng thời tại cùng thời điểm...');
      const [resLockA, resLockB] = await Promise.all([
        req('PATCH', `/api/employees/${mgr2Id}/toggle-active`, { is_active: false }, mgr1Cookie, mgr1Csrf),
        req('PATCH', `/api/employees/${mgr1Id}/toggle-active`, { is_active: false }, mgr2Cookie, mgr2Csrf)
      ]);

      console.log(`  Kết quả Request A: HTTP ${resLockA.status} (${resLockA.data.message || resLockA.data.error})`);
      console.log(`  Kết quả Request B: HTTP ${resLockB.status} (${resLockB.data.message || resLockB.data.error})`);

      const statuses = [resLockA.status, resLockB.status].sort();
      // Nhờ cơ chế SELECT ... FOR UPDATE theo ORDER BY id ASC trong Transaction:
      // Một request PHẢI thành công (200) và request còn lại PHẢI bị chặn (400) vì phát hiện là quản lý hoạt động cuối cùng!
      assert.strictEqual(statuses[0], 200, 'Một yêu cầu phải thành công');
      assert.strictEqual(statuses[1], 400, 'Yêu cầu còn lại phải bị chặn với HTTP 400 để bảo vệ Quản lý cuối cùng');

      // Kiểm tra trong CSDL: Luôn luôn còn lại đúng 1 Quản lý hoạt động!
      const [activeAfterConcurrent] = await db.query("SELECT COUNT(*) as count FROM users WHERE role = 'MANAGER' AND is_active = 1");
      assert.strictEqual(activeAfterConcurrent[0].count, 1, 'Sau 2 yêu cầu đồng thời, hệ thống PHẢI còn đúng 1 Quản lý hoạt động!');
      console.log(`✓ Bảo vệ thành công: Đúng 1 yêu cầu thành công (HTTP 200) và 1 yêu cầu bị chặn (HTTP 400). Số quản lý hoạt động còn lại: ${activeAfterConcurrent[0].count}.`);

      // Khôi phục lại cả 2 quản lý active
      await db.query("UPDATE users SET is_active = 1 WHERE id IN (?, ?)", [mgr1Id, mgr2Id]);
      await db.end();
      results.item4 = 'PASS';
    }

    // ========================================================================
    // BÀI 5: DASHBOARD COUNT(*) SẢN PHẨM HẾT/SẮP HẾT HÀNG VS LIMIT 20 DÒNG
    // ========================================================================
    console.log('\n------------------------------------------------------------------------');
    console.log('BÀI 5: Dashboard trả riêng tổng số sản phẩm cần nhập bằng COUNT(*)');
    console.log('------------------------------------------------------------------------');
    {
      const db = mysql.createPool({
        host: process.env.DB_HOST || '127.0.0.1',
        port: process.env.DB_PORT || 3306,
        user: process.env.DB_USER || 'pos_app',
        password: process.env.DB_PASSWORD || '290729',
        database: 'pos_store_test'
      });

      // Tạo 25 sản phẩm sắp hết hàng (tồn <= 5)
      await db.query("DELETE FROM products WHERE sku LIKE 'SKU_DASH_COUNT_%'");
      const insertPromises = [];
      for (let i = 1; i <= 25; i++) {
        const sku = `SKU_DASH_COUNT_${String(i).padStart(2, '0')}`;
        insertPromises.push(
          db.query(
            "INSERT INTO products (sku, name, unit, sale_price, stock_quantity, is_active) VALUES (?, ?, 'Cái', 20000, 2, 1)",
            [sku, `Sản Phẩm Cần Nhập Số ${i}`]
          )
        );
      }
      await Promise.all(insertPromises);

      // Đếm số sản phẩm thực tế cần nhập trong DB (ngưỡng 5)
      const [[actualCountRow]] = await db.query("SELECT COUNT(*) as count FROM products WHERE is_active = 1 AND stock_quantity <= 5");
      const expectedTotal = Number(actualCountRow.count);
      assert.ok(expectedTotal >= 25, 'Phải có ít nhất 25 sản phẩm cần nhập');
      console.log(`  Số sản phẩm hết/sắp hết hàng thực tế trong CSDL: ${expectedTotal}.`);

      // Gọi API Dashboard Stats
      const dashRes = await req('GET', '/api/dashboard/stats?threshold=5', null, mgr1Cookie);
      assert.strictEqual(dashRes.status, 200);

      // Kiểm tra: summary.lowStockCount phải bằng tổng thực tế COUNT(*)
      const summaryCount = dashRes.data.summary.lowStockCount;
      console.log(`  Số lượng trong summary.lowStockCount trả về: ${summaryCount}.`);
      assert.strictEqual(summaryCount, expectedTotal, 'summary.lowStockCount phải bằng tổng COUNT(*) thực tế trong CSDL');

      // Kiểm tra: danh sách lowStockProducts phải bị giới hạn tối đa 20 dòng (LIMIT 20)
      const listLength = dashRes.data.lowStockProducts.length;
      console.log(`  Số dòng trong mảng lowStockProducts trả về: ${listLength} (giới hạn 20).`);
      assert.strictEqual(listLength, 20, 'Danh sách chi tiết hiển thị phải giới hạn đúng 20 dòng');

      // Dọn dẹp
      await db.query("DELETE FROM products WHERE sku LIKE 'SKU_DASH_COUNT_%'");
      await db.end();

      console.log('✓ Thống kê ô đếm trả đúng COUNT(*) thực tế, danh sách chi tiết giới hạn 20 dòng.');
      results.item5 = 'PASS';
    }

    // ========================================================================
    // KIỂM TRA ĐỐI CHIẾU AN TOÀN DATABASE POS_STORE
    // ========================================================================
    console.log('\n------------------------------------------------------------------------');
    console.log('KIỂM TRA AN TOÀN: Đối chiếu tài khoản CSDL chính pos_store');
    console.log('------------------------------------------------------------------------');
    const finalProdPool = mysql.createPool({
      host: process.env.DB_HOST || '127.0.0.1',
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER || 'pos_app',
      password: process.env.DB_PASSWORD || '290729',
      database: process.env.DB_NAME || 'pos_store'
    });
    const [finalProdUsers] = await finalProdPool.query("SELECT id, username, role, is_active FROM users");
    assert.strictEqual(finalProdUsers.length, prodUsers.length);
    assert.strictEqual(finalProdUsers[0].username, 'manager');
    assert.strictEqual(finalProdUsers[0].role, 'MANAGER');
    assert.strictEqual(finalProdUsers[0].is_active, 1);
    await finalProdPool.end();
    console.log('✓ CSDL chính pos_store được bảo toàn nguyên vẹn 100%, không bị reset.\n');

  } finally {
    serverProcess.kill();
  }

  console.log('========================================================================');
  console.log('BẢNG TỔNG HỢP KẾT QUẢ KIỂM THỬ:');
  console.log('  1. Xóa sessions chính xác theo userId:       [' + results.item1 + ']');
  console.log('  2. Chặn from_date > to_date (Frontend+Backend): [' + results.item2 + ']');
  console.log('  3. Retry an toàn & Idempotency khi mất kết nối: [' + results.item3 + ']');
  console.log('  4. Khóa Transaction bảo vệ quản lý cuối cùng:  [' + results.item4 + ']');
  console.log('  5. Dashboard COUNT(*) sản phẩm cần nhập:      [' + results.item5 + ']');
  console.log('========================================================================\n');
}

run().catch((err) => {
  console.error('\n❌ KIỂM THỬ THẤT BẠI:', err);
  process.exit(1);
});
