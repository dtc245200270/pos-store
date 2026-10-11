require('dotenv').config();
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const BASE_URL = 'http://localhost:3000';
const ARTIFACTS_DIR = 'C:\\Users\\Dell Precision 5550\\.gemini\\antigravity-ide\\brain\\246ce1ac-f161-4dc9-98e7-8d7ff9081ef7';
const USER_DATA_DIR = path.join(ARTIFACTS_DIR, 'scratch', 'chrome_btn_fix_profile');

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

async function runStaticChecks() {
  console.log('=== 1. KIỂM TRA MÃ NGUỒN (STATIC CHECKS) ===');

  // Check views/products.html
  const productsHtml = fs.readFileSync(path.join(__dirname, '..', 'views', 'products.html'), 'utf8');
  assert(productsHtml.includes('id="btn-add-product"'), 'Thiếu nút #btn-add-product');
  assert(!productsHtml.includes('+ Thêm Sản Phẩm Mới'), 'views/products.html vẫn còn chứa "+ Thêm Sản Phẩm Mới"');
  assert(productsHtml.includes('<i class="bi bi-plus-lg me-1"></i> Thêm Sản Phẩm Mới'), 'views/products.html phải chứa icon bi-plus-lg và "Thêm Sản Phẩm Mới"');
  console.log('✔ views/products.html: Nút #btn-add-product chuẩn 1 icon và không có dấu + thừa trong chữ.');

  // Check views/stock-receipts.html
  const receiptsHtml = fs.readFileSync(path.join(__dirname, '..', 'views', 'stock-receipts.html'), 'utf8');
  assert(receiptsHtml.includes('id="btn-add-item"'), 'Thiếu nút #btn-add-item');
  assert(!receiptsHtml.includes('+ Thêm vào phiếu'), 'views/stock-receipts.html vẫn còn chứa "+ Thêm vào phiếu"');
  assert(receiptsHtml.includes('<i class="bi bi-plus-lg me-1"></i> Thêm vào phiếu'), 'views/stock-receipts.html phải chứa icon bi-plus-lg và "Thêm vào phiếu"');
  console.log('✔ views/stock-receipts.html: Nút #btn-add-item chuẩn 1 icon và không có dấu + thừa trong chữ.');

  // Check public/js/stock-receipts.js
  const receiptsJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'stock-receipts.js'), 'utf8');
  assert(!receiptsJs.includes('+ Thêm vào phiếu'), 'public/js/stock-receipts.js vẫn còn chứa "+ Thêm vào phiếu"');
  assert(receiptsJs.includes('btnAdd.innerHTML = \'<i class="bi bi-plus-lg me-1"></i> Thêm vào phiếu\';'), 'public/js/stock-receipts.js phải gán lại không có dấu + thừa');
  console.log('✔ public/js/stock-receipts.js: Nút #btn-add-item khi reset hiển thị đúng 1 icon và chữ.');

  // Check Giỏ nhập trống! logic
  assert(receiptsJs.includes('Giỏ nhập trống!'), 'Không tìm thấy kiểm tra Giỏ nhập trống! trong stock-receipts.js');
  console.log('✔ public/js/stock-receipts.js: Kiểm tra thông báo "Giỏ nhập trống!" được giữ nguyên đầy đủ.');
}

async function runBrowserChecks() {
  console.log('\n=== 2. KIỂM TRA TRÌNH DUYỆT (BROWSER CHECKS QUA CHROME HEADLESS) ===');

  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const debugPort = 9225;

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

    // 2.1 Đăng nhập MANAGER
    console.log('--- 2.1 Đăng nhập tài khoản Quản lý ---');
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/login` });
    await sleep(1000);

    const loginRes = await evalInBrowser(ws, `
      (async () => {
        const token = await fetchCsrfToken();
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
          body: JSON.stringify({ username: 'manager', password: 'VeryStrongPass123!@#' })
        });
        const data = await res.json();
        return { ok: res.ok, status: res.status, data };
      })()
    `);
    console.log('Kết quả đăng nhập:', loginRes);
    assert(loginRes && loginRes.ok, 'Đăng nhập Quản lý thất bại: ' + JSON.stringify(loginRes));
    await sleep(800);

    // 2.2 Kiểm tra trang Sản phẩm (/products)
    console.log('--- 2.2 Kiểm tra nút "Thêm Sản Phẩm Mới" trên trang Sản phẩm ---');
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/products` });
    await sleep(1200);

    const productBtnInfo = await evalInBrowser(ws, `
      (() => {
        const btn = document.getElementById('btn-add-product');
        if (!btn) return null;
        const icon = btn.querySelector('i');
        return {
          exists: true,
          innerText: btn.innerText.trim(),
          textContent: btn.textContent.trim(),
          hasIcon: !!icon,
          iconClasses: icon ? icon.className : '',
          iconCount: btn.querySelectorAll('i').length,
          innerHTML: btn.innerHTML.trim()
        };
      })()
    `);

    console.log('Thông tin nút Sản phẩm:', productBtnInfo);
    assert(productBtnInfo && productBtnInfo.exists, 'Không tìm thấy nút #btn-add-product');
    assert.strictEqual(productBtnInfo.iconCount, 1, 'Nút sản phẩm phải có đúng 1 icon');
    assert.strictEqual(productBtnInfo.innerText, 'Thêm Sản Phẩm Mới', `innerText phải là "Thêm Sản Phẩm Mới", nhận được: "${productBtnInfo.innerText}"`);
    assert(!productBtnInfo.textContent.includes('+ Thêm'), 'textContent không được chứa "+ Thêm"');
    console.log('✔ Trang Sản phẩm: Nút "Thêm Sản Phẩm Mới" hiển thị hoàn hảo (1 icon, không có dấu + thừa trong chữ).');

    // 2.3 Kiểm tra trang Nhập hàng (/stock-receipts)
    console.log('--- 2.3 Kiểm tra nút "Thêm vào phiếu" trên trang Nhập hàng ---');
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/stock-receipts` });
    await sleep(1200);

    const receiptBtnInfo = await evalInBrowser(ws, `
      (() => {
        const btn = document.getElementById('btn-add-item');
        if (!btn) return null;
        const icon = btn.querySelector('i');
        return {
          exists: true,
          innerText: btn.innerText.trim(),
          textContent: btn.textContent.trim(),
          hasIcon: !!icon,
          iconClasses: icon ? icon.className : '',
          iconCount: btn.querySelectorAll('i').length,
          innerHTML: btn.innerHTML.trim()
        };
      })()
    `);

    console.log('Thông tin nút Nhập hàng ban đầu:', receiptBtnInfo);
    assert(receiptBtnInfo && receiptBtnInfo.exists, 'Không tìm thấy nút #btn-add-item');
    assert.strictEqual(receiptBtnInfo.iconCount, 1, 'Nút nhập hàng phải có đúng 1 icon');
    assert.strictEqual(receiptBtnInfo.innerText, 'Thêm vào phiếu', `innerText phải là "Thêm vào phiếu", nhận được: "${receiptBtnInfo.innerText}"`);
    assert(!receiptBtnInfo.textContent.includes('+ Thêm'), 'textContent không được chứa "+ Thêm"');
    console.log('✔ Trang Nhập hàng: Nút "Thêm vào phiếu" ban đầu hiển thị đúng (1 icon, không có dấu + thừa trong chữ).');

    // 2.4 Kiểm tra kiểm tra "Giỏ nhập trống!"
    console.log('--- 2.4 Kiểm tra thông báo khi giỏ nhập trống ---');
    await evalInBrowser(ws, `
      saveReceipt();
    `);
    await sleep(500);

    const alertInfo = await evalInBrowser(ws, `
      (() => {
        const msgEl = document.getElementById('receipt-msg');
        return msgEl ? msgEl.innerHTML : '';
      })()
    `);

    console.log('Nội dung thông báo nhận được:', alertInfo);
    assert(alertInfo.includes('Giỏ nhập trống!'), 'Không xuất hiện thông báo "Giỏ nhập trống!"');
    console.log('✔ Kiểm tra "Giỏ nhập trống!" hoạt động chính xác khi chưa có sản phẩm nào trong giỏ.');

    // 2.5 Kiểm tra thao tác sửa dòng rồi bấm Hủy sửa -> nút #btn-add-item vẫn hiển thị chuẩn
    console.log('--- 2.5 Kiểm tra nút sau khi Sửa và Hủy sửa dòng sản phẩm ---');
    const resetBtnInfo = await evalInBrowser(ws, `
      (() => {
        // Giả lập thêm 1 sản phẩm vào giỏ và bắt đầu sửa
        window.stockReceiptCart = [{ product_id: 1, sku: 'TEST', name: 'Test Product', unit: 'Cái', quantity: 5, unit_cost: 10000 }];
        editReceiptItem(0);
        // Sau đó gọi cancelEditItem
        cancelEditItem();
        const btn = document.getElementById('btn-add-item');
        return {
          innerText: btn.innerText.trim(),
          textContent: btn.textContent.trim(),
          iconCount: btn.querySelectorAll('i').length,
          innerHTML: btn.innerHTML.trim()
        };
      })()
    `);

    console.log('Thông tin nút Nhập hàng sau khi Hủy sửa:', resetBtnInfo);
    assert.strictEqual(resetBtnInfo.iconCount, 1, 'Sau khi hủy sửa, nút phải có đúng 1 icon');
    assert.strictEqual(resetBtnInfo.innerText, 'Thêm vào phiếu', `innerText sau khi hủy sửa phải là "Thêm vào phiếu", nhận được: "${resetBtnInfo.innerText}"`);
    assert(!resetBtnInfo.textContent.includes('+ Thêm'), 'textContent sau khi hủy sửa không được chứa "+ Thêm"');
    console.log('✔ Trang Nhập hàng: Nút "Thêm vào phiếu" sau khi Hủy sửa vẫn chuẩn (1 icon, không có dấu + thừa trong chữ).');

    ws.close();
  } finally {
    chromeProcess.kill('SIGKILL');
  }
}

async function main() {
  try {
    await runStaticChecks();
    await runBrowserChecks();
    console.log('\n=========================================');
    console.log('🎉 TẤT CẢ KIỂM TRA ĐỀU THÀNH CÔNG VÀ CHÍNH XÁC!');
    console.log('=========================================');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ KIỂM TRA THẤT BẠI:', err);
    process.exit(1);
  }
}

main();
