require('dotenv').config();
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const TEST_PORT = 3008;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ARTIFACT_DIR = 'C:\\Users\\Dell Precision 5550\\.gemini\\antigravity-ide\\brain\\73031e9b-50f2-4c96-9b6a-5f67e969e504';
const USER_DATA_DIR = path.join(ARTIFACT_DIR, 'scratch', 'chrome_sales_test_profile');

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
  console.log('=== KIỂM THỬ TRÌNH DUYỆT GIAO DIỆN BÁN HÀNG (MANAGER & CASHIER) ===\n');

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
    ['sales_ui_mgr', hash, 'Quản Lý Cửa Hàng', 'MANAGER', 1]);
  await pool.query('INSERT INTO users (username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), is_active = 1',
    ['sales_ui_csh', hash, 'Thu Ngân Quầy 1', 'CASHIER', 1]);

  await pool.query('DELETE FROM products WHERE sku = "PROD_UI_TEST"');
  await pool.query(
    'INSERT INTO products (sku, name, unit, sale_price, stock_quantity, is_active) VALUES (?, ?, ?, ?, ?, ?)',
    ['PROD_UI_TEST', 'Bút Ký Cao Cấp', 'Cây', 120000, 25, 1]
  );
  await pool.end();

  // 2. Khởi động server test trên pos_store_test
  const serverProcess = spawn('node', ['server.js'], {
    env: { ...process.env, DB_NAME: 'pos_store_test', SESSION_SECRET: 'test_sales_ui_secret', PORT: String(TEST_PORT), METRICS_PORT: '0' }
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
    '--remote-debugging-port=9227',
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
        const resp = await fetch('http://127.0.0.1:9227/json');
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
    // 1. KIỂM THỬ GIAO DIỆN VỚI THU NGÂN (CASHIER)
    // ------------------------------------------------------------------------
    console.log('--- 1. Kiểm thử giao diện Bán Hàng với Thu ngân ---');
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/login` });
    await sleep(1000);

    const loginCshOk = await evalInBrowser(ws, `
      (async () => {
        const token = await fetchCsrfToken();
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
          body: JSON.stringify({ username: 'sales_ui_csh', password: 'password123' })
        });
        return res.ok;
      })()
    `);
    assert.strictEqual(loginCshOk, true, 'Thu ngân đăng nhập thành công');
    await sleep(1000);

    // Vào trang bán hàng (/sales)
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/sales` });
    await sleep(1500);

    // Kiểm tra các thành phần giao diện
    const pageHeader = await evalInBrowser(ws, `document.querySelector('h2')?.textContent?.trim()`);
    console.log(`  ✓ Tiêu đề trang: "${pageHeader}"`);
    assert.strictEqual(pageHeader, 'BÁN HÀNG TẠI QUẦY');

    const paymentBadge = await evalInBrowser(ws, `document.querySelector('.badge.bg-primary')?.textContent?.trim()`);
    console.log(`  ✓ Phương thức thanh toán: "${paymentBadge}"`);
    assert.ok(paymentBadge.includes('Tiền mặt'));

    // Kiểm tra tìm kiếm sản phẩm theo SKU
    await evalInBrowser(ws, `
      document.getElementById('s-search').value = 'PROD_UI_TEST';
      filterProductOptions('PROD_UI_TEST');
    `);
    await sleep(500);

    const infoBoxVisible = await evalInBrowser(ws, `!document.getElementById('s-product-info-box').classList.contains('d-none')`);
    assert.strictEqual(infoBoxVisible, true, 'Hộp thông tin chi tiết sản phẩm hiển thị');

    const productDetails = await evalInBrowser(ws, `({
      sku: document.getElementById('info-p-sku')?.textContent?.trim(),
      unit: document.getElementById('info-p-unit')?.textContent?.trim(),
      price: document.getElementById('info-p-price')?.textContent?.trim(),
      stock: document.getElementById('info-p-stock')?.textContent?.trim()
    })`);
    console.log('  ✓ Thông tin sản phẩm được chọn:', productDetails);
    assert.strictEqual(productDetails.sku, 'PROD_UI_TEST');
    assert.strictEqual(productDetails.unit, 'Cây');
    assert.strictEqual(productDetails.price, '120.000 đ');
    assert.ok(productDetails.stock.includes('25'));

    // Thêm 2 cây vào giỏ hàng
    await evalInBrowser(ws, `
      document.getElementById('s-qty').value = '2';
      addSaleItem();
    `);
    await sleep(500);

    const cartRows1 = await evalInBrowser(ws, `document.querySelectorAll('#s-cart tbody tr').length`);
    assert.strictEqual(cartRows1, 1, 'Giỏ hàng có 1 dòng sản phẩm');
    const total1 = await evalInBrowser(ws, `document.getElementById('s-total')?.textContent?.trim()`);
    console.log(`  ✓ Thêm 2 cây thành công, tổng tiền: ${total1}`);
    assert.strictEqual(total1, '240.000 đ');

    // Thêm tiếp 1 cây (kiểm tra cộng dồn)
    await evalInBrowser(ws, `
      document.getElementById('s-qty').value = '1';
      addSaleItem();
    `);
    await sleep(500);
    const total2 = await evalInBrowser(ws, `document.getElementById('s-total')?.textContent?.trim()`);
    console.log(`  ✓ Cộng dồn thành 3 cây, tổng tiền: ${total2}`);
    assert.strictEqual(total2, '360.000 đ');

    // Sửa số lượng trực tiếp trong giỏ thành 4 cây
    await evalInBrowser(ws, `
      updateCartItemQty(0, '4');
    `);
    await sleep(500);
    const total3 = await evalInBrowser(ws, `document.getElementById('s-total')?.textContent?.trim()`);
    console.log(`  ✓ Sửa trực tiếp số lượng thành 4 cây, tổng tiền: ${total3}`);
    assert.strictEqual(total3, '480.000 đ');

    // Chụp ảnh giỏ hàng Thu ngân
    const ssCsh = await sendCdp(ws, 'Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'sales_cashier_screenshot.png'), Buffer.from(ssCsh.data, 'base64'));
    console.log('  ✓ Đã lưu ảnh giao diện Thu ngân vào sales_cashier_screenshot.png');

    // Thực hiện thanh toán
    console.log('  Tiến hành thanh toán đơn hàng...');
    await evalInBrowser(ws, `checkout()`);
    await sleep(2000);

    const successBoxVisible = await evalInBrowser(ws, `!document.getElementById('sales-success-box').classList.contains('d-none')`);
    assert.strictEqual(successBoxVisible, true, 'Hộp thông báo thanh toán thành công phải hiển thị');

    const createdInvoiceNo = await evalInBrowser(ws, `document.getElementById('success-invoice-no')?.textContent?.trim()`);
    console.log(`  ✓ Thanh toán thành công! Mã hóa đơn đã lưu: "${createdInvoiceNo}"`);
    assert.ok(createdInvoiceNo && createdInvoiceNo.startsWith('HD'));

    // Giỏ hàng sau thanh toán phải trống
    const cartAfter = await evalInBrowser(ws, `cart.length`);
    assert.strictEqual(cartAfter, 0, 'Giỏ hàng được làm trống sau thanh toán thành công');

    // Mở modal Xem / In Hóa Đơn
    console.log('  Mở Modal Xem / In Hóa Đơn...');
    await evalInBrowser(ws, `viewSavedInvoice()`);
    await sleep(1000);

    const modalTitle = await evalInBrowser(ws, `document.getElementById('invoice-modal-title')?.textContent?.trim()`);
    console.log(`  ✓ Modal hóa đơn mở thành công: "${modalTitle}"`);
    assert.strictEqual(modalTitle, `Hóa Đơn: ${createdInvoiceNo}`);

    const hasPrintBtn = await evalInBrowser(ws, `!!document.getElementById('btn-print-invoice')`);
    assert.strictEqual(hasPrintBtn, true, 'Nút "In / Lưu PDF" có mặt trong modal');

    // Chụp ảnh modal hóa đơn
    const ssModal = await sendCdp(ws, 'Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'sales_receipt_modal_screenshot.png'), Buffer.from(ssModal.data, 'base64'));
    console.log('  ✓ Đã lưu ảnh Modal xem/in hóa đơn vào sales_receipt_modal_screenshot.png');

    await evalInBrowser(ws, `closeInvoiceModal()`);
    await sleep(500);

    // ------------------------------------------------------------------------
    // 2. KIỂM THỬ GIAO DIỆN VỚI QUẢN LÝ (MANAGER)
    // ------------------------------------------------------------------------
    console.log('\n--- 2. Kiểm thử giao diện Bán Hàng với Quản lý ---');
    await evalInBrowser(ws, `window.logout ? window.logout() : (document.querySelector('a[onclick*="logout"]')?.click())`);
    await sleep(1000);

    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/login` });
    await sleep(1000);

    const loginMgrOk = await evalInBrowser(ws, `
      (async () => {
        const token = await fetchCsrfToken(true);
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
          body: JSON.stringify({ username: 'sales_ui_mgr', password: 'password123' })
        });
        return res.ok;
      })()
    `);
    assert.strictEqual(loginMgrOk, true, 'Quản lý đăng nhập thành công');
    await sleep(1000);

    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/sales` });
    await sleep(1500);

    const sellerMgrText = await evalInBrowser(ws, `document.getElementById('display-seller-info')?.textContent?.trim()`);
    console.log(`  ✓ Thông tin người bán hiển thị: "${sellerMgrText}"`);
    assert.ok(sellerMgrText.includes('Quản lý'));

    // Chụp ảnh giao diện Bán hàng của Quản lý
    const ssMgr = await sendCdp(ws, 'Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'sales_manager_screenshot.png'), Buffer.from(ssMgr.data, 'base64'));
    console.log('  ✓ Đã lưu ảnh giao diện Quản lý vào sales_manager_screenshot.png');

    console.log('\n======================================================');
    console.log('🎉 KIỂM THỬ TRÌNH DUYỆT BÁN HÀNG THÀNH CÔNG 100%!');
    console.log('======================================================\n');

  } finally {
    if (ws) ws.close();
    chromeProcess.kill();
    serverProcess.kill();
  }
}

run().catch((err) => {
  console.error('\n❌ LỖI KIỂM THỬ TRÌNH DUYỆT BÁN HÀNG:', err);
  process.exit(1);
});
