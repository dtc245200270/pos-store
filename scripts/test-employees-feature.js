require('dotenv').config();
const assert = require('assert');
const { spawn } = require('child_process');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const TEST_PORT = 3003;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

async function run() {
  console.log('=== BẮT ĐẦU KIỂM THỬ HOÀN THIỆN TRANG TÀI KHOẢN NHÂN VIÊN ===\n');

  // 1. Chuẩn bị database pos_store_test
  const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'pos_app',
    password: process.env.DB_PASSWORD || '290729',
    database: 'pos_store_test'
  });

  const hash = await bcrypt.hash('password123', 10);
  await pool.query('INSERT IGNORE INTO users (username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?)',
    ['emp_mgr', hash, 'Quản Lý Trưởng', 'MANAGER', 1]);
  await pool.query('INSERT IGNORE INTO users (username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?)',
    ['emp_csh', hash, 'Thu Ngân Một', 'CASHIER', 1]);
  await pool.end();

  // 2. Khởi động server test trên port 3003
  console.log('1. Khởi động server kiểm thử trên cổng ' + TEST_PORT + '...');
  const serverProcess = spawn('node', ['server.js'], {
    env: { ...process.env, DB_NAME: 'pos_store_test', SESSION_SECRET: 'test_emp_secret', PORT: String(TEST_PORT), METRICS_PORT: '0' }
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
    // ------------------------------------------------------------------------
    // BƯỚC 1: ĐĂNG NHẬP MANAGER & CASHIER, KIỂM TRA PHÂN QUYỀN
    // ------------------------------------------------------------------------
    console.log('--- Bước 1: Kiểm tra phân quyền truy cập chức năng Tài khoản nhân viên ---');
    // Manager login
    const csrfMgr = await req('GET', '/api/auth/csrf');
    const loginMgr = await req('POST', '/api/auth/login', { username: 'emp_mgr', password: 'password123' }, csrfMgr.cookie, csrfMgr.data.csrfToken);
    assert.strictEqual(loginMgr.status, 200);
    const mgrCookie = loginMgr.cookie;
    const mgrCsrf = loginMgr.data.csrfToken;

    // Cashier login
    const csrfCsh = await req('GET', '/api/auth/csrf');
    const loginCsh = await req('POST', '/api/auth/login', { username: 'emp_csh', password: 'password123' }, csrfCsh.cookie, csrfCsh.data.csrfToken);
    assert.strictEqual(loginCsh.status, 200);
    const cshCookie = loginCsh.cookie;
    const cshCsrf = loginCsh.data.csrfToken;

    // Manager truy cập trang & API employees: Thành công 200
    const pageMgrRes = await req('GET', '/employees', null, mgrCookie);
    assert.strictEqual(pageMgrRes.status, 200, 'Manager phải mở được /employees');
    const apiMgrRes = await req('GET', '/api/employees', null, mgrCookie);
    assert.strictEqual(apiMgrRes.status, 200, 'Manager phải gọi được /api/employees');
    console.log('✓ Manager truy cập giao diện và API nhân viên thành công (HTTP 200).');

    // Cashier truy cập trang & API employees: Bị chặn 403 Forbidden
    const pageCshRes = await req('GET', '/employees', null, cshCookie);
    assert.strictEqual(pageCshRes.status, 403, 'Cashier không được vào /employees');
    const apiCshRes = await req('GET', '/api/employees', null, cshCookie);
    assert.strictEqual(apiCshRes.status, 403, 'Cashier không được gọi /api/employees');
    console.log('✓ Cashier bị chặn khi truy cập trang và toàn bộ API nhân viên (HTTP 403 FORBIDDEN).');

    // ------------------------------------------------------------------------
    // BƯỚC 2: TẠO THU NGÂN, TRÙNG USERNAME, MẬT KHẨU KHÔNG KHỚP
    // ------------------------------------------------------------------------
    console.log('\n--- Bước 2: Kiểm thử tạo thu ngân, trùng tên đăng nhập & xác nhận mật khẩu ---');
    const uniqueUser = 'cashier_' + Date.now();

    // 2.1 Thử tạo với xác nhận mật khẩu sai
    const failConfirmRes = await req('POST', '/api/employees', {
      username: uniqueUser,
      full_name: 'Nguyễn Thu Ngân Mới',
      role: 'CASHIER',
      password: 'password_safe_1',
      confirm_password: 'password_safe_DIFFERENT'
    }, mgrCookie, mgrCsrf);
    assert.strictEqual(failConfirmRes.status, 400);
    assert.ok(failConfirmRes.data.error.includes('không khớp'), 'Phải báo lỗi xác nhận mật khẩu không khớp');
    console.log('✓ Từ chối tạo tài khoản khi xác nhận mật khẩu không khớp.');

    // 2.2 Tạo thu ngân hợp lệ
    const createRes = await req('POST', '/api/employees', {
      username: uniqueUser,
      full_name: 'Nguyễn Thu Ngân Mới',
      role: 'CASHIER',
      password: 'password_safe_123',
      confirm_password: 'password_safe_123'
    }, mgrCookie, mgrCsrf);
    assert.strictEqual(createRes.status, 201);
    const newEmpId = createRes.data.id;
    console.log(`✓ Tạo thu ngân mới thành công (ID: ${newEmpId}, Username: ${uniqueUser}).`);

    // 2.3 Thử tạo lại với cùng tên đăng nhập (trùng username)
    const duplicateRes = await req('POST', '/api/employees', {
      username: uniqueUser,
      full_name: 'Người Trùng Tên',
      role: 'CASHIER',
      password: 'password_safe_123',
      confirm_password: 'password_safe_123'
    }, mgrCookie, mgrCsrf);
    assert.strictEqual(duplicateRes.status, 400);
    assert.ok(duplicateRes.data.error.includes('đã tồn tại'), 'Phải báo lỗi tên đăng nhập đã tồn tại');
    console.log('✓ Từ chối tạo tài khoản khi trùng tên đăng nhập.');

    // 2.4 Kiểm tra danh sách nhân viên không chứa password_hash
    const listRes = await req('GET', '/api/employees', null, mgrCookie);
    assert.strictEqual(listRes.status, 200);
    listRes.data.forEach(user => {
      assert.strictEqual(user.password_hash, undefined, 'Tuyệt đối KHÔNG trả về password_hash');
      assert.strictEqual(user.password, undefined, 'Tuyệt đối KHÔNG trả về password');
    });
    console.log('✓ Danh sách tài khoản nhân viên trả về đầy đủ, bảo mật tuyệt đối không chứa password_hash.');

    // ------------------------------------------------------------------------
    // BƯỚC 3: TÌM KIẾM VÀ LỌC THEO TRẠNG THÁI
    // ------------------------------------------------------------------------
    console.log('\n--- Bước 3: Kiểm thử tìm kiếm tài khoản và lọc theo trạng thái ---');
    // Tìm kiếm theo username vừa tạo
    const searchRes = await req('GET', `/api/employees?q=${uniqueUser}`, null, mgrCookie);
    assert.strictEqual(searchRes.status, 200);
    assert.strictEqual(searchRes.data.length, 1);
    assert.strictEqual(searchRes.data[0].username, uniqueUser);
    console.log(`✓ Tìm kiếm theo tên đăng nhập "${uniqueUser}": Tìm thấy đúng 1 kết quả.`);

    // Lọc theo trạng thái active
    const activeRes = await req('GET', '/api/employees?status=active', null, mgrCookie);
    assert.strictEqual(activeRes.status, 200);
    activeRes.data.forEach(u => assert.strictEqual(u.is_active, 1));
    console.log(`✓ Lọc theo trạng thái "active": Tất cả ${activeRes.data.length} tài khoản đều có is_active = 1.`);

    // ------------------------------------------------------------------------
    // BƯỚC 4: SỬA HỌ TÊN VÀ ĐỔI VAI TRÒ
    // ------------------------------------------------------------------------
    console.log('\n--- Bước 4: Kiểm thử sửa họ tên và cập nhật vai trò ---');
    const updateRes = await req('PUT', `/api/employees/${newEmpId}`, {
      full_name: 'Nguyễn Thu Ngân Đã Đổi Tên',
      role: 'CASHIER'
    }, mgrCookie, mgrCsrf);
    assert.strictEqual(updateRes.status, 200);

    const verifyUpdate = await req('GET', `/api/employees?q=${uniqueUser}`, null, mgrCookie);
    assert.strictEqual(verifyUpdate.data[0].full_name, 'Nguyễn Thu Ngân Đã Đổi Tên');
    console.log('✓ Sửa họ tên nhân viên thành công.');

    // ------------------------------------------------------------------------
    // BƯỚC 5: ĐẶT LẠI MẬT KHẨU & ĐĂNG NHẬP VỚI MẬT KHẨU MỚI
    // ------------------------------------------------------------------------
    console.log('\n--- Bước 5: Kiểm thử đặt lại mật khẩu và đăng nhập với mật khẩu mới ---');
    const newPassword = 'new_password_strong_999';
    const resetRes = await req('PATCH', `/api/employees/${newEmpId}/reset-password`, {
      password: newPassword,
      confirm_password: newPassword
    }, mgrCookie, mgrCsrf);
    assert.strictEqual(resetRes.status, 200);
    console.log('✓ Đặt lại mật khẩu thành công (không để lộ mật khẩu hiện tại).');

    // Thử đăng nhập với mật khẩu mới
    const testLoginCsrf = await req('GET', '/api/auth/csrf');
    const testLoginRes = await req('POST', '/api/auth/login', {
      username: uniqueUser,
      password: newPassword
    }, testLoginCsrf.cookie, testLoginCsrf.data.csrfToken);
    assert.strictEqual(testLoginRes.status, 200, 'Thu ngân phải đăng nhập được với mật khẩu mới');
    console.log('✓ Thu ngân đăng nhập thành công với mật khẩu mới đã đặt lại.');

    // ------------------------------------------------------------------------
    // BƯỚC 6: KHÓA / MỞ KHÓA TÀI KHOẢN & TÀI KHOẢN BỊ KHÓA KHÔNG ĐƯỢC ĐĂNG NHẬP
    // ------------------------------------------------------------------------
    console.log('\n--- Bước 6: Kiểm thử Khóa/Mở khóa tài khoản & ngăn chặn đăng nhập ---');
    // Khóa tài khoản
    const lockRes = await req('PATCH', `/api/employees/${newEmpId}/toggle-active`, { is_active: false }, mgrCookie, mgrCsrf);
    assert.strictEqual(lockRes.status, 200);
    assert.strictEqual(lockRes.data.is_active, false);
    console.log(`✓ Đã khóa tài khoản "${uniqueUser}".`);

    // Thử đăng nhập bằng tài khoản vừa bị khóa -> Bị từ chối (401)
    const lockLoginCsrf = await req('GET', '/api/auth/csrf');
    const lockLoginRes = await req('POST', '/api/auth/login', {
      username: uniqueUser,
      password: newPassword
    }, lockLoginCsrf.cookie, lockLoginCsrf.data.csrfToken);
    assert.strictEqual(lockLoginRes.status, 401, 'Tài khoản bị khóa không được phép đăng nhập');
    console.log('✓ Tài khoản bị khóa không thể đăng nhập vào hệ thống (HTTP 401).');

    // Mở khóa lại
    const unlockRes = await req('PATCH', `/api/employees/${newEmpId}/toggle-active`, { is_active: true }, mgrCookie, mgrCsrf);
    assert.strictEqual(unlockRes.status, 200);
    assert.strictEqual(unlockRes.data.is_active, true);
    console.log(`✓ Đã mở khóa lại tài khoản "${uniqueUser}".`);

    // ------------------------------------------------------------------------
    // BƯỚC 7: TÀI KHOẢN BỊ KHÓA KHI ĐANG ĐĂNG NHẬP (MID-SESSION LOCK)
    // ------------------------------------------------------------------------
    console.log('\n--- Bước 7: Kiểm thử tài khoản bị khóa khi đang đăng nhập (Mid-session lock) ---');
    // Đăng nhập tài khoản
    const midCsrf = await req('GET', '/api/auth/csrf');
    const midLogin = await req('POST', '/api/auth/login', {
      username: uniqueUser,
      password: newPassword
    }, midCsrf.cookie, midCsrf.data.csrfToken);
    assert.strictEqual(midLogin.status, 200);
    const midUserCookie = midLogin.cookie;

    // Kiểm tra request hợp lệ khi tài khoản còn active
    const midCheckBefore = await req('GET', '/api/auth/me', null, midUserCookie);
    assert.strictEqual(midCheckBefore.status, 200);

    // Quản lý tiến hành khóa tài khoản
    await req('PATCH', `/api/employees/${newEmpId}/toggle-active`, { is_active: false }, mgrCookie, mgrCsrf);
    console.log(`  - Tài khoản "${uniqueUser}" đã bị Quản lý khóa trong khi phiên làm việc vẫn đang mở.`);

    // Yêu cầu tiếp theo của tài khoản bị khóa phải bị từ chối 401 và yêu cầu đăng nhập lại
    const midCheckAfter = await req('GET', '/api/auth/me', null, midUserCookie);
    assert.strictEqual(midCheckAfter.status, 401, 'Phiên làm việc phải bị hủy ngay lập tức khi tài khoản bị khóa');
    console.log('✓ Yêu cầu tiếp theo của tài khoản bị khóa bị từ chối ngay lập tức (HTTP 401, yêu cầu đăng nhập lại).');

    // ------------------------------------------------------------------------
    // BƯỚC 8: BẢO VỆ QUẢN LÝ HOẠT ĐỘNG CUỐI CÙNG
    // ------------------------------------------------------------------------
    console.log('\n--- Bước 8: Kiểm thử bảo vệ quản lý hoạt động cuối cùng ---');
    // Tìm ID của emp_mgr
    const mgrList = await req('GET', '/api/employees?q=emp_mgr', null, mgrCookie);
    const empMgrId = mgrList.data[0].id;

    // 8.1 Thử khóa tài khoản của chính mình -> Bị chặn
    const selfLockRes = await req('PATCH', `/api/employees/${empMgrId}/toggle-active`, { is_active: false }, mgrCookie, mgrCsrf);
    assert.strictEqual(selfLockRes.status, 400);
    assert.ok(selfLockRes.data.error.includes('chính mình'), 'Phải chặn tự khóa tài khoản của chính mình');
    console.log('✓ Chặn tự khóa tài khoản quản lý của chính mình.');

    // 8.2 Thử tự hạ quyền của chính mình -> Bị chặn
    const selfDemoteRes = await req('PUT', `/api/employees/${empMgrId}`, { full_name: 'Quản Lý Trưởng', role: 'CASHIER' }, mgrCookie, mgrCsrf);
    assert.strictEqual(selfDemoteRes.status, 400);
    assert.ok(selfDemoteRes.data.error.includes('chính mình') || selfDemoteRes.data.error.includes('cuối cùng'));
    console.log('✓ Chặn tự hạ quyền quản lý của chính mình.');

    // 8.3 Tạo manager thứ 2, sau đó kiểm tra nếu chỉ còn 1 manager active thì không cho khóa/hạ quyền
    const mgr2User = 'manager_two_' + Date.now();
    const createMgr2 = await req('POST', '/api/employees', {
      username: mgr2User,
      full_name: 'Quản Lý Thứ Hai',
      role: 'MANAGER',
      password: 'password_safe_123',
      confirm_password: 'password_safe_123'
    }, mgrCookie, mgrCsrf);
    const mgr2Id = createMgr2.data.id;
    console.log(`  - Đã tạo thêm quản lý thứ 2 (ID: ${mgr2Id}).`);

    // Khóa quản lý 2 -> Lúc này chỉ còn 1 quản lý hoạt động (emp_mgr)
    const lockMgr2 = await req('PATCH', `/api/employees/${mgr2Id}/toggle-active`, { is_active: false }, mgrCookie, mgrCsrf);
    assert.strictEqual(lockMgr2.status, 200);

    // Thử dùng tài khoản thứ 2 đăng nhập khi mở khóa và hạ quyền emp_mgr
    // Mở khóa mgr2 để mgr2 đăng nhập và thử hạ quyền emp_mgr
    await req('PATCH', `/api/employees/${mgr2Id}/toggle-active`, { is_active: true }, mgrCookie, mgrCsrf);
    const csrf2 = await req('GET', '/api/auth/csrf');
    const loginMgr2 = await req('POST', '/api/auth/login', { username: mgr2User, password: 'password_safe_123' }, csrf2.cookie, csrf2.data.csrfToken);
    const mgr2Cookie = loginMgr2.cookie;
    const mgr2Csrf = loginMgr2.data.csrfToken;

    // Giờ mgr2 khóa lại emp_mgr
    await req('PATCH', `/api/employees/${empMgrId}/toggle-active`, { is_active: false }, mgr2Cookie, mgr2Csrf);
    // Hiện tại chỉ còn DUY NHẤT mgr2 là quản lý hoạt động!
    // Thử hạ quyền mgr2 (quản lý hoạt động cuối cùng) -> Phải bị chặn
    const demoteLastMgr = await req('PUT', `/api/employees/${mgr2Id}`, { full_name: 'Quản Lý 2', role: 'CASHIER' }, mgr2Cookie, mgr2Csrf);
    assert.strictEqual(demoteLastMgr.status, 400);
    assert.ok(demoteLastMgr.data.error.includes('cuối cùng') || demoteLastMgr.data.error.includes('chính mình'));
    console.log('✓ Chặn hạ quyền quản lý hoạt động cuối cùng trong hệ thống.');

    // Khôi phục lại emp_mgr active
    await req('PATCH', `/api/employees/${empMgrId}/toggle-active`, { is_active: true }, mgr2Cookie, mgr2Csrf);

    // ------------------------------------------------------------------------
    // BƯỚC 9: KHÔNG XÓA TÀI KHOẢN ĐÃ LIÊN QUAN ĐẾN CHỨNG TỪ
    // ------------------------------------------------------------------------
    console.log('\n--- Bước 9: Kiểm thử không cho xóa tài khoản đã có chứng từ ---');
    // Lấy ID của emp_csh (đã có thể có chứng từ trong test hoặc tạo 1 hóa đơn)
    const cshList = await req('GET', '/api/employees?q=emp_csh', null, mgrCookie);
    const cshId = cshList.data[0].id;

    // Giả lập emp_csh tạo một hóa đơn bán hàng
    const testDbPool = mysql.createPool({
      host: process.env.DB_HOST || '127.0.0.1',
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER || 'pos_app',
      password: process.env.DB_PASSWORD || '290729',
      database: 'pos_store_test'
    });
    const invNo = 'HD_TEST_' + Date.now();
    await testDbPool.query(
      `INSERT INTO invoices (invoice_no, created_by, request_key, request_hash, total_amount)
       VALUES (?, ?, ?, ?, ?)`,
      [invNo, cshId, 'req_' + Date.now(), 'a'.repeat(64), 50000]
    );
    await testDbPool.end();

    // Thử xóa emp_csh -> Phải bị chặn 400 vì đã có hóa đơn
    const delResWithInvoice = await req('DELETE', `/api/employees/${cshId}`, null, mgrCookie, mgrCsrf);
    assert.strictEqual(delResWithInvoice.status, 400, 'Không được xóa nhân viên đã có hóa đơn');
    assert.ok(delResWithInvoice.data.error.includes('chứng từ') || delResWithInvoice.data.error.includes('hóa đơn'));
    console.log('✓ Chặn thành công thao tác xóa tài khoản đã lập chứng từ hóa đơn.');

    // Thử xóa tài khoản chưa có chứng từ (newEmpId) -> Thành công
    const delResNoInvoice = await req('DELETE', `/api/employees/${newEmpId}`, null, mgrCookie, mgrCsrf);
    assert.strictEqual(delResNoInvoice.status, 200, 'Xóa tài khoản chưa có chứng từ phải thành công');
    console.log('✓ Xóa tài khoản chưa có chứng từ thành công.');

    console.log('\n=== TẤT CẢ CÁC BƯỚC KIỂM THỬ TÀI KHOẢN NHÂN VIÊN ĐÃ ĐẠT 100%! ===');
  } finally {
    serverProcess.kill();
  }
}

run().catch((err) => {
  console.error('\n❌ KIỂM THỬ THẤT BẠI:', err);
  process.exit(1);
});
