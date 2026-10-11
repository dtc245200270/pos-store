require('dotenv').config();
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const BASE_URL = 'http://localhost:3000';
const ARTIFACTS_DIR = 'C:\\Users\\Dell Precision 5550\\.gemini\\antigravity-ide\\brain\\246ce1ac-f161-4dc9-98e7-8d7ff9081ef7';
const USER_DATA_DIR = path.join(ARTIFACTS_DIR, 'scratch', 'chrome_403_profile');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getWebSocketDebuggerUrl(debugPort) {
  for (let i = 0; i < 25; i++) {
    await sleep(300);
    try {
      const resp = await fetch(`http://127.0.0.1:${debugPort}/json`);
      const list = await resp.json();
      const pageTarget = list.find(t => t.type === 'page' && !t.url.startsWith('chrome-extension://'));
      if (pageTarget && pageTarget.webSocketDebuggerUrl) {
        return pageTarget.webSocketDebuggerUrl;
      }
    } catch (e) {}
  }
  throw new Error('Chrome debugger page target timed out');
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
  console.log('=== BẮT ĐẦU KIỂM THỬ TRANG THÔNG BÁO 403 FORBIDDEN ===\n');

  // Test 1: Fetch trực tiếp qua HTTP
  console.log('--- TEST 1: Kiểm thử mã trạng thái HTTP 403 & nội dung trang qua HTTP ---');
  // Lấy CSRF token và đăng nhập Cashier
  const csrfRes = await fetch(`${BASE_URL}/api/auth/csrf`);
  const csrfCookie = csrfRes.headers.get('set-cookie').split(';')[0];
  const csrfData = await csrfRes.json();

  const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfData.csrfToken,
      'Cookie': csrfCookie
    },
    body: JSON.stringify({ username: 'thungan_test01', password: 'CashierPass123!@#' })
  });
  const rawSetCookie = loginRes.headers.get('set-cookie');
  if (!loginRes.ok) {
    console.log('Login failed:', loginRes.status, await loginRes.json());
  }
  const sessionCookie = (rawSetCookie || csrfCookie).split(';')[0];
  assert(loginRes.ok, 'Đăng nhập Thu ngân phải thành công');
  console.log('✔ Thu ngân đăng nhập thành công.');

  const protectedPaths = ['/', '/products', '/employees', '/stock-receipts'];
  for (const p of protectedPaths) {
    const res = await fetch(`${BASE_URL}${p}`, {
      headers: { 'Cookie': sessionCookie },
      redirect: 'manual'
    });
    const text = await res.text();
    console.log(`\nKiểm tra đường dẫn "${p}":`);
    console.log(`  - HTTP Status: ${res.status}`);
    assert.strictEqual(res.status, 403, `Đường dẫn ${p} phải trả về HTTP 403`);
    assert(text.includes('Bạn không có quyền truy cập chức năng này'), 'Phải chứa thông báo "Bạn không có quyền truy cập chức năng này"');
    assert(text.includes('Về trang bán hàng'), 'Phải có nút "Về trang bán hàng"');
    assert(text.includes('href="/sales"'), 'Phải có link trỏ về "/sales"');
    
    // Kiểm tra không lộ dữ liệu quản lý
    assert(!text.includes('id="products-tbody"'), 'Không được chứa bảng sản phẩm');
    assert(!text.includes('id="employees-tbody"'), 'Không được chứa bảng nhân viên');
    assert(!text.includes('id="r-cart"'), 'Không được chứa giỏ nhập hàng');
    assert(!text.includes('id="today-revenue"'), 'Không được chứa thẻ doanh thu');
    console.log(`  ✔ HTTP 403 chuẩn xác, có thông báo và nút quay về, không để lộ dữ liệu quản lý.`);
  }

  // Test 2: Kiểm thử trên trình duyệt Chrome Headless
  console.log('\n--- TEST 2: Kiểm thử trình duyệt thực tế & click nút "Về trang bán hàng" ---');
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const debugPort = 9227;

  if (fs.existsSync(USER_DATA_DIR)) {
    fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
  }

  const chromeProcess = spawn(chromePath, [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${USER_DATA_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank'
  ]);

  try {
    const wsUrl = await getWebSocketDebuggerUrl(debugPort);
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve) => ws.addEventListener('open', resolve));

    await sendCdp(ws, 'Page.enable');
    await sendCdp(ws, 'Runtime.enable');

    // Đăng nhập thu ngân trên trình duyệt
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/login` });
    await sleep(1000);

    const loginBrowserRes = await evalInBrowser(ws, `
      (async () => {
        const token = await fetchCsrfToken();
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
          body: JSON.stringify({ username: 'thungan_test01', password: 'CashierPass123!@#' })
        });
        return res.ok;
      })()
    `);
    assert(loginBrowserRes, 'Đăng nhập trình duyệt thành công');

    // Truy cập trực tiếp trang quản trị /products
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/products` });
    await sleep(1000);

    const pageInfo = await evalInBrowser(ws, `
      (() => {
        const h1 = document.querySelector('h1');
        const btn = document.querySelector('a[href="/sales"]');
        return {
          title: document.title,
          h1Text: h1 ? h1.innerText : '',
          bodyText: document.body.innerText,
          hasBtn: !!btn,
          btnText: btn ? btn.innerText.trim() : '',
          btnHref: btn ? btn.getAttribute('href') : ''
        };
      })()
    `);
    console.log('Dữ liệu hiển thị trên trình duyệt:', pageInfo);
    assert.strictEqual(pageInfo.h1Text, 'Bạn không có quyền truy cập chức năng này', 'Tiêu đề trang phải là "Bạn không có quyền truy cập chức năng này"');
    assert(pageInfo.hasBtn, 'Phải có nút liên kết /sales');
    assert(pageInfo.btnText.includes('Về trang bán hàng'), 'Nút phải có chữ "Về trang bán hàng"');
    assert.strictEqual(pageInfo.btnHref, '/sales', 'Nút phải có href="/sales"');

    // Click nút "Về trang bán hàng"
    await evalInBrowser(ws, `
      document.querySelector('a[href="/sales"]').click();
    `);
    await sleep(1000);

    const currentUrl = await evalInBrowser(ws, 'window.location.pathname');
    console.log('Đường dẫn sau khi bấm nút:', currentUrl);
    assert.strictEqual(currentUrl, '/sales', 'Bấm nút phải chuyển về trang bán hàng (/sales)');
    console.log('✔ Nút "Về trang bán hàng" hoạt động hoàn hảo, chuyển hướng đúng tới /sales.');

    ws.close();
  } finally {
    chromeProcess.kill('SIGKILL');
  }

  console.log('\n============================================================');
  console.log('🎉 TẤT CẢ KIỂM THỬ TRANG 403 ĐỀU THÀNH CÔNG VÀ CHÍNH XÁC!');
  console.log('============================================================');
}

run()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('\n❌ KIỂM THỬ THẤT BẠI:', err);
    process.exit(1);
  });
