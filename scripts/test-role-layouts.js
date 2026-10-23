require('dotenv').config();
const assert = require('assert');
const { spawn } = require('child_process');
const mysql = require('mysql2/promise');

const TEST_PORT = 3002;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

async function run() {
  console.log('=== BẮT ĐẦU KIỂM THỬ PHÂN TÁCH GIAO DIỆN THEO VAI TRÒ (MANAGER vs CASHIER) ===\n');

  // 1. Chuẩn bị DB test pos_store_test
  const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'pos_app',
    password: process.env.DB_PASSWORD || '290729',
    database: 'pos_store_test'
  });

  const bcrypt = require('bcryptjs');
  const hash = await bcrypt.hash('password123', 10);
  await pool.query('INSERT IGNORE INTO users (username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?)',
    ['mgr_test', hash, 'Nguyễn Quản Lý', 'MANAGER', 1]);
  await pool.query('INSERT IGNORE INTO users (username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?)',
    ['csh_test', hash, 'Trần Thu Ngân', 'CASHIER', 1]);
  await pool.end();

  // 2. Khởi động server test trên port 3002
  console.log('1. Khởi động server kiểm thử trên cổng ' + TEST_PORT + '...');
  const serverProcess = spawn('node', ['server.js'], {
    env: { ...process.env, DB_NAME: 'pos_store_test', SESSION_SECRET: 'test_secret_role', PORT: String(TEST_PORT), METRICS_PORT: '0' }
  });

  await new Promise((resolve) => {
    serverProcess.stdout.on('data', (d) => {
      if (d.toString().includes('Website đang chạy')) resolve();
    });
    serverProcess.stderr.on('data', (d) => console.error('[Server Err]:', d.toString()));
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
    // --- BƯỚC 1: KIỂM THỬ ĐĂNG NHẬP DÙNG CHUNG ---
    console.log('--- Bước 1: Kiểm thử trang đăng nhập dùng chung (/login) ---');
    const loginPageRes = await req('GET', '/login');
    assert.strictEqual(loginPageRes.status, 200);
    assert.ok(loginPageRes.text.includes('Đăng nhập hệ thống'), 'Trang login phải có form đăng nhập');
    console.log('✓ Trang đăng nhập dùng chung mở thành công.');

    // --- BƯỚC 2: KIỂM THỬ VAI TRÒ MANAGER ---
    console.log('\n--- Bước 2: Kiểm thử vai trò MANAGER (Quản lý) ---');
    // 2.1 Lấy CSRF & Login
    const csrfResMgr = await req('GET', '/api/auth/csrf');
    const mgrLogin = await req('POST', '/api/auth/login', 
      { username: 'mgr_test', password: 'password123' }, 
      csrfResMgr.cookie, csrfResMgr.data.csrfToken
    );
    assert.strictEqual(mgrLogin.status, 200);
    assert.strictEqual(mgrLogin.data.role, 'MANAGER');
    console.log('✓ Manager đăng nhập thành công, role trả về: MANAGER');

    const mgrCookie = mgrLogin.cookie;

    // 2.2 Kiểm tra Manager truy cập /login bị redirect về /
    const mgrReLogin = await req('GET', '/login', null, mgrCookie, '', 'manual');
    assert.strictEqual(mgrReLogin.status, 302);
    assert.strictEqual(mgrReLogin.headers.get('location'), '/');
    console.log('✓ Manager mở lại /login được tự động chuyển hướng về trang tổng quan (/)');

    // 2.3 Manager truy cập trang tổng quan /
    const mgrDash = await req('GET', '/', null, mgrCookie);
    assert.strictEqual(mgrDash.status, 200, 'Manager phải mở được /');
    console.log('✓ Manager mở trực tiếp trang tổng quan (/) thành công (HTTP 200).');

    // 2.4 Manager truy cập tất cả 7 trang quản lý
    const managerRoutes = [
      { path: '/', name: 'Tổng quan' },
      { path: '/sales', name: 'Bán hàng' },
      { path: '/products', name: 'Sản phẩm' },
      { path: '/stock-receipts', name: 'Nhập hàng' },
      { path: '/inventory', name: 'Tồn kho' },
      { path: '/invoices', name: 'Hóa đơn' },
      { path: '/employees', name: 'Tài khoản nhân viên' }
    ];

    for (const r of managerRoutes) {
      const pageRes = await req('GET', r.path, null, mgrCookie);
      assert.strictEqual(pageRes.status, 200, `Manager phải mở được ${r.path}`);
      console.log(`  ✓ Manager mở ${r.path} (${r.name}): HTTP 200 OK`);
    }

    // --- BƯỚC 3: KIỂM THỬ VAI TRÒ CASHIER ---
    console.log('\n--- Bước 3: Kiểm thử vai trò CASHIER (Thu ngân) ---');
    // 3.1 Lấy CSRF & Login Cashier
    const csrfResCsh = await req('GET', '/api/auth/csrf');
    const cshLogin = await req('POST', '/api/auth/login', 
      { username: 'csh_test', password: 'password123' }, 
      csrfResCsh.cookie, csrfResCsh.data.csrfToken
    );
    assert.strictEqual(cshLogin.status, 200);
    assert.strictEqual(cshLogin.data.role, 'CASHIER');
    console.log('✓ Cashier đăng nhập thành công, role trả về: CASHIER');

    const cshCookie = cshLogin.cookie;

    // 3.2 Kiểm tra Cashier truy cập /login bị redirect về /sales
    const cshReLogin = await req('GET', '/login', null, cshCookie, '', 'manual');
    assert.strictEqual(cshReLogin.status, 302);
    assert.strictEqual(cshReLogin.headers.get('location'), '/sales');
    console.log('✓ Cashier mở lại /login được tự động chuyển hướng về trang bán hàng (/sales)');

    // 3.3 Cashier truy cập các trang được phép (Bán hàng, Hóa đơn của tôi, Tra cứu tồn kho, Tài khoản của tôi)
    const cashierAllowed = [
      { path: '/sales', name: 'Bán hàng' },
      { path: '/invoices', name: 'Hóa đơn của tôi' },
      { path: '/inventory', name: 'Tra cứu tồn kho' },
      { path: '/profile', name: 'Tài khoản của tôi' }
    ];

    for (const r of cashierAllowed) {
      const pageRes = await req('GET', r.path, null, cshCookie);
      assert.strictEqual(pageRes.status, 200, `Cashier phải mở được ${r.path}`);
      console.log(`  ✓ Cashier mở ${r.path} (${r.name}): HTTP 200 OK`);
    }

    // --- BƯỚC 4: BẢO VỆ CÁC TRANG QUẢN LÝ BẰNG MIDDLEWARE BACKEND (403 FORBIDDEN) ---
    console.log('\n--- Bước 4: Kiểm thử Cashier truy cập trực tiếp đường dẫn quản lý (Middleware chặn 403) ---');
    const managerProtectedRoutes = [
      { path: '/', name: 'Tổng quan' },
      { path: '/products', name: 'Sản phẩm' },
      { path: '/stock-receipts', name: 'Nhập hàng' },
      { path: '/employees', name: 'Tài khoản nhân viên' }
    ];

    for (const r of managerProtectedRoutes) {
      const blockedRes = await req('GET', r.path, null, cshCookie);
      assert.strictEqual(blockedRes.status, 403, `Cashier truy cập ${r.path} phải bị chặn HTTP 403`);
      assert.ok(blockedRes.text.includes('Không có quyền truy cập'), `Phải có thông báo lỗi phân quyền`);
      console.log(`  ✓ Cashier truy cập ${r.path} (${r.name}): BỊ CHẶN HTTP 403 FORBIDDEN`);
    }

    // Kiểm tra API quản lý bị chặn
    const blockedApi = await req('GET', '/api/employees', null, cshCookie);
    assert.strictEqual(blockedApi.status, 403, 'Cashier gọi /api/employees phải bị 403');
    console.log('  ✓ Cashier gọi API quản trị (/api/employees): BỊ CHẶN HTTP 403 FORBIDDEN');

    // --- BƯỚC 5: KIỂM TRA MÃ NGUỒN VÀ LOGIC LAYOUT (SIDEBAR VS TOPBAR, ACTIVE, TIẾNG VIỆT) ---
    console.log('\n--- Bước 5: Kiểm tra logic Layout, Active Menu và Việt hóa nhãn ---');
    const fs = require('fs');
    const layoutContent = fs.readFileSync('public/js/layout.js', 'utf-8');

    // Kiểm tra class và layout phân tách
    assert.ok(layoutContent.includes('pos-manager-layout'), 'Thiếu class body pos-manager-layout');
    assert.ok(layoutContent.includes('pos-manager-sidebar'), 'Thiếu sidebar pos-manager-sidebar');
    assert.ok(layoutContent.includes('pos-cashier-layout'), 'Thiếu class body pos-cashier-layout');
    assert.ok(layoutContent.includes('pos-cashier-nav'), 'Thiếu navbar pos-cashier-nav');
    console.log('✓ Layout có class phân tách rõ ràng: Sidebar cho Manager, Navbar gọn cho Cashier.');

    // Kiểm tra 7 mục menu Quản lý
    const expectedMgrItems = ['Tổng quan', 'Bán hàng', 'Sản phẩm', 'Nhập hàng', 'Tồn kho', 'Hóa đơn', 'Tài khoản nhân viên'];
    for (const item of expectedMgrItems) {
      assert.ok(layoutContent.includes(item), `Layout thiếu menu quản lý: ${item}`);
    }
    console.log('✓ Menu Quản lý có đủ 7 mục: ' + expectedMgrItems.join(', '));

    // Kiểm tra 4 mục menu Thu ngân
    const expectedCshItems = ['Bán hàng', 'Hóa đơn của tôi', 'Tra cứu tồn kho', 'Tài khoản của tôi'];
    for (const item of expectedCshItems) {
      assert.ok(layoutContent.includes(item), `Layout thiếu menu thu ngân: ${item}`);
    }
    console.log('✓ Menu Thu ngân có đủ 4 mục: ' + expectedCshItems.join(', '));

    // Kiểm tra thuộc tính active
    assert.ok(layoutContent.includes('#0d6efd'), 'Mục active phải có màu nền xanh #0d6efd');
    assert.ok(layoutContent.includes('aria-current="page"'), 'Mục active phải có aria-current="page"');
    assert.ok(layoutContent.includes('window.location.pathname'), 'Active phải dựa trên window.location.pathname');
    console.log('✓ Tô sáng mục active dùng đúng mã màu #0d6efd và aria-current="page" dựa trên pathname (tự động giữ khi tải lại/F5).');

    // Kiểm tra nhãn Việt hóa
    assert.ok(layoutContent.includes('Quản lý'), 'Thiếu nhãn Quản lý');
    assert.ok(layoutContent.includes('Thu ngân'), 'Thiếu nhãn Thu ngân');
    assert.ok(layoutContent.includes('Đăng xuất'), 'Thiếu nút Đăng xuất');
    console.log('✓ Việt hóa nhãn hiển thị: MANAGER = Quản lý, CASHIER = Thu ngân, Đăng xuất.');

    // Kiểm tra views/inventory.html đã đổi INVENTORY -> Tồn kho
    const invHtml = fs.readFileSync('views/inventory.html', 'utf-8');
    assert.ok(!invHtml.includes('>INVENTORY<'), 'inventory.html còn giữ nhãn INVENTORY tiếng Anh');
    assert.ok(invHtml.includes('TỒN KHO') || invHtml.includes('Tồn Kho'), 'inventory.html thiếu nhãn TỒN KHO');
    console.log('✓ views/inventory.html đã việt hóa nhãn INVENTORY thành Tồn Kho.');

    // Kiểm tra views/employees.html và public/js/employees.js đã việt hóa
    const empJs = fs.readFileSync('public/js/employees.js', 'utf-8');
    assert.ok(empJs.includes('Quản lý'), 'employees.js thiếu nhãn Quản lý');
    assert.ok(empJs.includes('Thu ngân'), 'employees.js thiếu nhãn Thu ngân');
    assert.ok(empJs.includes('Hoạt động'), 'employees.js thiếu nhãn Hoạt động');
    console.log('✓ employees.js đã việt hóa vai trò Quản lý/Thu ngân và trạng thái Hoạt động.');

    console.log('\n=== TẤT CẢ CÁC KIỂM THỬ VỀ PHÂN TÁCH GIAO DIỆN & BẢO VỆ BACKEND ĐÃ ĐẠT 100%! ===');
  } finally {
    serverProcess.kill();
  }
}

run().catch((err) => {
  console.error('\n❌ KIỂM THỬ THẤT BẠI:', err);
  process.exit(1);
});
