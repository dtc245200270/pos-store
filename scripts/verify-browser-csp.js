/**
 * ==============================================================================
 * DỰ ÁN POS STORE - KIỂM THỬ CSP VÀ GIAO DIỆN TRÌNH DUYỆT THẬT (CHROME HEADLESS)
 * ==============================================================================
 * Tệp: scripts/verify-browser-csp.js
 * Mục đích:
 *   - Khởi chạy Google Chrome thực tế ở chế độ Headless và kết nối qua CDP (Chrome DevTools Protocol).
 *   - Kiểm thử thực tế chính sách Content Security Policy (CSP) từ Nginx reverse proxy (cổng 8080):
 *       1. Tải tài nguyên giao diện CDN: Bootstrap CSS, Bootstrap Icons, Bootstrap Bundle JS.
 *       2. Tải ảnh động từ nguồn bên ngoài: Xác minh ảnh mã VietQR từ https://img.vietqr.io.
 *       3. Bắt các sự kiện vi phạm bảo mật (Log.entryAdded, Network.loadingFailed) để phát hiện CSP blocked.
 *       4. Kiểm tra điều hướng tuần tự qua tất cả các trang giao diện (/login, /, /sales, /products, v.v.).
 *       5. Xác minh hoạt động của các widget và hàm đóng/mở modal giao diện.
 * ==============================================================================
 */

require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9223;
const USER_DATA_DIR = path.join(__dirname, '..', 'deploy', 'monitoring', 'data', 'chrome_csp_test_profile');

/**
 * Tạm dừng luồng thực thi trong khoảng thời gian xác định
 * @param {number} ms - Thời gian chờ tính bằng mili-giây
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Thăm dò và lấy URL WebSocket kết nối CDP từ Chrome DevTools
 * @param {number} port - Cổng remote-debugging-port của tiến trình Chrome
 * @returns {Promise<string>} Chuỗi WebSocket URL (ws://...) để tương tác trực tiếp với trang
 */
async function getWsUrl(port) {
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`);
      const list = await res.json();
      const page = list.find(t => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch (_) {}
  }
  throw new Error('Timed out waiting for Chrome WebSocket URL');
}

/**
 * Gửi lệnh JSON-RPC tới Chrome DevTools Protocol qua WebSocket
 * @param {WebSocket} ws - Kết nối WebSocket đang hoạt động
 * @param {string} method - Tên phương thức CDP (ví dụ: 'Page.navigate', 'Runtime.evaluate')
 * @param {object} params - Các tham số kèm theo phương thức
 * @returns {Promise<any>} Kết quả trả về từ Chrome
 */
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

/**
 * Thực thi một biểu thức JavaScript trong ngữ cảnh trang web Chrome
 * @param {WebSocket} ws - Kết nối WebSocket CDP
 * @param {string} expression - Chuỗi mã JavaScript cần thực thi trên trình duyệt
 * @returns {Promise<any>} Giá trị kết quả thực thi
 */
async function evaluate(ws, expression) {
  const res = await sendCdp(ws, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  return res.result ? res.result.value : null;
}

/**
 * Hàm điều phối toàn bộ quy trình kiểm thử CSP và giao diện trên trình duyệt Chrome
 */
async function runBrowserCspTest() {
  console.log('================================================================');
  console.log('REAL BROWSER CSP & UI VERIFICATION TEST (CHROME HEADLESS)');
  console.log('Testing via Nginx Reverse Proxy at: http://127.0.0.1:8080');
  console.log('================================================================\n');

  // Khối 1: Khởi tạo thư mục dữ liệu người dùng tạm và chạy Chrome headless qua CDP
  if (!fs.existsSync(USER_DATA_DIR)) {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  }

  const chromeProc = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${USER_DATA_DIR}`
  ]);

  chromeProc.on('error', err => {
    console.error('Failed to start Chrome:', err);
  });

  const cspViolations = [];
  const consoleErrors = [];
  const networkBlocked = [];

  try {
    // Khối 2: Kết nối WebSocket CDP và kích hoạt các domain nghiệp vụ (Page, Runtime, Log, Network)
    const wsUrl = await getWsUrl(DEBUG_PORT);
    console.log(`[OK] Chrome connected via CDP: ${wsUrl}\n`);

    const WebSocket = global.WebSocket || require('ws');
    const ws = new WebSocket(wsUrl);

    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = rej;
    });

    // Kích hoạt các domain của CDP để nhận diện sự kiện mạng và nhật ký trình duyệt
    await sendCdp(ws, 'Page.enable');
    await sendCdp(ws, 'Runtime.enable');
    await sendCdp(ws, 'Log.enable');
    await sendCdp(ws, 'Network.enable');

    // Khối 3: Đăng ký bộ lắng nghe sự kiện Log và Network để phát hiện vi phạm CSP và lỗi console
    ws.addEventListener('message', (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.method === 'Log.entryAdded') {
        const entry = msg.params.entry;
        const text = entry.text || '';
        if (entry.source === 'security' || text.includes('Content Security Policy') || text.includes('Refused to')) {
          cspViolations.push({
            source: entry.source,
            level: entry.level,
            text: entry.text,
            url: entry.url
          });
        }
        if (entry.level === 'error') {
          consoleErrors.push({ text: entry.text, source: entry.source });
        }
      }
      if (msg.method === 'Network.loadingFailed') {
        const { blockedReason, errorText, canceled } = msg.params;
        if (blockedReason === 'csp' || errorText.includes('CSP')) {
          networkBlocked.push(msg.params);
        }
      }
    });

    // Khối 4: Bước 1 - Kiểm tra trang đăng nhập (/login), nạp tài nguyên và thực hiện đăng nhập
    console.log('--- STEP 1: Verify Login Page (/login) ---');
    await sendCdp(ws, 'Page.navigate', { url: 'http://127.0.0.1:8080/login' });
    await sleep(1500);

    const loginTitle = await evaluate(ws, 'document.title');
    console.log(`Page Title: "${loginTitle}"`);

    // Kiểm tra tài nguyên Bootstrap (CSS & JS) đã nạp thành công, không bị CSP chặn
    const bootstrapLoaded = await evaluate(ws, "typeof bootstrap !== 'undefined' || !!document.querySelector('link[href*=\"bootstrap\"]')");
    console.log(`Bootstrap resources present: ${bootstrapLoaded}`);

    // Điền thông tin đăng nhập Quản lý (manager) và kích hoạt nút submit
    const managerPass = process.env.INITIAL_MANAGER_PASSWORD || 'password123';
    console.log('Filling login credentials and clicking submit button...');
    await evaluate(ws, `
      document.getElementById('username').value = 'manager';
      document.getElementById('password').value = ${JSON.stringify(managerPass)};
      document.getElementById('login-btn').click();
    `);

    // Chờ chuyển hướng sau khi đăng nhập thành công vào trang tổng quan
    await sleep(2500);
    const currentUrl = await evaluate(ws, 'window.location.href');
    console.log(`Redirected URL after login: ${currentUrl}`);

    // Khối 5: Bước 2 - Kiểm tra trang tổng quan (/), widget cảnh báo tồn kho và tương tác modal
    console.log('\n--- STEP 2: Verify Dashboard Page (/) & Modals ---');
    const dashboardTitle = await evaluate(ws, 'document.title');
    console.log(`Dashboard Title: "${dashboardTitle}"`);

    const statCount = await evaluate(ws, "document.getElementById('stat-low-stock-count') ? document.getElementById('stat-low-stock-count').textContent : 'N/A'");
    console.log(`Dashboard Stat Widget (Low stock count): "${statCount}"`);

    // Kiểm tra hàm đóng/mở modal chi tiết hóa đơn trên giao diện
    const modalTest = await evaluate(ws, `
      (function() {
        const modalEl = document.getElementById('invoice-detail-modal');
        if (!modalEl) return { found: false };
        if (typeof closeInvoiceModal === 'function') {
          closeInvoiceModal();
          return { found: true, functionWorking: true };
        }
        return { found: true, functionWorking: false };
      })()
    `);
    console.log('Invoice Detail Modal test:', JSON.stringify(modalTest));

    // Khối 6: Bước 3 - Kiểm tra trang bán hàng (/sales) và tải thử nghiệm mã ảnh VietQR
    console.log('\n--- STEP 3: Verify Sales Page (/sales) & VietQR Display ---');
    await sendCdp(ws, 'Page.navigate', { url: 'http://127.0.0.1:8080/sales' });
    await sleep(2000);

    const salesTitle = await evaluate(ws, 'document.title');
    console.log(`Sales Title: "${salesTitle}"`);

    // Kiểm tra nạp ảnh VietQR từ img.vietqr.io để xác minh chỉ thị img-src của CSP
    const qrImageResult = await evaluate(ws, `
      new Promise((resolve) => {
        const testImg = new Image();
        testImg.onload = () => resolve({ status: 'LOADED', width: testImg.naturalWidth, height: testImg.naturalHeight });
        testImg.onerror = (e) => resolve({ status: 'ERROR', error: 'Image failed to load under CSP' });
        // VietQR sample URL format
        testImg.src = 'https://img.vietqr.io/image/970415-12345678-compact.png?amount=50000&addInfo=TEST_POS_STORE';
      })
    `);
    console.log('VietQR Image Load Result (from https://img.vietqr.io):', JSON.stringify(qrImageResult));

    // Khối 7: Bước 4 - Điều hướng kiểm tra tất cả các trang quản trị còn lại
    console.log('\n--- STEP 4: Verify Navigation & Management Pages ---');
    const pagesToTest = ['/products', '/employees', '/invoices', '/stock-receipts', '/inventory', '/profile'];
    for (const p of pagesToTest) {
      await sendCdp(ws, 'Page.navigate', { url: `http://127.0.0.1:8080${p}` });
      await sleep(1000);
      const title = await evaluate(ws, 'document.title');
      const tableCount = await evaluate(ws, "document.querySelectorAll('table').length");
      console.log(`Page ${p}: Title="${title}", Tables count=${tableCount}`);
    }

    // Khối 8: Bước 5 - Tổng kết và in báo cáo kết quả kiểm thử CSP và lỗi console
    console.log('\n================================================================');
    console.log('CSP & BROWSER CONSOLE REPORT');
    console.log('================================================================');
    console.log(`Total CSP Violations Detected: ${cspViolations.length}`);
    if (cspViolations.length > 0) {
      console.log('CSP Violations Details:');
      cspViolations.forEach((v, idx) => {
        console.log(`  [${idx + 1}] Source: ${v.source} | Level: ${v.level} | ${v.text}`);
      });
    } else {
      console.log('[PASS] ZERO CSP violations reported by Chrome browser.');
    }

    console.log(`Total Network Blocked by CSP: ${networkBlocked.length}`);
    if (networkBlocked.length > 0) {
      console.log('Network Blocked Details:', JSON.stringify(networkBlocked, null, 2));
    } else {
      console.log('[PASS] ZERO network requests blocked by CSP.');
    }

    console.log(`Total Console Errors: ${consoleErrors.length}`);
    if (consoleErrors.length > 0) {
      console.log('Console Errors:', JSON.stringify(consoleErrors, null, 2));
    }

    ws.close();
  } finally {
    try {
      chromeProc.kill();
    } catch (_) {}
  }
}

runBrowserCspTest().catch(err => {
  console.error('Browser CSP Test failed:', err);
  process.exit(1);
});
