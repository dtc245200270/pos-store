require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const PORT = 3010;
const BASE_URL = `http://localhost:${PORT}`;
const ARTIFACTS_DIR = 'C:\\Users\\Dell Precision 5550\\.gemini\\antigravity-ide\\brain\\73031e9b-50f2-4c96-9b6a-5f67e969e504';
const USER_DATA_DIR = path.join(ARTIFACTS_DIR, 'scratch', 'chrome_prod_test_profile');

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

async function captureScreenshot(ws, filepath) {
  const result = await sendCdp(ws, 'Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(filepath, Buffer.from(result.data, 'base64'));
  console.log(`  ✓ Đã lưu ảnh chụp: ${filepath}`);
}

async function run() {
  console.log('=== KIỂM THỬ TRÌNH DUYỆT GIAO DIỆN SẢN PHẨM (CHROME HEADLESS) ===\n');

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
    ['prod_ui_mgr', hash, 'Nguyễn Quản Lý', 'MANAGER', 1]);
  await pool.query('INSERT INTO users (username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), is_active = 1',
    ['prod_ui_csh', hash, 'Trần Thu Ngân', 'CASHIER', 1]);

  await pool.end();

  // 2. Khởi động server test
  const serverProcess = spawn('node', ['server.js'], {
    env: { ...process.env, DB_NAME: 'pos_store_test', PORT: String(PORT), SESSION_SECRET: 'test_secret_prod_ui' }
  });

  await new Promise((resolve) => {
    serverProcess.stdout.on('data', (d) => {
      if (d.toString().includes('Website đang chạy')) resolve();
    });
    setTimeout(resolve, 3000);
  });
  console.log(`✓ Server test đang chạy tại ${BASE_URL}`);

  // 3. Khởi động Chrome
  const CHROME_DEBUG_PORT = 9224;
  const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

  const chromeProcess = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${CHROME_DEBUG_PORT}`,
    `--user-data-dir=${USER_DATA_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1280,900'
  ]);

  const wsUrl = await getWebSocketDebuggerUrl(CHROME_DEBUG_PORT);
  const ws = new WebSocket(wsUrl);
  await new Promise(r => ws.addEventListener('open', r));

  await sendCdp(ws, 'Page.enable');
  await sendCdp(ws, 'Runtime.enable');
  await sendCdp(ws, 'Network.enable');

  try {
    // ------------------------------------------------------------------------
    // 1. ĐĂNG NHẬP VỚI QUẢN LÝ (MANAGER)
    // ------------------------------------------------------------------------
    console.log('--- 1. Quản lý đăng nhập và truy cập /products ---');
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/login` });
    await sleep(1000);

    const loginMgrOk = await evalInBrowser(ws, `
      (async () => {
        const token = await fetchCsrfToken();
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
          body: JSON.stringify({ username: 'prod_ui_mgr', password: 'password123' })
        });
        return res.ok;
      })()
    `);
    assert.strictEqual(loginMgrOk, true, 'Quản lý đăng nhập thành công');
    await sleep(800);

    // Truy cập /products
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/products` });
    await sleep(1500);

    const title = await evalInBrowser(ws, `document.querySelector('h2')?.textContent?.trim()`);
    console.log(`  ✓ Tiêu đề trang: "${title}"`);
    assert.ok(title.includes('Quản lý sản phẩm'));

    const paginationText = await evalInBrowser(ws, `document.getElementById('pagination-info')?.textContent?.trim()`);
    console.log(`  ✓ Phân trang: "${paginationText}"`);
    assert.ok(paginationText.includes('Hiển thị'));

    // Chụp ảnh màn hình danh sách sản phẩm
    const listImg = path.join(ARTIFACTS_DIR, 'products_manager_list_screenshot.png');
    await captureScreenshot(ws, listImg);

    // ------------------------------------------------------------------------
    // 2. MỞ MODAL THÊM SẢN PHẨM MỚI
    // ------------------------------------------------------------------------
    console.log('\n--- 2. Mở biểu mẫu thêm sản phẩm mới ---');
    await evalInBrowser(ws, `document.getElementById('btn-add-product').click()`);
    await sleep(600);

    const modalTitle = await evalInBrowser(ws, `document.getElementById('product-modal-title')?.textContent?.trim()`);
    const skuVal = await evalInBrowser(ws, `document.getElementById('p-sku')?.value`);
    const priceVal = await evalInBrowser(ws, `document.getElementById('p-price')?.value`);
    const noticeText = await evalInBrowser(ws, `document.getElementById('p-stock-notice')?.innerText?.trim()`);

    console.log(`  ✓ Tiêu đề Modal: "${modalTitle}"`);
    console.log(`  ✓ SKU ban đầu: "${skuVal}" (Trống)`);
    console.log(`  ✓ Giá bán ban đầu: "${priceVal}" (Trống)`);
    console.log(`  ✓ Ghi chú tồn kho: "${noticeText}"`);
    assert.strictEqual(skuVal, '');
    assert.strictEqual(priceVal, '');
    assert.ok(noticeText.includes('Tồn kho ban đầu: 0'));

    const addImg = path.join(ARTIFACTS_DIR, 'products_add_modal_screenshot.png');
    await captureScreenshot(ws, addImg);

    await evalInBrowser(ws, `closeModal('product-modal')`);
    await sleep(400);

    // ------------------------------------------------------------------------
    // 3. MỞ MODAL SỬA SẢN PHẨM
    // ------------------------------------------------------------------------
    console.log('\n--- 3. Mở biểu mẫu sửa sản phẩm ---');
    await evalInBrowser(ws, `
      const editBtn = document.querySelector('#products-tbody tr button.btn-outline-primary');
      if (editBtn) editBtn.click();
    `);
    await sleep(600);

    const editTitle = await evalInBrowser(ws, `document.getElementById('product-modal-title')?.textContent?.trim()`);
    const editSku = await evalInBrowser(ws, `document.getElementById('p-sku')?.value`);
    const editStockNotice = await evalInBrowser(ws, `document.getElementById('p-stock-notice')?.innerText?.trim()`);

    console.log(`  ✓ Tiêu đề Modal Sửa: "${editTitle}"`);
    console.log(`  ✓ SKU hiện tại: "${editSku}"`);
    console.log(`  ✓ Ghi chú tồn kho: "${editStockNotice}"`);
    assert.ok(editTitle.includes('Sửa Sản Phẩm'));
    assert.ok(editSku.length > 0);
    assert.ok(editStockNotice.includes('Tồn kho hiện tại:'));
    assert.ok(editStockNotice.includes('Không cho phép sửa tồn kho trực tiếp'));

    const editImg = path.join(ARTIFACTS_DIR, 'products_edit_modal_screenshot.png');
    await captureScreenshot(ws, editImg);

    await evalInBrowser(ws, `closeModal('product-modal')`);
    await sleep(400);

    // ------------------------------------------------------------------------
    // 4. KIỂM TRA PHÂN QUYỀN: THU NGÂN TRUY CẬP /products
    // ------------------------------------------------------------------------
    console.log('\n--- 4. Kiểm tra phân quyền: Thu ngân truy cập /products ---');
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/login` });
    await sleep(800);

    const loginCshOk = await evalInBrowser(ws, `
      (async () => {
        const token = await fetchCsrfToken();
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
          body: JSON.stringify({ username: 'prod_ui_csh', password: 'password123' })
        });
        return res.ok;
      })()
    `);
    assert.strictEqual(loginCshOk, true, 'Thu ngân đăng nhập thành công');
    await sleep(600);

    // Cố truy cập /products
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/products` });
    await sleep(1000);

    const cshCurrentUrl = await evalInBrowser(ws, `window.location.pathname`);
    const cshPageText = await evalInBrowser(ws, `document.body.innerText`);
    console.log(`  ✓ URL phản hồi: "${cshCurrentUrl}"`);
    console.log(`  ✓ Nội dung: "${cshPageText.trim().substring(0, 80)}"`);
    assert.ok(cshPageText.includes('403') || cshPageText.toLowerCase().includes('không có quyền') || cshCurrentUrl === '/sales');

    console.log('\n================================================================');
    console.log('🎉 KIỂM THỬ TRÌNH DUYỆT TRANG SẢN PHẨM HOÀN TẤT THÀNH CÔNG 100%!');
    console.log('================================================================\n');
  } catch (err) {
    console.error('❌ Lỗi kiểm thử:', err);
    process.exitCode = 1;
  } finally {
    ws.close();
    chromeProcess.kill();
    serverProcess.kill();
  }
}

run();
