require('dotenv').config();
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const TEST_PORT = 3006;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ARTIFACT_DIR = 'C:\\Users\\Dell Precision 5550\\.gemini\\antigravity-ide\\brain\\73031e9b-50f2-4c96-9b6a-5f67e969e504';
const USER_DATA_DIR = path.join(ARTIFACT_DIR, 'scratch', 'chrome_inv_test_profile');

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
  console.log('=== KIỂM THỬ TRÌNH DUYỆT GIAO DIỆN HÓA ĐƠN (QUẢN LÝ & THU NGÂN) ===\n');

  if (!fs.existsSync(USER_DATA_DIR)) {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  }

  const mysql = require('mysql2/promise');
  const bcrypt = require('bcryptjs');
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
    ['inv_mgr', hash, 'Quản Lý Cửa Hàng', 'MANAGER', 1]);
  await pool.query('INSERT INTO users (username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), is_active = 1',
    ['inv_csh1', hash, 'Thu Ngân Số 1', 'CASHIER', 1]);
  await pool.end();

  // Khởi động server test trên pos_store_test
  const serverProcess = spawn('node', ['server.js'], {
    env: { ...process.env, DB_NAME: 'pos_store_test', SESSION_SECRET: 'test_inv_ui_secret', PORT: String(TEST_PORT), METRICS_PORT: '0' }
  });

  await new Promise((resolve) => {
    serverProcess.stdout.on('data', (d) => {
      if (d.toString().includes('Website đang chạy')) resolve();
    });
    setTimeout(resolve, 3000);
  });
  console.log('✓ Server kiểm thử UI đã sẵn sàng.\n');

  const chromeProcess = spawn(CHROME_PATH, [
    '--headless=new',
    '--remote-debugging-port=9226',
    `--user-data-dir=${USER_DATA_DIR}`,
    '--window-size=1280,850',
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
        const resp = await fetch('http://127.0.0.1:9226/json');
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

    // ------------------------------------------------------------------------
    // 1. KIỂM THỬ VAI TRÒ QUẢN LÝ (MANAGER)
    // ------------------------------------------------------------------------
    console.log('\n--- 1. Kiểm thử giao diện Hóa Đơn với Quản lý ---');
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/login` });
    await sleep(1000);

    const loginMgrResult = await evalInBrowser(ws, `
      (async () => {
        const token = await fetchCsrfToken();
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
          body: JSON.stringify({ username: 'inv_mgr', password: 'password123' })
        });
        const text = await res.text();
        return { ok: res.ok, status: res.status, text };
      })()
    `);
    console.log('Login result:', loginMgrResult);
    assert.strictEqual(loginMgrResult.ok, true, 'Quản lý đăng nhập thành công');
    await sleep(500);

    // Vào trang hóa đơn
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/invoices` });
    await sleep(1500);

    const mgrPageTitle = await evalInBrowser(ws, `document.getElementById('invoices-page-title')?.textContent?.trim()`);
    console.log(`  ✓ Tiêu đề trang cho Quản lý: "${mgrPageTitle}"`);
    assert.strictEqual(mgrPageTitle, 'QUẢN LÝ HÓA ĐƠN');

    const sellerFilterDisplay = await evalInBrowser(ws, `document.getElementById('seller-filter-container')?.style.display`);
    console.log(`  ✓ Bộ lọc người bán cho Quản lý: ${sellerFilterDisplay === 'block' ? 'Hiển thị (Đúng)' : sellerFilterDisplay}`);
    assert.strictEqual(sellerFilterDisplay, 'block');

    const sellerOptionsCount = await evalInBrowser(ws, `document.getElementById('filter-seller')?.options?.length || 0`);
    console.log(`  ✓ Số lựa chọn người bán trong dropdown: ${sellerOptionsCount}`);
    assert.ok(sellerOptionsCount > 1, 'Dropdown người bán phải có các tùy chọn người bán');

    const filterInputs = await evalInBrowser(ws, `({
      invoiceNo: !!document.getElementById('filter-invoice-no'),
      fromDate: !!document.getElementById('filter-from-date'),
      toDate: !!document.getElementById('filter-to-date'),
      btnFilter: !!document.getElementById('btn-apply-filter'),
      btnReset: !!document.getElementById('btn-reset-filter')
    })`);
    console.log('  ✓ Bộ lọc tìm kiếm có đầy đủ các trường:', filterInputs);
    assert.strictEqual(filterInputs.invoiceNo, true);
    assert.strictEqual(filterInputs.fromDate, true);
    assert.strictEqual(filterInputs.toDate, true);

    const tableRows = await evalInBrowser(ws, `document.querySelectorAll('#invoices-table tbody tr').length`);
    console.log(`  ✓ Số dòng hóa đơn hiển thị trong bảng: ${tableRows}`);

    const paginationVisible = await evalInBrowser(ws, `!!document.getElementById('invoices-pagination')`);
    assert.strictEqual(paginationVisible, true, 'Khu vực phân trang hiển thị');

    // Mở modal xem chi tiết hóa đơn đầu tiên (nếu có)
    const hasDetailBtn = await evalInBrowser(ws, `!!document.querySelector('#invoices-table tbody button')`);
    if (hasDetailBtn) {
      console.log('  Mở Modal Chi Tiết Hóa Đơn...');
      await evalInBrowser(ws, `document.querySelector('#invoices-table tbody button').click()`);
      await sleep(1000);

      const modalInfo = await evalInBrowser(ws, `({
        title: document.getElementById('invoice-modal-title')?.textContent?.trim(),
        hasPrintBtn: !!document.getElementById('btn-print-invoice'),
        hasReceipt: !!document.querySelector('#invoice-preview-area .invoice-receipt-wrapper')
      })`);
      console.log('  ✓ Thông tin Modal chi tiết:', modalInfo);
      assert.strictEqual(modalInfo.hasPrintBtn, true, 'Nút "In / Lưu PDF" phải có mặt trong modal');
      assert.strictEqual(modalInfo.hasReceipt, true, 'Nội dung hóa đơn bán hàng hiển thị trong modal');

      // Chụp ảnh chi tiết hóa đơn của Quản lý
      const ssMgr = await sendCdp(ws, 'Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(ARTIFACT_DIR, 'invoices_manager_detail_screenshot.png'), Buffer.from(ssMgr.data, 'base64'));
      console.log('  ✓ Đã lưu ảnh chụp modal chi tiết Quản lý vào invoices_manager_detail_screenshot.png');

      await evalInBrowser(ws, `closeInvoiceModal()`);
      await sleep(500);
    }

    // Chụp ảnh danh sách hóa đơn Quản lý
    const ssMgrList = await sendCdp(ws, 'Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'invoices_manager_screenshot.png'), Buffer.from(ssMgrList.data, 'base64'));
    console.log('  ✓ Đã lưu ảnh danh sách Quản lý vào invoices_manager_screenshot.png');

    // ------------------------------------------------------------------------
    // 2. KIỂM THỬ VAI TRÒ THU NGÂN (CASHIER)
    // ------------------------------------------------------------------------
    console.log('\n--- 2. Đăng xuất và đăng nhập Thu ngân (Cashier) ---');
    await evalInBrowser(ws, `window.logout ? window.logout() : (document.querySelector('a[onclick*="logout"]')?.click())`);
    await sleep(1000);

    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/login` });
    await sleep(1000);

    const loginCshOk = await evalInBrowser(ws, `
      (async () => {
        const token = await fetchCsrfToken(true);
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
          body: JSON.stringify({ username: 'inv_csh1', password: 'password123' })
        });
        return res.ok;
      })()
    `);
    assert.strictEqual(loginCshOk, true, 'Thu ngân đăng nhập thành công');
    await sleep(500);

    // Thu ngân vào trang hóa đơn (/invoices)
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/invoices` });
    await sleep(1500);

    const cshPageTitle = await evalInBrowser(ws, `document.getElementById('invoices-page-title')?.textContent?.trim()`);
    console.log(`  ✓ Tiêu đề trang cho Thu ngân: "${cshPageTitle}"`);
    assert.strictEqual(cshPageTitle, 'HÓA ĐƠN CỦA TÔI');

    const sellerFilterDisplayCsh = await evalInBrowser(ws, `document.getElementById('seller-filter-container')?.style.display`);
    console.log(`  ✓ Bộ lọc người bán cho Thu ngân: ${sellerFilterDisplayCsh === 'none' ? 'Ẩn hoàn toàn (Đúng)' : sellerFilterDisplayCsh}`);
    assert.strictEqual(sellerFilterDisplayCsh, 'none', 'Thu ngân không được hiển thị bộ lọc người bán');

    // Chụp ảnh màn hình danh sách của Thu ngân
    const ssCshList = await sendCdp(ws, 'Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'invoices_cashier_screenshot.png'), Buffer.from(ssCshList.data, 'base64'));
    console.log('  ✓ Đã lưu ảnh danh sách Thu ngân vào invoices_cashier_screenshot.png');

    console.log('\n======================================================');
    console.log('🎉 KIỂM THỬ TRÌNH DUYỆT HÓA ĐƠN THÀNH CÔNG 100%!');
    console.log('======================================================\n');
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
