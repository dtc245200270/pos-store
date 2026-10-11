require('dotenv').config();
const assert = require('assert');
const { spawn } = require('child_process');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const TEST_PORT = 3004;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

async function run() {
  console.log('=== BẮT ĐẦU KIỂM THỬ TÍNH NĂNG TÀI KHOẢN CỦA TÔI & ĐỔI MẬT KHẨU ===\n');

  // 1. Chuẩn bị database pos_store_test
  const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'pos_app',
    password: process.env.DB_PASSWORD || '290729',
    database: 'pos_store_test'
  });

  const hash = await bcrypt.hash('init_pass_123', 10);
  await pool.query('INSERT IGNORE INTO users (username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?)',
    ['prof_mgr', hash, 'Quản Lý Hồ Sơ', 'MANAGER', 1]);
  await pool.query('INSERT IGNORE INTO users (username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?)',
    ['prof_csh', hash, 'Thu Ngân Hồ Sơ', 'CASHIER', 1]);
  await pool.end();

  // 2. Khởi động server test trên port 3004
  console.log('1. Khởi động server kiểm thử trên cổng ' + TEST_PORT + '...');
  const serverProcess = spawn('node', ['server.js'], {
    env: { ...process.env, DB_NAME: 'pos_store_test', SESSION_SECRET: 'test_prof_secret', PORT: String(TEST_PORT) }
  });

  await new Promise((resolve) => {
    serverProcess.stdout.on('data', (d) => {
      if (d.toString().includes('Website đang chạy')) resolve();
    });
    setTimeout(resolve, 3000);
  });
  console.log('✓ Server kiểm thử đã sẵn sàng.\n');

  const req = async (method, path, body = null, cookie = '', csrf = '', redirect = 'follow') => {
    const headers = { 'Content-Type': 'application/json' };
    if (cookie) headers['Cookie'] = cookie;
    if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;

    const options = { method, headers, redirect };
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
    // BƯỚC 1: TRUY CẬP TRANG TÀI KHOẢN CỦA TÔI CHO CẢ HAI VAI TRÒ
    // ------------------------------------------------------------------------
    console.log('--- Bước 1: Kiểm thử cả 2 vai trò truy cập trang Tài khoản của tôi (/profile) ---');

    // 1.1 MANAGER đăng nhập và mở /profile
    const csrfMgr = await req('GET', '/api/auth/csrf');
    const loginMgr = await req('POST', '/api/auth/login', { username: 'prof_mgr', password: 'init_pass_123' }, csrfMgr.cookie, csrfMgr.data.csrfToken);
    assert.strictEqual(loginMgr.status, 200);
    const mgrCookie = loginMgr.cookie;
    const mgrCsrf = loginMgr.data.csrfToken;

    const mgrProfilePage = await req('GET', '/profile', null, mgrCookie);
    assert.strictEqual(mgrProfilePage.status, 200, 'Manager phải mở được /profile');
    const mgrProfileData = await req('GET', '/api/auth/me', null, mgrCookie);
    assert.strictEqual(mgrProfileData.status, 200);
    assert.strictEqual(mgrProfileData.data.username, 'prof_mgr');
    assert.strictEqual(mgrProfileData.data.role, 'MANAGER');
    assert.strictEqual(mgrProfileData.data.password_hash, undefined);
    console.log('✓ Manager truy cập /profile thành công, hiển thị đúng thông tin, không chứa password_hash.');

    // 1.2 CASHIER đăng nhập và mở /profile
    const csrfCsh = await req('GET', '/api/auth/csrf');
    const loginCsh = await req('POST', '/api/auth/login', { username: 'prof_csh', password: 'init_pass_123' }, csrfCsh.cookie, csrfCsh.data.csrfToken);
    assert.strictEqual(loginCsh.status, 200);
    const cshCookie = loginCsh.cookie;
    const cshCsrf = loginCsh.data.csrfToken;

    const cshProfilePage = await req('GET', '/profile', null, cshCookie);
    assert.strictEqual(cshProfilePage.status, 200, 'Cashier phải mở được /profile');
    const cshProfileData = await req('GET', '/api/auth/me', null, cshCookie);
    assert.strictEqual(cshProfileData.status, 200);
    assert.strictEqual(cshProfileData.data.username, 'prof_csh');
    assert.strictEqual(cshProfileData.data.role, 'CASHIER');
    assert.strictEqual(cshProfileData.data.password_hash, undefined);
    console.log('✓ Cashier truy cập /profile thành công, hiển thị đúng thông tin, không chứa password_hash.');

    // ------------------------------------------------------------------------
    // BƯỚC 2: KIỂM THỬ XÁC THỰC KHI ĐỔI MẬT KHẨU
    // ------------------------------------------------------------------------
    console.log('\n--- Bước 2: Kiểm thử xác thực khi đổi mật khẩu ---');

    // 2.1 Mật khẩu hiện tại sai
    const wrongCurRes = await req('POST', '/api/auth/change-password', {
      current_password: 'wrong_password_xyz',
      new_password: 'brand_new_pass_456',
      confirm_password: 'brand_new_pass_456'
    }, cshCookie, cshCsrf);
    assert.strictEqual(wrongCurRes.status, 400);
    assert.ok(wrongCurRes.data.error.includes('hiện tại không chính xác'), 'Phải báo mật khẩu hiện tại không chính xác');
    console.log('✓ Từ chối khi mật khẩu hiện tại không đúng.');

    // 2.2 Xác nhận mật khẩu mới không khớp
    const mismatchRes = await req('POST', '/api/auth/change-password', {
      current_password: 'init_pass_123',
      new_password: 'brand_new_pass_456',
      confirm_password: 'mismatched_pass_789'
    }, cshCookie, cshCsrf);
    assert.strictEqual(mismatchRes.status, 400);
    assert.ok(mismatchRes.data.error.includes('không khớp'), 'Phải báo xác nhận mật khẩu không khớp');
    console.log('✓ Từ chối khi xác nhận mật khẩu mới không khớp.');

    // 2.3 Mật khẩu mới < 8 ký tự
    const shortRes = await req('POST', '/api/auth/change-password', {
      current_password: 'init_pass_123',
      new_password: 'short',
      confirm_password: 'short'
    }, cshCookie, cshCsrf);
    assert.strictEqual(shortRes.status, 400);
    assert.ok(shortRes.data.error.includes('8 ký tự'));
    console.log('✓ Từ chối khi mật khẩu mới ít hơn 8 ký tự.');

    // 2.4 Mật khẩu mới trùng mật khẩu cũ
    const sameRes = await req('POST', '/api/auth/change-password', {
      current_password: 'init_pass_123',
      new_password: 'init_pass_123',
      confirm_password: 'init_pass_123'
    }, cshCookie, cshCsrf);
    assert.strictEqual(sameRes.status, 400);
    assert.ok(sameRes.data.error.includes('trùng'));
    console.log('✓ Từ chối khi mật khẩu mới trùng với mật khẩu hiện tại.');

    // ------------------------------------------------------------------------
    // BƯỚC 3: ĐỔI MẬT KHẨU THÀNH CÔNG & VÔ HIỆU HÓA CÁC PHIÊN CŨ
    // ------------------------------------------------------------------------
    console.log('\n--- Bước 3: Đổi mật khẩu thành công & vô hiệu hóa các phiên cũ ---');
    // Tạo thêm phiên thứ 2 cho cùng tài khoản prof_csh (giả lập đăng nhập ở thiết bị khác)
    const secondLoginCsrf = await req('GET', '/api/auth/csrf');
    const secondLogin = await req('POST', '/api/auth/login', { username: 'prof_csh', password: 'init_pass_123' }, secondLoginCsrf.cookie, secondLoginCsrf.data.csrfToken);
    assert.strictEqual(secondLogin.status, 200);
    const secondDeviceCookie = secondLogin.cookie;

    // Kiểm tra phiên thứ 2 hoạt động bình thường
    const checkSecondBefore = await req('GET', '/api/auth/me', null, secondDeviceCookie);
    assert.strictEqual(checkSecondBefore.status, 200);

    // Tiến hành đổi mật khẩu thành công trên phiên thứ 1
    const newPassword = 'brand_new_pass_456!';
    const changeSuccessRes = await req('POST', '/api/auth/change-password', {
      current_password: 'init_pass_123',
      new_password: newPassword,
      confirm_password: newPassword
    }, cshCookie, cshCsrf);
    assert.strictEqual(changeSuccessRes.status, 200);
    assert.ok(changeSuccessRes.data.message.includes('thành công'));
    console.log('✓ Đổi mật khẩu thành công.');

    // Kiểm tra phiên thứ 1 (vừa đổi mật khẩu): bị hủy ngay lập tức
    const checkFirstAfter = await req('GET', '/api/auth/me', null, cshCookie);
    assert.strictEqual(checkFirstAfter.status, 401, 'Phiên vừa đổi mật khẩu phải bị hủy yêu cầu đăng nhập lại');
    console.log('✓ Phiên vừa đổi mật khẩu bị hủy ngay lập tức (HTTP 401).');

    // Kiểm tra phiên thứ 2 (thiết bị khác): cũng bị vô hiệu hóa ngay lập tức!
    const checkSecondAfter = await req('GET', '/api/auth/me', null, secondDeviceCookie);
    assert.strictEqual(checkSecondAfter.status, 401, 'Tất cả các phiên cũ khác phải bị vô hiệu hóa');
    console.log('✓ Toàn bộ các phiên cũ khác của tài khoản bị vô hiệu hóa triệt để (HTTP 401).');

    // ------------------------------------------------------------------------
    // BƯỚC 4: ĐĂNG NHẬP BẰNG MẬT KHẨU CŨ & MẬT KHẨU MỚI
    // ------------------------------------------------------------------------
    console.log('\n--- Bước 4: Kiểm thử đăng nhập với mật khẩu cũ và mới ---');
    // Đăng nhập bằng mật khẩu cũ -> Thất bại 401
    const tryOldCsrf = await req('GET', '/api/auth/csrf');
    const tryOldLogin = await req('POST', '/api/auth/login', { username: 'prof_csh', password: 'init_pass_123' }, tryOldCsrf.cookie, tryOldCsrf.data.csrfToken);
    assert.strictEqual(tryOldLogin.status, 401, 'Không được phép đăng nhập bằng mật khẩu cũ');
    console.log('✓ Đăng nhập bằng mật khẩu cũ bị từ chối (HTTP 401).');

    // Đăng nhập bằng mật khẩu mới -> Thành công 200
    const tryNewCsrf = await req('GET', '/api/auth/csrf');
    const tryNewLogin = await req('POST', '/api/auth/login', { username: 'prof_csh', password: newPassword }, tryNewCsrf.cookie, tryNewCsrf.data.csrfToken);
    assert.strictEqual(tryNewLogin.status, 200, 'Phải đăng nhập thành công bằng mật khẩu mới');
    console.log('✓ Đăng nhập thành công bằng mật khẩu mới.');

    const newSessionCookie = tryNewLogin.cookie;
    const newSessionCsrf = tryNewLogin.data.csrfToken;

    // ------------------------------------------------------------------------
    // BƯỚC 5: ĐĂNG XUẤT VÀ KIỂM TRA TRUY CẬP TRANG ĐƯỢC BẢO VỆ
    // ------------------------------------------------------------------------
    console.log('\n--- Bước 5: Kiểm thử Đăng xuất và bảo vệ trang sau đăng xuất ---');
    const logoutRes = await req('POST', '/api/auth/logout', null, newSessionCookie, newSessionCsrf);
    assert.strictEqual(logoutRes.status, 200);
    console.log('✓ Đăng xuất thành công, session phía server bị hủy và cookie bị xóa.');

    // Sau đăng xuất, truy cập lại trang /sales bằng cookie cũ -> Bị chuyển hướng 302 về /login
    const trySalesAfterLogout = await req('GET', '/sales', null, newSessionCookie, '', 'manual');
    assert.strictEqual(trySalesAfterLogout.status, 302, 'Trang bảo vệ phải chuyển hướng về /login');
    assert.strictEqual(trySalesAfterLogout.headers.get('location'), '/login');
    console.log('✓ Truy cập lại /sales sau đăng xuất bị chuyển hướng về /login (HTTP 302).');

    // Sau đăng xuất, truy cập lại trang /profile bằng cookie cũ -> Bị chuyển hướng 302 về /login
    const tryProfileAfterLogout = await req('GET', '/profile', null, newSessionCookie, '', 'manual');
    assert.strictEqual(tryProfileAfterLogout.status, 302);
    assert.strictEqual(tryProfileAfterLogout.headers.get('location'), '/login');
    console.log('✓ Truy cập lại /profile sau đăng xuất bị chuyển hướng về /login (HTTP 302).');

    // Sau đăng xuất, gọi API /api/auth/me -> Bị từ chối 401
    const tryApiAfterLogout = await req('GET', '/api/auth/me', null, newSessionCookie);
    assert.strictEqual(tryApiAfterLogout.status, 401);
    console.log('✓ Gọi API sau đăng xuất bị từ chối với HTTP 401.');

    console.log('\n=== TẤT CẢ CÁC BƯỚC KIỂM THỬ TÀI KHOẢN CỦA TÔI & ĐỔI MẬT KHẨU ĐÃ ĐẠT 100%! ===');
  } finally {
    serverProcess.kill();
  }
}

run().catch((err) => {
  console.error('\n❌ KIỂM THỬ THẤT BẠI:', err);
  process.exit(1);
});
