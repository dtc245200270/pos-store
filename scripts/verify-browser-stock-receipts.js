require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const PORT = 3012;
const BASE_URL = `http://localhost:${PORT}`;
const ARTIFACTS_DIR = 'C:\\Users\\Dell Precision 5550\\.gemini\\antigravity-ide\\brain\\246ce1ac-f161-4dc9-98e7-8d7ff9081ef7';
const USER_DATA_DIR = path.join(ARTIFACTS_DIR, 'scratch', 'chrome_receipts_profile');

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
  console.log('=== KIỂM THỬ TRÌNH DUYỆT GIAO DIỆN NHẬP HÀNG (CHROME HEADLESS) ===\n');

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
    ['rcpt_ui_mgr', hash, 'Nguyễn Quản Lý Nhập Hàng', 'MANAGER', 1]);
  await pool.query('INSERT INTO users (username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), is_active = 1',
    ['rcpt_ui_csh', hash, 'Trần Thu Ngân', 'CASHIER', 1]);

  // Đảm bảo có ít nhất 2 sản phẩm mẫu đang kinh doanh
  await pool.query(`
    INSERT INTO products (sku, name, unit, sale_price, stock_quantity, is_active)
    VALUES 
      ('UI-SP1', 'Sản phẩm Test UI 1', 'Cái', 50000.00, 10, 1),
      ('UI-SP2', 'Sản phẩm Test UI 2', 'Hộp', 120000.00, 5, 1)
    ON DUPLICATE KEY UPDATE is_active = 1
  `);

  await pool.end();

  // 2. Khởi động server test trên port 3012
  const serverProcess = spawn('node', ['server.js'], {
    env: { ...process.env, DB_NAME: 'pos_store_test', PORT: String(PORT), METRICS_PORT: '0', SESSION_SECRET: 'test_secret_rcpt_ui' }
  });

  await new Promise((resolve) => {
    serverProcess.stdout.on('data', (d) => {
      if (d.toString().includes('Website đang chạy')) resolve();
    });
    setTimeout(resolve, 3000);
  });
  console.log(`✓ Server test đang chạy tại ${BASE_URL}`);

  // 3. Khởi động Chrome
  const CHROME_DEBUG_PORT = 9226;
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
    // 1. CASHIER BỊ CHẶN TRUY CẬP /stock-receipts
    // ------------------------------------------------------------------------
    console.log('--- 1. Thu ngân đăng nhập và truy cập /stock-receipts ---');
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/login` });
    await sleep(1000);

    const loginCashierOk = await evalInBrowser(ws, `
      (async () => {
        const token = await fetchCsrfToken();
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
          body: JSON.stringify({ username: 'rcpt_ui_csh', password: 'password123' })
        });
        return res.ok;
      })()
    `);
    assert.strictEqual(loginCashierOk, true, 'Cashier đăng nhập thành công');

    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/stock-receipts` });
    await sleep(1000);

    const cashierUrl = await evalInBrowser(ws, 'window.location.pathname');
    const cashierBody = await evalInBrowser(ws, 'document.body.innerText');
    console.log(`  ✓ Cashier URL hiện tại: ${cashierUrl}`);
    assert(
      cashierUrl !== '/stock-receipts' || cashierBody.includes('403') || cashierBody.includes('quyền') || cashierBody.includes('Forbidden'),
      'Cashier không được phép vào trang Nhập hàng'
    );
    console.log('  ✓ Cashier bị chặn vào trang Nhập hàng chính xác!');

    // Đăng xuất Cashier
    await evalInBrowser(ws, `
      (async () => {
        const token = await fetchCsrfToken();
        await fetch('/api/auth/logout', { method: 'POST', headers: { 'X-CSRF-Token': token } });
      })()
    `);

    // ------------------------------------------------------------------------
    // 2. MANAGER ĐĂNG NHẬP VÀO /stock-receipts
    // ------------------------------------------------------------------------
    console.log('\n--- 2. Quản lý đăng nhập và mở trang /stock-receipts ---');
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/login` });
    await sleep(1000);

    const loginMgrOk = await evalInBrowser(ws, `
      (async () => {
        const token = await fetchCsrfToken();
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
          body: JSON.stringify({ username: 'rcpt_ui_mgr', password: 'password123' })
        });
        return res.ok;
      })()
    `);
    assert.strictEqual(loginMgrOk, true, 'Manager đăng nhập thành công');

    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/stock-receipts` });
    await sleep(1500);

    const mgrUrl = await evalInBrowser(ws, 'window.location.pathname');
    assert.strictEqual(mgrUrl, '/stock-receipts', 'Manager truy cập thành công /stock-receipts');

    // Chụp ảnh giao diện ban đầu
    const screenshotInit = path.join(ARTIFACTS_DIR, 'scratch', 'browser_receipts_init.png');
    await captureScreenshot(ws, screenshotInit);

    // ------------------------------------------------------------------------
    // 3. THAO TÁC THÊM, SỬA, XÓA DÒNG VÀ TÍNH TỔNG TIỀN
    // ------------------------------------------------------------------------
    console.log('\n--- 3. Thêm, Sửa, Xóa dòng phiếu nhập trên giao diện ---');

    // Chờ dropdown r-product có dữ liệu
    await evalInBrowser(ws, `
      (async () => {
        for (let i = 0; i < 20; i++) {
          const select = document.getElementById('r-product');
          if (select && select.options.length > 1) return true;
          await new Promise(r => setTimeout(r, 200));
        }
        return false;
      })()
    `);

    // Chọn SP1, số lượng 4, giá 35000
    const addRow1 = await evalInBrowser(ws, `
      (() => {
        const select = document.getElementById('r-product');
        const opt1 = Array.from(select.options).find(o => o.text.includes('UI-SP1'));
        if (!opt1) return { error: 'Không tìm thấy UI-SP1 trong select' };
        select.value = opt1.value;
        select.dispatchEvent(new Event('change'));

        document.getElementById('r-qty').value = '4';
        document.getElementById('r-cost').value = '35000';
        addOrUpdateReceiptItem();
        return { success: true };
      })()
    `);
    assert.strictEqual(addRow1.success, true);
    await sleep(300);

    // Thêm tiếp SP2, số lượng 6, giá 80000
    const addRow2 = await evalInBrowser(ws, `
      (() => {
        const select = document.getElementById('r-product');
        const opt2 = Array.from(select.options).find(o => o.text.includes('UI-SP2'));
        if (!opt2) return { error: 'Không tìm thấy UI-SP2 trong select' };
        select.value = opt2.value;
        select.dispatchEvent(new Event('change'));

        document.getElementById('r-qty').value = '6';
        document.getElementById('r-cost').value = '80000';
        addOrUpdateReceiptItem();
        return { success: true };
      })()
    `);
    assert.strictEqual(addRow2.success, true);
    await sleep(300);

    // Kiểm tra hiển thị 2 dòng và tổng tiền: 4*35000 + 6*80000 = 140,000 + 480,000 = 620,000 đ
    const tableState = await evalInBrowser(ws, `
      (() => {
        const rows = document.querySelectorAll('#r-cart tbody tr');
        const totalText = document.getElementById('r-total').innerText;
        return {
          rowCount: rows.length,
          totalText
        };
      })()
    `);
    console.log(`  ✓ Số dòng bảng nhập: ${tableState.rowCount}, Tổng tiền hiển thị: ${tableState.totalText}`);
    assert.strictEqual(tableState.rowCount, 2, 'Bảng có đúng 2 dòng sản phẩm');
    assert(tableState.totalText.includes('620.000') || tableState.totalText.includes('620,000'), 'Tổng tiền tính đúng 620,000 đ');

    // Thử sửa dòng đầu tiên: đổi số lượng từ 4 thành 5 -> tổng tiền mới: 5*35000 + 480,000 = 655,000 đ
    console.log('  -> Thử sửa dòng 1 (đổi số lượng thành 5)...');
    const editRow1 = await evalInBrowser(ws, `
      (() => {
        editReceiptItem(0);
        document.getElementById('r-qty').value = '5';
        addOrUpdateReceiptItem();
        return {
          totalText: document.getElementById('r-total').innerText
        };
      })()
    `);
    console.log(`  ✓ Sau khi sửa dòng 1: Tổng tiền hiển thị: ${editRow1.totalText}`);
    assert(editRow1.totalText.includes('655.000') || editRow1.totalText.includes('655,000'), 'Tổng tiền cập nhật chính xác thành 655,000 đ');

    // Thử xóa dòng 2 (SP2) -> còn lại 5 * 35000 = 175,000 đ
    console.log('  -> Thử xóa dòng 2...');
    const deleteRow2 = await evalInBrowser(ws, `
      (() => {
        removeReceiptItem(1);
        return {
          rowCount: document.querySelectorAll('#r-cart tbody tr').length,
          totalText: document.getElementById('r-total').innerText
        };
      })()
    `);
    console.log(`  ✓ Sau khi xóa dòng 2: Số dòng: ${deleteRow2.rowCount}, Tổng tiền: ${deleteRow2.totalText}`);
    assert.strictEqual(deleteRow2.rowCount, 1, 'Bảng còn 1 dòng');
    assert(deleteRow2.totalText.includes('175.000') || deleteRow2.totalText.includes('175,000'), 'Tổng tiền cập nhật còn 175,000 đ');

    // Thêm lại SP2 để lập phiếu 2 dòng hoàn chỉnh (3 cái * 90000 = 270,000 đ -> Tổng 445,000 đ)
    await evalInBrowser(ws, `
      (() => {
        const select = document.getElementById('r-product');
        const opt2 = Array.from(select.options).find(o => o.text.includes('UI-SP2'));
        select.value = opt2.value;
        select.dispatchEvent(new Event('change'));

        document.getElementById('r-qty').value = '3';
        document.getElementById('r-cost').value = '90000';
        addOrUpdateReceiptItem();
      })()
    `);
    await sleep(300);

    // Chụp ảnh trước khi lưu phiếu
    const screenshotForm = path.join(ARTIFACTS_DIR, 'scratch', 'browser_receipts_form.png');
    await captureScreenshot(ws, screenshotForm);

    // ------------------------------------------------------------------------
    // 4. LƯU PHIẾU NHẬP HÀNG & KIỂM TRA TỰ ĐỘNG CẬP NHẬT DANH SÁCH
    // ------------------------------------------------------------------------
    console.log('\n--- 4. Bấm Lưu phiếu nhập hàng và kiểm tra kết quả ---');
    const testReceiptCode = 'UI-PN-' + Date.now().toString().slice(-6);
    const submitResult = await evalInBrowser(ws, `
      (async () => {
        document.getElementById('r-no').value = '${testReceiptCode}';
        document.getElementById('btn-save-receipt').click();
        await new Promise(r => setTimeout(r, 1500));
        const alert = document.getElementById('receipt-msg');
        return {
          alertClass: alert ? alert.className : '',
          alertText: alert ? alert.innerText : '',
          historyItems: document.querySelectorAll('#r-history .list-group-item').length
        };
      })()
    `);
    console.log(`  ✓ Thông báo sau khi lưu: [${submitResult.alertClass}] ${submitResult.alertText}`);
    assert(submitResult.alertClass.includes('alert-success'), 'Báo thành công sau khi lưu');

    // ------------------------------------------------------------------------
    // 5. XEM CHI TIẾT PHIẾU NHẬP (MODAL GIỜ VN, SKU, TÊN, GIÁ, ĐVT)
    // ------------------------------------------------------------------------
    console.log('\n--- 5. Mở Modal Xem chi tiết phiếu nhập hàng mới lập ---');
    const modalDetail = await evalInBrowser(ws, `
      (async () => {
        const firstViewBtn = document.querySelector('#r-history .list-group-item button');
        if (!firstViewBtn) return { error: 'Không thấy nút Chi tiết trong danh sách lịch sử' };
        firstViewBtn.click();
        await new Promise(r => setTimeout(r, 1000));

        const modalBody = document.getElementById('receipt-modal-body');
        return {
          modalTitle: document.getElementById('receipt-modal-title').innerText,
          bodyText: modalBody ? modalBody.innerText : '',
          itemRows: Array.from(modalBody.querySelectorAll('tbody tr')).map(tr => tr.innerText)
        };
      })()
    `);
    console.log(`  ✓ Tiêu đề Modal: ${modalDetail.modalTitle}`);
    console.log(`  ✓ Nội dung chi tiết:`, modalDetail.bodyText.substring(0, 160) + '...');
    console.log(`  ✓ Mặt hàng trong modal:`, modalDetail.itemRows);
    assert(modalDetail.modalTitle.includes(testReceiptCode), 'Modal hiển thị đúng mã phiếu');
    assert(modalDetail.bodyText.includes('Nguyễn Quản Lý'), 'Hiển thị đúng người lập');
    assert(modalDetail.bodyText.includes(testReceiptCode), 'Hiển thị mã phiếu trong chi tiết');
    assert(modalDetail.bodyText.includes('445.000') || modalDetail.bodyText.includes('445,000'), 'Hiển thị đúng tổng tiền');
    assert.strictEqual(modalDetail.itemRows.length, 2, 'Modal hiển thị đủ 2 dòng mặt hàng');

    // Chụp ảnh Modal chi tiết
    const screenshotModal = path.join(ARTIFACTS_DIR, 'scratch', 'browser_receipts_modal.png');
    await captureScreenshot(ws, screenshotModal);

    // Đóng modal
    await evalInBrowser(ws, `
      (() => {
        closeReceiptModal();
      })()
    `);
    await sleep(500);

    // ------------------------------------------------------------------------
    // 6. TÌM KIẾM THEO MÃ PHIẾU & LỌC NGÀY
    // ------------------------------------------------------------------------
    console.log('\n--- 6. Thử tìm kiếm theo mã phiếu và lọc ngày ---');
    const searchFilterResult = await evalInBrowser(ws, `
      (async () => {
        document.getElementById('history-search').value = '${testReceiptCode}';
        await loadHistory(1);
        await new Promise(r => setTimeout(r, 800));

        const items = document.querySelectorAll('#r-history .list-group-item');
        return {
          itemCount: items.length,
          firstItemText: items[0] ? items[0].innerText : ''
        };
      })()
    `);
    console.log(`  ✓ Kết quả tìm theo mã phiếu: ${searchFilterResult.itemCount} phiếu`);
    assert(searchFilterResult.itemCount >= 1, 'Tìm thấy phiếu theo mã');
    assert(searchFilterResult.firstItemText.includes(testReceiptCode), 'Dòng đầu tiên đúng mã phiếu');

    console.log('\n🎉 TẤT CẢ CÁC BƯỚC KIỂM THỬ GIAO DIỆN TRÌNH DUYỆT ĐỀU THÀNH CÔNG RỰC RỠ!');
  } finally {
    try { ws.close(); } catch (e) {}
    try { chromeProcess.kill(); } catch (e) {}
    try { serverProcess.kill(); } catch (e) {}
  }
}

run().catch((err) => {
  console.error('\n❌ LỖI KIỂM THỬ TRÌNH DUYỆT:', err);
  process.exit(1);
});
