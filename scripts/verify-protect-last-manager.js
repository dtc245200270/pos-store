require('dotenv').config();
const assert = require('assert');
const { spawn } = require('child_process');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const TEST_PORT = 3004;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

async function run() {
  console.log('=== BẮT ĐẦU KIỂM THỬ CƠ CHẾ BẢO VỆ TÀI KHOẢN QUẢN LÝ CUỐI CÙNG ===\n');

  // 1. Kiểm tra tài khoản manager hiện tại trong database chính pos_store để ghi nhận trạng thái
  const prodPool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'pos_app',
    password: process.env.DB_PASSWORD || '290729',
    database: process.env.DB_NAME || 'pos_store'
  });
  const [prodManagers] = await prodPool.query("SELECT id, username, role, is_active FROM users WHERE username = 'manager'");
  console.log('Trạng thái manager hiện tại trong pos_store:', prodManagers[0]);
  assert.strictEqual(prodManagers.length, 1);
  assert.strictEqual(prodManagers[0].role, 'MANAGER');
  assert.strictEqual(prodManagers[0].is_active, 1);
  const prodMgrInitial = { ...prodManagers[0] };
  await prodPool.end();

  // 2. Chuẩn bị môi trường CSDL kiểm thử riêng biệt: pos_store_test
  const testPool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'pos_app',
    password: process.env.DB_PASSWORD || '290729',
    database: 'pos_store_test'
  });

  // Dọn dẹp tài khoản test cũ nếu còn sót lại từ lần chạy trước
  await testPool.query("DELETE FROM users WHERE username LIKE 'test_mgr_%' OR username LIKE 'test_csh_%'");

  // Lưu trạng thái các tài khoản MANAGER hiện có trong pos_store_test để khôi phục sau khi kiểm thử
  const [existingTestMgrs] = await testPool.query("SELECT id, role, is_active FROM users WHERE role = 'MANAGER'");
  // Đổi tạm vai trò các manager hiện có sang CASHIER để test_mgr_sole là Quản lý duy nhất trong hệ thống
  await testPool.query("UPDATE users SET role = 'CASHIER' WHERE role = 'MANAGER'");

  const testPass = 'PasswordTest123!@#';
  const testHash = await bcrypt.hash(testPass, 10);

  // Tạo duy nhất 1 Quản lý kiểm thử và 1 Thu ngân kiểm thử trong pos_store_test
  const [mgrInsert] = await testPool.query(
    "INSERT INTO users (username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, 'MANAGER', 1)",
    ['test_mgr_sole', testHash, 'Quản Lý Duy Nhất']
  );
  const testMgrSoleId = mgrInsert.insertId;

  const [cshInsert] = await testPool.query(
    "INSERT INTO users (username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, 'CASHIER', 1)",
    ['test_csh_sample', testHash, 'Thu Ngân Kiểm Thử']
  );
  const testCshSampleId = cshInsert.insertId;

  const [mgrCountRows] = await testPool.query("SELECT COUNT(*) as count FROM users WHERE role = 'MANAGER' AND is_active = 1");
  assert.strictEqual(mgrCountRows[0].count, 1, 'Môi trường test phải có đúng 1 manager hoạt động');
  console.log(`✓ Chuẩn bị dữ liệu kiểm thử riêng biệt (pos_store_test): Duy nhất 1 Quản lý (ID: ${testMgrSoleId}) và 1 Thu ngân (ID: ${testCshSampleId}).\n`);

  await testPool.end();

  // 3. Khởi động server kiểm thử riêng trên cổng TEST_PORT
  console.log(`Khởi động server kiểm thử trên cổng ${TEST_PORT} kết nối tới pos_store_test...`);
  const serverProcess = spawn('node', ['server.js'], {
    env: { ...process.env, DB_NAME: 'pos_store_test', SESSION_SECRET: 'secret_test_last_mgr', PORT: String(TEST_PORT), METRICS_PORT: '0' }
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
    // Đăng nhập bằng Quản lý duy nhất
    const csrfRes = await req('GET', '/api/auth/csrf');
    const loginRes = await req('POST', '/api/auth/login', {
      username: 'test_mgr_sole',
      password: testPass
    }, csrfRes.cookie, csrfRes.data.csrfToken);
    assert.strictEqual(loginRes.status, 200, 'Đăng nhập manager kiểm thử phải thành công');
    const mgrCookie = loginRes.cookie;
    const mgrCsrf = loginRes.data.csrfToken;
    console.log('✓ Đăng nhập thành công với tài khoản quản lý kiểm thử test_mgr_sole.');

    // ------------------------------------------------------------------------
    // KIỂM THỬ 1: CHẶN ĐỔI VAI TRÒ QUẢN LÝ CUỐI CÙNG THÀNH THU NGÂN
    // ------------------------------------------------------------------------
    console.log('\n--- Kiểm thử 1: Thao tác đổi vai trò quản lý cuối cùng thành Thu ngân ---');
    const demoteRes = await req('PUT', `/api/employees/${testMgrSoleId}`, {
      full_name: 'Quản Lý Duy Nhất',
      role: 'CASHIER'
    }, mgrCookie, mgrCsrf);

    assert.strictEqual(demoteRes.status, 400, 'Hạ quyền quản lý cuối cùng phải bị chặn với HTTP 400');
    assert.ok(
      demoteRes.data.error && demoteRes.data.error.includes('quản lý cuối cùng'),
      `Thông báo lỗi phải nêu rõ quản lý cuối cùng. Thực tế: ${demoteRes.data.error}`
    );
    console.log(`✓ Backend chặn thành công thao tác đổi vai trò quản lý cuối cùng sang Thu ngân (HTTP 400).`);
    console.log(`  Thông báo phản hồi: "${demoteRes.data.error}"`);

    // Xác minh dữ liệu không thay đổi
    const verifyDemoteDb = mysql.createPool({
      host: process.env.DB_HOST || '127.0.0.1',
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER || 'pos_app',
      password: process.env.DB_PASSWORD || '290729',
      database: 'pos_store_test'
    });
    const [demoteDbRows] = await verifyDemoteDb.query('SELECT role, is_active FROM users WHERE id = ?', [testMgrSoleId]);
    assert.strictEqual(demoteDbRows[0].role, 'MANAGER', 'Vai trò phải được giữ nguyên là MANAGER');
    assert.strictEqual(demoteDbRows[0].is_active, 1, 'Trạng thái hoạt động phải được giữ nguyên là 1');
    console.log('✓ Dữ liệu trong CSDL được giữ nguyên 100%: role = MANAGER, is_active = 1.');

    // ------------------------------------------------------------------------
    // KIỂM THỬ 2: CHẶN KHÓA TÀI KHOẢN QUẢN LÝ CUỐI CÙNG
    // ------------------------------------------------------------------------
    console.log('\n--- Kiểm thử 2: Thao tác khóa tài khoản quản lý cuối cùng ---');
    const lockRes = await req('PATCH', `/api/employees/${testMgrSoleId}/toggle-active`, {
      is_active: false
    }, mgrCookie, mgrCsrf);

    assert.strictEqual(lockRes.status, 400, 'Khóa quản lý cuối cùng phải bị chặn với HTTP 400');
    assert.ok(
      lockRes.data.error && lockRes.data.error.includes('quản lý cuối cùng'),
      `Thông báo lỗi phải nêu rõ quản lý cuối cùng. Thực tế: ${lockRes.data.error}`
    );
    console.log(`✓ Backend chặn thành công thao tác khóa quản lý cuối cùng (HTTP 400).`);
    console.log(`  Thông báo phản hồi: "${lockRes.data.error}"`);

    // Xác minh trạng thái trong CSDL
    const [lockDbRows] = await verifyDemoteDb.query('SELECT role, is_active FROM users WHERE id = ?', [testMgrSoleId]);
    assert.strictEqual(lockDbRows[0].role, 'MANAGER');
    assert.strictEqual(lockDbRows[0].is_active, 1, 'Tài khoản không được bị khóa, is_active phải giữ nguyên 1');
    console.log('✓ Dữ liệu trong CSDL được giữ nguyên: is_active = 1 (không bị khóa).');

    // ------------------------------------------------------------------------
    // KIỂM THỬ 3: CHẶN XÓA TÀI KHOẢN QUẢN LÝ CUỐI CÙNG
    // ------------------------------------------------------------------------
    console.log('\n--- Kiểm thử 3: Thao tác xóa tài khoản quản lý cuối cùng ---');
    const deleteRes = await req('DELETE', `/api/employees/${testMgrSoleId}`, null, mgrCookie, mgrCsrf);

    assert.strictEqual(deleteRes.status, 400, 'Xóa quản lý cuối cùng phải bị chặn với HTTP 400');
    assert.ok(
      deleteRes.data.error && deleteRes.data.error.includes('quản lý cuối cùng'),
      `Thông báo lỗi phải nêu rõ quản lý cuối cùng. Thực tế: ${deleteRes.data.error}`
    );
    console.log(`✓ Backend chặn thành công thao tác xóa quản lý cuối cùng (HTTP 400).`);
    console.log(`  Thông báo phản hồi: "${deleteRes.data.error}"`);

    // Xác minh tài khoản vẫn còn tồn tại trong CSDL
    const [delDbRows] = await verifyDemoteDb.query('SELECT id, role, is_active FROM users WHERE id = ?', [testMgrSoleId]);
    assert.strictEqual(delDbRows.length, 1, 'Tài khoản quản lý phải còn tồn tại trong CSDL');
    console.log('✓ Tài khoản quản lý vẫn tồn tại nguyên vẹn trong CSDL.');

    // ------------------------------------------------------------------------
    // KIỂM THỬ 4: QUYỀN TRUY CẬP VÀ PHIÊN LÀM VIỆC ĐƯỢC GIỮ NGUYÊN
    // ------------------------------------------------------------------------
    console.log('\n--- Kiểm thử 4: Quyền truy cập và phiên làm việc sau các thao tác bị chặn ---');
    const meRes = await req('GET', '/api/auth/me', null, mgrCookie);
    assert.strictEqual(meRes.status, 200, 'Phiên đăng nhập của quản lý phải tiếp tục hợp lệ');
    assert.strictEqual(meRes.data.role, 'MANAGER');
    console.log('✓ API /api/auth/me trả về HTTP 200, vai trò vẫn là MANAGER.');

    const empListRes = await req('GET', '/api/employees', null, mgrCookie);
    assert.strictEqual(empListRes.status, 200, 'Quản lý vẫn truy cập bình thường chức năng Quản lý');
    console.log(`✓ API /api/employees trả về HTTP 200, danh sách gồm ${empListRes.data.length} nhân viên.`);

    // ------------------------------------------------------------------------
    // KIỂM THỬ 5: TÌNH HUỐNG CÓ 2 QUẢN LÝ: QUẢN LÝ A KHÓA QUẢN LÝ B, SAU ĐÓ THỬ HẠ/XÓA QUẢN LÝ CUỐI CÙNG
    // ------------------------------------------------------------------------
    console.log('\n--- Kiểm thử 5: Kịch bản 2 Quản lý -> Khóa 1 Quản lý -> Quản lý còn lại là Quản lý hoạt động cuối cùng ---');
    // Tạo quản lý thứ hai test_mgr_second
    const createMgr2 = await req('POST', '/api/employees', {
      username: 'test_mgr_second',
      full_name: 'Quản Lý Thứ Hai',
      role: 'MANAGER',
      password: testPass,
      confirm_password: testPass
    }, mgrCookie, mgrCsrf);
    assert.strictEqual(createMgr2.status, 201);
    const mgr2Id = createMgr2.data.id;
    console.log(`  - Đã tạo thêm quản lý thứ 2 (ID: ${mgr2Id}). Lúc này có 2 quản lý hoạt động.`);

    // Khi có 2 quản lý hoạt động, quản lý 1 có thể đổi vai trò của quản lý 2 sang CASHIER
    const changeRoleMgr2 = await req('PUT', `/api/employees/${mgr2Id}`, {
      full_name: 'Quản Lý Thứ Hai',
      role: 'CASHIER'
    }, mgrCookie, mgrCsrf);
    assert.strictEqual(changeRoleMgr2.status, 200, 'Khi còn quản lý khác đang hoạt động, được phép đổi vai trò sang Cashier');
    console.log('✓ Khi hệ thống còn quản lý hoạt động khác, cho phép đổi vai trò quản lý phụ thành Thu ngân.');

    // Nâng lại quyền của mgr2 lên MANAGER
    const promoteMgr2 = await req('PUT', `/api/employees/${mgr2Id}`, {
      full_name: 'Quản Lý Thứ Hai',
      role: 'MANAGER'
    }, mgrCookie, mgrCsrf);
    assert.strictEqual(promoteMgr2.status, 200);

    // Khóa Quản lý 2: lúc này Quản lý 2 is_active = 0 -> test_mgr_sole là quản lý HOẠT ĐỘNG cuối cùng!
    const lockMgr2Res = await req('PATCH', `/api/employees/${mgr2Id}/toggle-active`, { is_active: false }, mgrCookie, mgrCsrf);
    assert.strictEqual(lockMgr2Res.status, 200);
    console.log('  - Đã khóa quản lý thứ 2. Lúc này test_mgr_sole là QUẢN LÝ HOẠT ĐỘNG DUY NHẤT.');

    // Giờ test_mgr_sole là quản lý hoạt động cuối cùng -> Thử đổi vai trò của test_mgr_sole thành CASHIER -> BỊ CHẶN
    const demoteLastActiveRes = await req('PUT', `/api/employees/${testMgrSoleId}`, {
      full_name: 'Quản Lý Duy Nhất',
      role: 'CASHIER'
    }, mgrCookie, mgrCsrf);
    assert.strictEqual(demoteLastActiveRes.status, 400);
    assert.ok(demoteLastActiveRes.data.error.includes('quản lý cuối cùng'));
    console.log(`✓ Chặn đổi vai trò khi chỉ còn 1 quản lý hoạt động (HTTP 400): "${demoteLastActiveRes.data.error}".`);

    // Thử khóa test_mgr_sole -> BỊ CHẶN
    const lockLastActiveRes = await req('PATCH', `/api/employees/${testMgrSoleId}/toggle-active`, { is_active: false }, mgrCookie, mgrCsrf);
    assert.strictEqual(lockLastActiveRes.status, 400);
    assert.ok(lockLastActiveRes.data.error.includes('quản lý cuối cùng'));
    console.log(`✓ Chặn khóa khi chỉ còn 1 quản lý hoạt động (HTTP 400): "${lockLastActiveRes.data.error}".`);

    // Xóa quản lý thứ 2 (đang là Cashier hoặc Manager inactive và chưa có chứng từ)
    const delMgr2Res = await req('DELETE', `/api/employees/${mgr2Id}`, null, mgrCookie, mgrCsrf);
    assert.strictEqual(delMgr2Res.status, 200, 'Xóa quản lý phụ khi vẫn còn quản lý chính hoạt động');
    console.log('✓ Xóa quản lý phụ thành công khi vẫn còn quản lý chính hoạt động.');

    // Giờ chỉ còn 1 quản lý duy nhất trong DB: Thử xóa test_mgr_sole -> BỊ CHẶN
    const delSoleRes = await req('DELETE', `/api/employees/${testMgrSoleId}`, null, mgrCookie, mgrCsrf);
    assert.strictEqual(delSoleRes.status, 400);
    assert.ok(delSoleRes.data.error.includes('quản lý cuối cùng'));
    console.log(`✓ Chặn xóa quản lý cuối cùng trong hệ thống (HTTP 400): "${delSoleRes.data.error}".`);

    await verifyDemoteDb.end();

    // ------------------------------------------------------------------------
    // KIỂM THỬ 6: ĐẢM BẢO TÀI KHOẢN MANAGER HIỆN TẠI TRONG POS_STORE KHÔNG BỊ ẢNH HƯỞNG
    // ------------------------------------------------------------------------
    console.log('\n--- Kiểm thử 6: Đối chiếu an toàn tài khoản manager hiện tại trong pos_store ---');
    const finalProdPool = mysql.createPool({
      host: process.env.DB_HOST || '127.0.0.1',
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER || 'pos_app',
      password: process.env.DB_PASSWORD || '290729',
      database: process.env.DB_NAME || 'pos_store'
    });
    const [finalProdManagers] = await finalProdPool.query("SELECT id, username, role, is_active FROM users WHERE username = 'manager'");
    console.log('Trạng thái manager hiện tại trong pos_store:', finalProdManagers[0]);
    assert.strictEqual(finalProdManagers[0].id, prodMgrInitial.id);
    assert.strictEqual(finalProdManagers[0].role, 'MANAGER');
    assert.strictEqual(finalProdManagers[0].is_active, 1);
    await finalProdPool.end();
    console.log('✓ Tài khoản manager ID 1 trong CSDL pos_store được bảo toàn tuyệt đối 100%.');

    console.log('\n=================================================================');
    console.log('🎉 TẤT CẢ CÁC KIỂM THỬ BẢO VỆ QUẢN LÝ CUỐI CÙNG ĐÃ ĐẠT 100%! 🎉');
    console.log('=================================================================\n');
  } finally {
    if (serverProcess) serverProcess.kill();
    try {
      const cleanupPool = mysql.createPool({
        host: process.env.DB_HOST || '127.0.0.1',
        port: process.env.DB_PORT || 3306,
        user: process.env.DB_USER || 'pos_app',
        password: process.env.DB_PASSWORD || '290729',
        database: 'pos_store_test'
      });
      for (const m of existingTestMgrs) {
        await cleanupPool.query("UPDATE users SET role = ?, is_active = ? WHERE id = ?", [m.role, m.is_active, m.id]);
      }
      await cleanupPool.query("DELETE FROM users WHERE username LIKE 'test_mgr_%' OR username LIKE 'test_csh_%'");
      await cleanupPool.end();
      console.log('✓ Đã khôi phục và dọn dẹp sạch sẽ CSDL pos_store_test.');
    } catch (cleanupErr) {
      console.error('Lỗi dọn dẹp pos_store_test:', cleanupErr);
    }
  }
}

run().catch((err) => {
  console.error('\n❌ KIỂM THỬ THẤT BẠI:', err);
  process.exit(1);
});
