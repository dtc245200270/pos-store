require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const PORT = 3014;
const BASE_URL = `http://localhost:${PORT}`;
const ARTIFACTS_DIR = 'C:\\Users\\Dell Precision 5550\\.gemini\\antigravity-ide\\brain\\246ce1ac-f161-4dc9-98e7-8d7ff9081ef7';
const USER_DATA_DIR = path.join(ARTIFACTS_DIR, 'scratch', 'chrome_inventory_profile');

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
  console.log('=== KIỂM THỬ TRÌNH DUYỆT GIAO DIỆN TỒN KHO (CHROME HEADLESS) ===\n');

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
    ['inv_ui_mgr', hash, 'Nguyễn Quản Lý Kho', 'MANAGER', 1]);
  await pool.query('INSERT INTO users (username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), is_active = 1',
    ['inv_ui_csh', hash, 'Trần Thu Ngân Kho', 'CASHIER', 1]);

  // Tạo sản phẩm mẫu có biến động kho
  const [mgrUserRows] = await pool.query('SELECT id FROM users WHERE username = "inv_ui_mgr"');
  const mgrId = mgrUserRows[0].id;
  const [cshUserRows] = await pool.query('SELECT id FROM users WHERE username = "inv_ui_csh"');
  const cshId = cshUserRows[0].id;

  await pool.query(`
    INSERT INTO products (sku, name, unit, sale_price, stock_quantity, is_active)
    VALUES 
      ('UI-INV-01', 'Bút Ký Cao Cấp Parker', 'Cây', 350000.00, 8, 1),
      ('UI-INV-02', 'Sổ Tay Bìa Da A5', 'Cuốn', 85000.00, 2, 1),
      ('UI-INV-03', 'Hộp Ghim Giấy Deli', 'Hộp', 15000.00, 0, 1)
    ON DUPLICATE KEY UPDATE stock_quantity = VALUES(stock_quantity), is_active = 1
  `);

  const [pRows] = await pool.query('SELECT id FROM products WHERE sku = "UI-INV-01"');
  const p1Id = pRows[0].id;

  // Phiếu nhập +10
  const receiptNo = 'PN-BROWSER-' + Date.now().toString().slice(-5);
  const [rRes] = await pool.query(`
    INSERT INTO stock_receipts (receipt_no, created_by, request_key, request_hash, total_amount)
    VALUES (?, ?, ?, ?, 2000000.00)
  `, [receiptNo, mgrId, 'req-key-b-rcpt-' + Date.now(), 'a'.repeat(64)]);
  const receiptId = rRes.insertId;

  const [riRes] = await pool.query(`
    INSERT INTO stock_receipt_items (receipt_id, product_id, product_name_snapshot, unit_snapshot, quantity, unit_cost)
    VALUES (?, ?, 'Bút Ký Cao Cấp Parker', 'Cây', 10, 200000.00)
  `, [receiptId, p1Id]);
  const receiptItemId = riRes.insertId;

  await pool.query(`
    INSERT INTO stock_movements (product_id, receipt_item_id, quantity_delta, balance_after)
    VALUES (?, ?, 10, 10)
  `, [p1Id, receiptItemId]);

  // Hóa đơn bán -2
  const invoiceNo = 'HD-BROWSER-' + Date.now().toString().slice(-5);
  const [invRes] = await pool.query(`
    INSERT INTO invoices (invoice_no, created_by, request_key, request_hash, total_amount)
    VALUES (?, ?, ?, ?, 700000.00)
  `, [invoiceNo, cshId, 'req-key-b-inv-' + Date.now(), 'b'.repeat(64)]);
  const invoiceId = invRes.insertId;

  const [iiRes] = await pool.query(`
    INSERT INTO invoice_items (invoice_id, product_id, product_name_snapshot, unit_snapshot, quantity, unit_price)
    VALUES (?, ?, 'Bút Ký Cao Cấp Parker', 'Cây', 2, 350000.00)
  `, [invoiceId, p1Id]);
  const invoiceItemId = iiRes.insertId;

  await pool.query(`
    INSERT INTO stock_movements (product_id, invoice_item_id, quantity_delta, balance_after)
    VALUES (?, ?, -2, 8)
  `, [p1Id, invoiceItemId]);

  await pool.end();

  // 2. Khởi động server test cổng 3014
  const serverProcess = spawn('node', ['server.js'], {
    env: { ...process.env, DB_NAME: 'pos_store_test', PORT: String(PORT), SESSION_SECRET: 'test_inv_ui_secret' }
  });

  await new Promise((resolve) => {
    serverProcess.stdout.on('data', (d) => {
      if (d.toString().includes('Website đang chạy')) resolve();
    });
    setTimeout(resolve, 3000);
  });
  console.log(`✓ Server test đang chạy tại ${BASE_URL}`);

  // 3. Khởi động Chrome
  const CHROME_DEBUG_PORT = 9228;
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
    // 1. THU NGÂN (CASHIER) TRA CỨU TỒN KHO & KHÔNG CÓ NÚT LỊCH SỬ
    // ------------------------------------------------------------------------
    console.log('--- 1. Thu ngân đăng nhập và kiểm tra trang Tồn kho ---');
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/login` });
    await sleep(1000);

    const loginCashierOk = await evalInBrowser(ws, `
      (async () => {
        const token = await fetchCsrfToken();
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
          body: JSON.stringify({ username: 'inv_ui_csh', password: 'password123' })
        });
        return res.ok;
      })()
    `);
    assert.strictEqual(loginCashierOk, true, 'Cashier đăng nhập thành công');

    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/inventory` });
    await sleep(1500);

    const cashierState = await evalInBrowser(ws, `
      (() => {
        const badge = document.getElementById('user-role-badge').innerText;
        const rows = document.querySelectorAll('#inventory-tbody tr');
        const historyBtns = document.querySelectorAll('#inventory-tbody button');
        const readOnlyBadges = Array.from(document.querySelectorAll('#inventory-tbody tr td:last-child')).map(td => td.innerText);
        return {
          roleBadge: badge,
          rowCount: rows.length,
          historyBtnCount: historyBtns.length,
          readOnlyBadges
        };
      })()
    `);
    console.log(`  ✓ Vai trò hiển thị: ${cashierState.roleBadge}`);
    console.log(`  ✓ Số sản phẩm hiển thị: ${cashierState.rowCount}`);
    console.log(`  ✓ Số nút Lịch sử trong bảng: ${cashierState.historyBtnCount} (Mong muốn: 0 vì Thu ngân chỉ tra cứu)`);
    assert(cashierState.roleBadge.includes('Thu ngân'), 'Hiển thị đúng vai trò Thu ngân');
    assert.strictEqual(cashierState.historyBtnCount, 0, 'Thu ngân không có nút xem Lịch sử');
    assert(cashierState.rowCount >= 3, 'Thu ngân tra cứu được đầy đủ danh sách tồn kho');

    // Đăng xuất Cashier
    await evalInBrowser(ws, `
      (async () => {
        const token = await fetchCsrfToken();
        await fetch('/api/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': token } });
      })()
    `);

    // ------------------------------------------------------------------------
    // 2. QUẢN LÝ (MANAGER) TRA CỨU, BỘ LỌC NGƯỠNG, LÀM MỚI & XEM LỊCH SỬ
    // ------------------------------------------------------------------------
    console.log('\n--- 2. Quản lý đăng nhập và mở trang Quản lý Tồn kho ---');
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/login` });
    await sleep(1000);

    const loginMgrOk = await evalInBrowser(ws, `
      (async () => {
        const token = await fetchCsrfToken();
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
          body: JSON.stringify({ username: 'inv_ui_mgr', password: 'password123' })
        });
        return res.ok;
      })()
    `);
    assert.strictEqual(loginMgrOk, true, 'Manager đăng nhập thành công');

    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/inventory` });
    await sleep(1500);

    // Chụp ảnh giao diện Tồn kho ban đầu của Quản lý
    const screenshotMain = path.join(ARTIFACTS_DIR, 'scratch', 'browser_inventory_main.png');
    await captureScreenshot(ws, screenshotMain);

    const mgrState = await evalInBrowser(ws, `
      (() => {
        const badge = document.getElementById('user-role-badge').innerText;
        const historyBtns = document.querySelectorAll('#inventory-tbody button');
        const thresholdLabel = document.getElementById('current-threshold-label').innerText;
        const bannerText = document.getElementById('threshold-banner').innerText;
        return {
          roleBadge: badge,
          historyBtnCount: historyBtns.length,
          thresholdLabel,
          bannerText
        };
      })()
    `);
    console.log(`  ✓ Vai trò Quản lý: ${mgrState.roleBadge}`);
    console.log(`  ✓ Số nút Lịch sử hiển thị: ${mgrState.historyBtnCount} (Quản lý có toàn quyền xem lịch sử)`);
    console.log(`  ✓ Ngưỡng sắp hết hàng: ${mgrState.thresholdLabel}`);
    assert(mgrState.roleBadge.includes('Quản lý'), 'Đúng vai trò Quản lý');
    assert(mgrState.historyBtnCount > 0, 'Quản lý có nút xem Lịch sử biến động');
    assert(mgrState.bannerText.includes('Quy tắc phân loại'), 'Có thông báo minh bạch về quy tắc ngưỡng');

    // ------------------------------------------------------------------------
    // 3. THỬ NGHIỆM ĐIỀU CHỈNH NGƯỠNG CẢNH BÁO SẮP HẾT HÀNG
    // ------------------------------------------------------------------------
    console.log('\n--- 3. Thử nghiệm thay đổi ngưỡng cảnh báo sắp hết hàng ---');
    const thresholdUpdateResult = await evalInBrowser(ws, `
      (async () => {
        const input = document.getElementById('low-stock-threshold');
        input.value = '10';
        onThresholdChange();
        await new Promise(r => setTimeout(r, 800));

        return {
          label: document.getElementById('current-threshold-label').innerText
        };
      })()
    `);
    console.log(`  ✓ Sau khi cập nhật: Ngưỡng hiển thị là ${thresholdUpdateResult.label}`);
    assert.strictEqual(thresholdUpdateResult.label, '10', 'Ngưỡng được cập nhật chính xác thành 10');

    // ------------------------------------------------------------------------
    // 4. KIỂM TRA NÚT LÀM MỚI DỮ LIỆU
    // ------------------------------------------------------------------------
    console.log('\n--- 4. Bấm nút Làm mới dữ liệu ---');
    const refreshResult = await evalInBrowser(ws, `
      (async () => {
        const btn = document.getElementById('btn-refresh-inventory');
        btn.click();
        await new Promise(r => setTimeout(r, 1000));
        return {
          rowCount: document.querySelectorAll('#inventory-tbody tr').length,
          btnText: btn.innerText
        };
      })()
    `);
    console.log(`  ✓ Số dòng sau khi Làm mới: ${refreshResult.rowCount}`);
    assert(refreshResult.rowCount >= 3, 'Tải lại dữ liệu thành công sau khi bấm Làm mới');

    // ------------------------------------------------------------------------
    // 5. MỞ MODAL XEM LỊCH SỬ BIẾN ĐỘNG KHO (GIỜ VN, CHỨNG TỪ, NGƯỜI LẬP, +/-)
    // ------------------------------------------------------------------------
    console.log('\n--- 5. Mở Modal Lịch sử biến động kho của UI-INV-01 ---');
    const modalData = await evalInBrowser(ws, `
      (async () => {
        // Tìm dòng có SKU UI-INV-01 và bấm nút Lịch sử
        const rows = Array.from(document.querySelectorAll('#inventory-tbody tr'));
        const row01 = rows.find(r => r.innerText.includes('UI-INV-01'));
        if (!row01) return { error: 'Không tìm thấy dòng UI-INV-01' };

        const btn = row01.querySelector('button');
        if (!btn) return { error: 'Không tìm thấy nút Lịch sử' };
        btn.click();
        await new Promise(r => setTimeout(r, 1200));

        const modalTitle = document.getElementById('history-modal-title').innerText;
        const modalSku = document.getElementById('modal-sku').innerText;
        const modalStock = document.getElementById('modal-stock').innerText;
        const historyRows = Array.from(document.querySelectorAll('#history-tbody tr')).map(tr => tr.innerText);

        return {
          modalTitle,
          modalSku,
          modalStock,
          historyRows
        };
      })()
    `);
    console.log(`  ✓ Tiêu đề Modal: ${modalData.modalTitle}`);
    console.log(`  ✓ Thông tin sản phẩm: SKU=${modalData.modalSku}, Tồn=${modalData.modalStock}`);
    console.log(`  ✓ Các dòng biến động kho trong modal:`, modalData.historyRows);

    assert(modalData.modalTitle.includes('UI-INV-01'), 'Tiêu đề có mã SKU');
    assert(modalData.modalStock.includes('8'), 'Tồn kho hiển thị đúng 8 Cây');
    assert.strictEqual(modalData.historyRows.length, 2, 'Có đủ 2 dòng biến động: Nhập +10 và Xuất -2');

    // Chụp ảnh Modal chi tiết
    const screenshotModal = path.join(ARTIFACTS_DIR, 'scratch', 'browser_inventory_modal.png');
    await captureScreenshot(ws, screenshotModal);

    // Đóng modal
    await evalInBrowser(ws, `
      (() => {
        closeHistoryModal();
      })()
    `);
    await sleep(500);

    console.log('\n🎉 TẤT CẢ CÁC BƯỚC KIỂM THỬ GIAO DIỆN TỒN KHO TRÊN TRÌNH DUYỆT ĐỀU THÀNH CÔNG RỰC RỠ!');
  } finally {
    try { ws.close(); } catch (e) {}
    try { chromeProcess.kill(); } catch (e) {}
    try { serverProcess.kill(); } catch (e) {}
  }
}

run().catch((err) => {
  console.error('\n❌ LỖI KIỂM THỬ TRÌNH DUYỆT TỒN KHO:', err);
  process.exit(1);
});
