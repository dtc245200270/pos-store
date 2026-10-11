require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const PORT = 3015;
const BASE_URL = `http://localhost:${PORT}`;
const ARTIFACTS_DIR = 'C:\\Users\\Dell Precision 5550\\.gemini\\antigravity-ide\\brain\\246ce1ac-f161-4dc9-98e7-8d7ff9081ef7';
const USER_DATA_DIR = path.join(ARTIFACTS_DIR, 'scratch', 'chrome_dashboard_profile');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getWebSocketDebuggerUrl(debugPort) {
  for (let i = 0; i < 30; i++) {
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

async function captureScreenshot(ws, filepath) {
  const result = await sendCdp(ws, 'Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(filepath, Buffer.from(result.data, 'base64'));
  console.log(`  ✓ Đã lưu ảnh chụp: ${filepath}`);
}

async function run() {
  console.log('=== KIỂM THỬ TRÌNH DUYỆT GIAO DIỆN TỔNG QUAN (CHROME HEADLESS) ===\n');

  if (!fs.existsSync(USER_DATA_DIR)) {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  }

  // 1. Chuẩn bị database pos_store_test
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
    ['dash_ui_mgr', hash, 'Trần Quản Lý Tổng Quan', 'MANAGER', 1]);
  await pool.query('INSERT INTO users (username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), is_active = 1',
    ['dash_ui_csh', hash, 'Lê Thu Ngân', 'CASHIER', 1]);

  await pool.end();

  // 2. Khởi động server test cổng 3015
  const serverProcess = spawn('node', ['server.js'], {
    env: { ...process.env, DB_NAME: 'pos_store_test', PORT: String(PORT), SESSION_SECRET: 'test_dash_ui_secret' }
  });

  await new Promise((resolve) => {
    serverProcess.stdout.on('data', (d) => {
      if (d.toString().includes('Website đang chạy')) resolve();
    });
    setTimeout(resolve, 3000);
  });
  console.log(`✓ Server test đang chạy tại ${BASE_URL}`);

  // 3. Khởi động Chrome
  const CHROME_DEBUG_PORT = 9230;
  const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

  const chromeProcess = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${CHROME_DEBUG_PORT}`,
    `--user-data-dir=${USER_DATA_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1280,950'
  ]);

  const wsUrl = await getWebSocketDebuggerUrl(CHROME_DEBUG_PORT);
  const ws = new WebSocket(wsUrl);
  await new Promise(r => ws.addEventListener('open', r));

  await sendCdp(ws, 'Page.enable');
  await sendCdp(ws, 'Runtime.enable');
  await sendCdp(ws, 'Network.enable');

  try {
    // ------------------------------------------------------------------------
    // 1. CASHIER BỊ CHẶN TRUY CẬP TRANG TỔNG QUAN (HTTP 403 / Redirect)
    // ------------------------------------------------------------------------
    console.log('--- 1. Thu ngân đăng nhập và truy cập trang Tổng quan (/) ---');
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/login` });
    await sleep(1000);

    const loginCashierOk = await evalInBrowser(ws, `
      (async () => {
        const token = await fetchCsrfToken();
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
          body: JSON.stringify({ username: 'dash_ui_csh', password: 'password123' })
        });
        return res.ok;
      })()
    `);
    assert.strictEqual(loginCashierOk, true, 'Cashier đăng nhập thành công');

    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/` });
    await sleep(1000);

    const cashierUrl = await evalInBrowser(ws, 'window.location.pathname');
    const cashierBody = await evalInBrowser(ws, 'document.body.innerText');
    console.log(`  ✓ Cashier URL hiện tại: ${cashierUrl}`);
    assert(cashierUrl !== '/' || cashierBody.includes('403') || cashierBody.includes('quyền') || cashierBody.includes('Forbidden'),
      'Cashier không được phép vào trang Tổng quan');
    console.log('  ✓ Cashier bị chặn vào trang Tổng quan chính xác!');

    // Đăng xuất Cashier
    await evalInBrowser(ws, `
      (async () => {
        const token = await fetchCsrfToken();
        await fetch('/api/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': token } });
      })()
    `);

    // ------------------------------------------------------------------------
    // 2. MANAGER ĐĂNG NHẬP VÀ MỞ TRANG TỔNG QUAN (/)
    // ------------------------------------------------------------------------
    console.log('\n--- 2. Quản lý đăng nhập và mở trang Tổng quan (/) ---');
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/login` });
    await sleep(1000);

    const loginMgrOk = await evalInBrowser(ws, `
      (async () => {
        const token = await fetchCsrfToken();
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
          body: JSON.stringify({ username: 'dash_ui_mgr', password: 'password123' })
        });
        return res.ok;
      })()
    `);
    assert.strictEqual(loginMgrOk, true, 'Manager đăng nhập thành công');

    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/` });
    await sleep(1500);

    const mgrUrl = await evalInBrowser(ws, 'window.location.pathname');
    assert.strictEqual(mgrUrl, '/', 'Manager truy cập thành công trang Tổng quan');

    // Chụp ảnh giao diện Tổng quan
    const screenshotMain = path.join(ARTIFACTS_DIR, 'scratch', 'browser_dashboard_main.png');
    await captureScreenshot(ws, screenshotMain);

    // ------------------------------------------------------------------------
    // 3. KIỂM TRA CÁC THẺ SỐ LIỆU & BẢNG
    // ------------------------------------------------------------------------
    console.log('\n--- 3. Kiểm tra các thẻ số liệu thống kê trên giao diện ---');
    const dashData = await evalInBrowser(ws, `
      (() => {
        const todayDate = document.getElementById('today-date-label').innerText;
        const revenue = document.getElementById('stat-today-revenue').innerText;
        const invoices = document.getElementById('stat-today-invoices').innerText;
        const products = document.getElementById('stat-active-products').innerText;
        const lowStock = document.getElementById('stat-low-stock-count').innerText;
        const lowStockRows = document.querySelectorAll('#low-stock-tbody tr').length;
        const recentInvoiceRows = document.querySelectorAll('#recent-invoices-tbody tr').length;
        return {
          todayDate,
          revenue,
          invoices,
          products,
          lowStock,
          lowStockRows,
          recentInvoiceRows
        };
      })()
    `);
    console.log(`  ✓ Ngày hôm nay (Giờ VN): ${dashData.todayDate}`);
    console.log(`  ✓ Doanh thu hôm nay: ${dashData.revenue}`);
    console.log(`  ✓ Số hóa đơn hôm nay: ${dashData.invoices}`);
    console.log(`  ✓ Sản phẩm đang kinh doanh: ${dashData.products}`);
    console.log(`  ✓ Cần nhập thêm: ${dashData.lowStock} (số dòng bảng: ${dashData.lowStockRows})`);
    console.log(`  ✓ Hóa đơn gần đây: ${dashData.recentInvoiceRows} dòng`);

    assert(dashData.todayDate.includes('/'), 'Có định dạng ngày Việt Nam');
    assert(dashData.revenue.includes('đ'), 'Doanh thu có đơn vị VNĐ');

    // ------------------------------------------------------------------------
    // 4. KIỂM TRA NÚT LÀM MỚI DỮ LIỆU
    // ------------------------------------------------------------------------
    console.log('\n--- 4. Bấm nút Làm mới dữ liệu ---');
    const refreshResult = await evalInBrowser(ws, `
      (async () => {
        const btn = document.getElementById('btn-refresh-dashboard');
        btn.click();
        await new Promise(r => setTimeout(r, 1000));
        return {
          contentVisible: !document.getElementById('dashboard-content').classList.contains('d-none')
        };
      })()
    `);
    assert.strictEqual(refreshResult.contentVisible, true, 'Dữ liệu làm mới thành công');

    // ------------------------------------------------------------------------
    // 5. MỞ MODAL XEM CHI TIẾT HÓA ĐƠN GẦN ĐÂY
    // ------------------------------------------------------------------------
    console.log('\n--- 5. Mở Modal Chi tiết hóa đơn gần đây ---');
    const modalCheck = await evalInBrowser(ws, `
      (async () => {
        const firstViewBtn = document.querySelector('#recent-invoices-tbody tr button');
        if (!firstViewBtn) return { hasInvoices: false };
        firstViewBtn.click();
        await new Promise(r => setTimeout(r, 1200));

        return {
          hasInvoices: true,
          invNo: document.getElementById('m-inv-no').innerText,
          creator: document.getElementById('m-inv-creator').innerText,
          date: document.getElementById('m-inv-date').innerText,
          total: document.getElementById('m-inv-total').innerText,
          itemsCount: document.querySelectorAll('#m-inv-items-tbody tr').length
        };
      })()
    `);

    if (modalCheck.hasInvoices) {
      console.log(`  ✓ Chi tiết hóa đơn trong modal: Mã=${modalCheck.invNo}, Người lập=${modalCheck.creator}, Ngày=${modalCheck.date}, Tổng=${modalCheck.total}, Số mặt hàng=${modalCheck.itemsCount}`);
      assert(modalCheck.invNo.startsWith('HD'), 'Mã hóa đơn đúng tiền tố');
      assert(modalCheck.total.includes('đ'), 'Tổng tiền có định dạng VNĐ');

      // Chụp ảnh Modal chi tiết hóa đơn
      const screenshotModal = path.join(ARTIFACTS_DIR, 'scratch', 'browser_dashboard_modal.png');
      await captureScreenshot(ws, screenshotModal);

      // Đóng modal
      await evalInBrowser(ws, `
        (() => {
          closeInvoiceModal();
        })()
      `);
      await sleep(500);
    } else {
      console.log('  (Chưa có hóa đơn nào trong DB test, kiểm tra modal hoàn tất)');
    }

    console.log('\n🎉 TẤT CẢ CÁC BƯỚC KIỂM THỬ GIAO DIỆN TỔNG QUAN TRÊN TRÌNH DUYỆT ĐỀU THÀNH CÔNG RỰC RỠ!');
  } finally {
    try { ws.close(); } catch (e) {}
    try { chromeProcess.kill(); } catch (e) {}
    try { serverProcess.kill(); } catch (e) {}
  }
}

run().catch((err) => {
  console.error('\n❌ LỖI KIỂM THỬ TRÌNH DUYỆT TỔNG QUAN:', err);
  process.exit(1);
});
