require('dotenv').config();
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const mysql = require('mysql2/promise');

const TEST_PORT = 3002;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ARTIFACT_DIR = 'C:\\Users\\Dell Precision 5550\\.gemini\\antigravity-ide\\brain\\73031e9b-50f2-4c96-9b6a-5f67e969e504';
const USER_DATA_DIR = path.join(ARTIFACT_DIR, 'scratch', 'chrome_role_test_profile');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sendCdp(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1000000);
    const handler = (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.id === id) {
        ws.removeEventListener('message', handler);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalInBrowser(ws, expression) {
  const result = await sendCdp(ws, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  return result.result ? result.result.value : null;
}

async function run() {
  console.log('=== BẮT ĐẦU KIỂM THỬ TRÌNH DUYỆT THỰC TẾ (CHROME HEADLESS CDP) ===\n');

  // 1. Chuẩn bị database test
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

  // 2. Khởi động server test
  console.log('1. Khởi động máy chủ kiểm thử...');
  const serverProcess = spawn('node', ['server.js'], {
    env: { ...process.env, DB_NAME: 'pos_store_test', SESSION_SECRET: 'test_secret_browser', PORT: String(TEST_PORT), METRICS_PORT: '0' }
  });
  await new Promise((resolve) => {
    serverProcess.stdout.on('data', (d) => {
      if (d.toString().includes('Website đang chạy')) resolve();
    });
    setTimeout(resolve, 3000);
  });
  console.log('✓ Máy chủ kiểm thử đang chạy trên cổng ' + TEST_PORT);

  // 3. Khởi động Chrome với cổng gỡ lỗi 9224
  if (!fs.existsSync(USER_DATA_DIR)) {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  }

  console.log('2. Khởi động Google Chrome headless...');
  const chromeProcess = spawn(CHROME_PATH, [
    '--headless=new',
    '--remote-debugging-port=9224',
    `--user-data-dir=${USER_DATA_DIR}`,
    '--window-size=1280,800',
    '--disable-gpu',
    '--disable-extensions',
    '--no-first-run',
    'about:blank'
  ]);

  let ws;
  try {
    let wsUrl = null;
    for (let i = 0; i < 20; i++) {
      await sleep(300);
      try {
        const resp = await fetch('http://127.0.0.1:9224/json');
        const list = await resp.json();
        const pageTarget = list.find(t => t.type === 'page' && !t.url.startsWith('chrome-extension://'));
        if (pageTarget && pageTarget.webSocketDebuggerUrl) {
          wsUrl = pageTarget.webSocketDebuggerUrl;
          break;
        }
      } catch (e) {}
    }
    assert.ok(wsUrl, 'Không lấy được WebSocket URL từ Chrome');
    console.log('✓ Kết nối CDP tới Chrome thành công.');

    ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', reject);
    });

    await sendCdp(ws, 'Page.enable');
    await sendCdp(ws, 'Runtime.enable');
    await sendCdp(ws, 'Network.enable');

    // =========================================================
    // TEST 1: ĐĂNG NHẬP VỚI VAI TRÒ MANAGER
    // =========================================================
    console.log('\n--- TEST 1: KIỂM THỬ ĐĂNG NHẬP VỚI VAI TRÒ MANAGER ---');
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/login` });
    await sleep(1000);

    console.log('1.1 Nhập thông tin tài khoản Manager (mgr_test)...');
    await evalInBrowser(ws, `
      document.getElementById('username').value = 'mgr_test';
      document.getElementById('password').value = 'password123';
      document.getElementById('login-form').dispatchEvent(new Event('submit', { cancelable: true }));
    `);
    await sleep(2000);

    const currentUrlMgr = await evalInBrowser(ws, 'window.location.href');
    console.log(`1.2 Sau khi đăng nhập Manager, URL hiện tại: ${currentUrlMgr}`);
    assert.strictEqual(currentUrlMgr, `${BASE_URL}/`, 'Manager phải được chuyển hướng đến trang tổng quan (/)');

    console.log('1.3 Kiểm tra giao diện Quản lý (Left Sidebar Navigation):');
    const hasSidebar = await evalInBrowser(ws, `!!document.getElementById('posManagerSidebar')`);
    assert.strictEqual(hasSidebar, true, 'Giao diện Manager phải có sidebar #posManagerSidebar');
    console.log('  ✓ Sidebar quản lý (.pos-manager-sidebar) hiển thị ở bên trái.');

    const bodyClass = await evalInBrowser(ws, `document.body.className`);
    assert.ok(bodyClass.includes('pos-manager-layout'), 'Body phải có class pos-manager-layout');
    console.log('  ✓ Body có class "pos-manager-layout" với khoảng cách đệm bên trái cho nội dung.');

    const managerMenuInfo = await evalInBrowser(ws, `
      (() => {
        const items = Array.from(document.querySelectorAll('#posManagerSidebar .nav-link')).map(a => ({
          text: a.querySelector('span') ? a.querySelector('span').textContent.trim() : a.textContent.trim(),
          href: a.getAttribute('href'),
          isActive: a.classList.contains('active'),
          ariaCurrent: a.getAttribute('aria-current'),
          bgColor: window.getComputedStyle(a).backgroundColor
        }));
        return items;
      })()
    `);
    console.log('  ✓ Danh sách mục menu Quản lý hiển thị:');
    managerMenuInfo.forEach(item => {
      console.log(`    - [${item.isActive ? 'ACTIVE' : '      '}] ${item.text} (${item.href})`);
    });
    assert.strictEqual(managerMenuInfo.length, 7, 'Menu Quản lý phải có đúng 7 mục');
    assert.strictEqual(managerMenuInfo[0].text, 'Tổng quan');
    assert.strictEqual(managerMenuInfo[0].isActive, true);
    assert.strictEqual(managerMenuInfo[0].ariaCurrent, 'page');

    // Chuyển trang sang /inventory (Tồn kho)
    console.log('1.4 Chuyển sang trang Tồn kho (/inventory)...');
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/inventory` });
    await sleep(1500);

    const activeItemAfterNav = await evalInBrowser(ws, `
      (() => {
        const active = document.querySelector('#posManagerSidebar .nav-link.active');
        return active ? (active.querySelector('span') ? active.querySelector('span').textContent.trim() : active.textContent.trim()) : null;
      })()
    `);
    console.log(`  ✓ Mục đang active: "${activeItemAfterNav}"`);
    assert.strictEqual(activeItemAfterNav, 'Tồn kho', 'Mục Tồn kho phải sáng');

    // Kiểm tra F5 tải lại trang
    console.log('1.5 Tải lại trang (F5) tại /inventory...');
    await sendCdp(ws, 'Page.reload');
    await sleep(1500);

    const activeItemAfterF5 = await evalInBrowser(ws, `
      (() => {
        const active = document.querySelector('#posManagerSidebar .nav-link.active');
        return active ? (active.querySelector('span') ? active.querySelector('span').textContent.trim() : active.textContent.trim()) : null;
      })()
    `);
    console.log(`  ✓ Sau khi F5, mục đang active vẫn là: "${activeItemAfterF5}"`);
    assert.strictEqual(activeItemAfterF5, 'Tồn kho', 'Sau F5, mục Tồn kho phải tiếp tục sáng');

    // Chụp ảnh màn hình Manager Overview
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/` });
    await sleep(1500);
    const ssMgr = await sendCdp(ws, 'Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'manager_dashboard_screenshot.png'), Buffer.from(ssMgr.data, 'base64'));
    console.log('  ✓ Đã lưu ảnh chụp màn hình giao diện Quản lý vào manager_dashboard_screenshot.png');

    // =========================================================
    // TEST 2: ĐĂNG NHẬP VỚI VAI TRÒ CASHIER
    // =========================================================
    console.log('\n--- TEST 2: KIỂM THỬ ĐĂNG NHẬP VỚI VAI TRÒ CASHIER ---');
    // Xóa cookies để đăng xuất
    await sendCdp(ws, 'Network.clearBrowserCookies');

    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/login` });
    await sleep(1000);

    console.log('2.1 Nhập thông tin tài khoản Cashier (csh_test)...');
    await evalInBrowser(ws, `
      document.getElementById('username').value = 'csh_test';
      document.getElementById('password').value = 'password123';
      document.getElementById('login-form').dispatchEvent(new Event('submit', { cancelable: true }));
    `);
    await sleep(2000);

    const currentUrlCsh = await evalInBrowser(ws, 'window.location.href');
    console.log(`2.2 Sau khi đăng nhập Cashier, URL hiện tại: ${currentUrlCsh}`);
    assert.strictEqual(currentUrlCsh, `${BASE_URL}/sales`, 'Cashier phải được chuyển hướng đến trang bán hàng (/sales)');

    console.log('2.3 Kiểm tra giao diện Thu ngân (Compact Top Bar, ưu tiên diện tích bán hàng):');
    const cashierHasSidebar = await evalInBrowser(ws, `!!document.getElementById('posManagerSidebar')`);
    assert.strictEqual(cashierHasSidebar, false, 'Thu ngân TUYỆT ĐỐI KHÔNG có sidebar bên trái');
    console.log('  ✓ Sidebar quản lý hoàn toàn ẩn đối với Thu ngân.');

    const cashierNavExists = await evalInBrowser(ws, `!!document.querySelector('nav.pos-cashier-nav')`);
    assert.strictEqual(cashierNavExists, true, 'Thu ngân phải có menu gọn phía trên (.pos-cashier-nav)');
    console.log('  ✓ Menu ngang gọn gàng (.pos-cashier-nav) hiển thị phía trên, ưu tiên 100% không gian cho bán hàng.');

    const cashierBodyClass = await evalInBrowser(ws, `document.body.className`);
    assert.ok(cashierBodyClass.includes('pos-cashier-layout'), 'Body phải có class pos-cashier-layout');

    const cashierMenuInfo = await evalInBrowser(ws, `
      (() => {
        const items = Array.from(document.querySelectorAll('.pos-cashier-nav .nav-link')).map(a => ({
          text: a.querySelector('span') ? a.querySelector('span').textContent.trim() : a.textContent.trim(),
          href: a.getAttribute('href'),
          isActive: a.classList.contains('active'),
          ariaCurrent: a.getAttribute('aria-current')
        }));
        return items;
      })()
    `);
    console.log('  ✓ Danh sách mục menu Thu ngân hiển thị:');
    cashierMenuInfo.forEach(item => {
      console.log(`    - [${item.isActive ? 'ACTIVE' : '      '}] ${item.text} (${item.href})`);
    });
    assert.strictEqual(cashierMenuInfo.length, 4, 'Menu Thu ngân phải có đúng 4 mục');
    assert.strictEqual(cashierMenuInfo[0].text, 'Bán hàng');
    assert.strictEqual(cashierMenuInfo[0].isActive, true);
    assert.strictEqual(cashierMenuInfo[0].ariaCurrent, 'page');

    const cashierGreeting = await evalInBrowser(ws, `document.getElementById('cashier-user-greeting').textContent.trim()`);
    console.log(`  ✓ Lời chào hiển thị: "${cashierGreeting}"`);
    assert.ok(cashierGreeting.includes('Trần Thu Ngân'), 'Lời chào phải có tên thu ngân');
    assert.ok(cashierGreeting.includes('Thu ngân'), 'Vai trò phải hiển thị là Thu ngân');

    // Chuyển sang /profile (Tài khoản của tôi)
    console.log('2.4 Chuyển sang trang Tài khoản của tôi (/profile)...');
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/profile` });
    await sleep(1500);

    const profileActiveItem = await evalInBrowser(ws, `
      (() => {
        const active = document.querySelector('.pos-cashier-nav .nav-link.active');
        return active ? (active.querySelector('span') ? active.querySelector('span').textContent.trim() : active.textContent.trim()) : null;
      })()
    `);
    console.log(`  ✓ Mục active trên menu Thu ngân: "${profileActiveItem}"`);
    assert.strictEqual(profileActiveItem, 'Tài khoản của tôi');

    const profileCardInfo = await evalInBrowser(ws, `
      ({
        fullName: document.getElementById('profile-fullname') ? document.getElementById('profile-fullname').textContent.trim() : '',
        username: document.getElementById('profile-username') ? document.getElementById('profile-username').textContent.trim() : '',
        role: document.getElementById('profile-role') ? document.getElementById('profile-role').textContent.trim() : '',
        status: document.getElementById('profile-status') ? document.getElementById('profile-status').textContent.trim() : ''
      })
    `);
    console.log('  ✓ Thông tin tài khoản hiển thị trên thẻ hồ sơ:', profileCardInfo);
    assert.strictEqual(profileCardInfo.fullName, 'Trần Thu Ngân');
    assert.strictEqual(profileCardInfo.username, 'csh_test');
    assert.strictEqual(profileCardInfo.role, 'Thu ngân');
    assert.strictEqual(profileCardInfo.status, 'Hoạt động');

    // Chụp ảnh màn hình Cashier Sales
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/sales` });
    await sleep(1500);
    const ssCsh = await sendCdp(ws, 'Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'cashier_sales_screenshot.png'), Buffer.from(ssCsh.data, 'base64'));
    console.log('  ✓ Đã lưu ảnh chụp màn hình giao diện Thu ngân vào cashier_sales_screenshot.png');

    // =========================================================
    // TEST 3: KIỂM THỬ TRUY CẬP TRỰC TIẾP URL QUẢN LÝ TỪ TRÌNH DUYỆT
    // =========================================================
    console.log('\n--- TEST 3: THU NGÂN TRUY CẬP TRỰC TIẾP URL QUẢN LÝ TRÊN TRÌNH DUYỆT ---');
    const directUrls = ['/', '/products', '/stock-receipts', '/employees'];
    for (const urlPath of directUrls) {
      await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}${urlPath}` });
      await sleep(1000);
      const pageText = await evalInBrowser(ws, 'document.body.innerText');
      assert.ok(pageText.includes('Không có quyền truy cập'), `Truy cập ${urlPath} phải nhận trang thông báo 403 Không có quyền truy cập`);
      console.log(`  ✓ Trình duyệt truy cập trực tiếp "${urlPath}": BỊ CHẶN VÀ HIỂN THỊ "Không có quyền truy cập"`);
    }

    console.log('\n=== KIỂM THỬ TRÌNH DUYỆT HOÀN TOÀN THÀNH CÔNG VÀ CHÍNH XÁC 100%! ===');
  } finally {
    if (ws) ws.close();
    chromeProcess.kill();
    serverProcess.kill();
  }
}

run().catch((err) => {
  console.error('\n❌ LỖI KIỂM THỬ TRÌNH DUYỆT:', err);
  process.exit(1);
});
