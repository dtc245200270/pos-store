require('dotenv').config();
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const BASE_URL = 'http://localhost:3000';
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ARTIFACT_DIR = 'C:\\Users\\Dell Precision 5550\\.gemini\\antigravity-ide\\brain\\73031e9b-50f2-4c96-9b6a-5f67e969e504';
const USER_DATA_DIR = path.join(ARTIFACT_DIR, 'scratch', 'chrome_emp_test_profile');

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
  console.log('=== BẮT ĐẦU KIỂM THỬ GIAO DIỆN TÀI KHOẢN NHÂN VIÊN TRÊN TRÌNH DUYỆT ===\n');

  if (!fs.existsSync(USER_DATA_DIR)) {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  }

  const chromeProcess = spawn(CHROME_PATH, [
    '--headless=new',
    '--remote-debugging-port=9225',
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
        const resp = await fetch('http://127.0.0.1:9225/json');
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

    // 1. Đăng nhập Manager trên server chính port 3000
    console.log('1. Đăng nhập tài khoản Quản lý trên port 3000...');
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/login` });
    await sleep(1000);

    const mgrPass = process.env.INITIAL_MANAGER_PASSWORD || 'VeryStrongPass123!@#';
    await evalInBrowser(ws, `
      document.getElementById('username').value = 'manager';
      document.getElementById('password').value = ${JSON.stringify(mgrPass)};
      document.getElementById('login-form').dispatchEvent(new Event('submit', { cancelable: true }));
    `);
    await sleep(2000);

    // 2. Mở trang Tài khoản nhân viên (/employees)
    console.log('2. Điều hướng đến trang Tài khoản nhân viên (/employees)...');
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/employees` });
    await sleep(1500);

    // 3. Kiểm tra các thành phần giao diện
    const pageTitle = await evalInBrowser(ws, 'document.title');
    console.log(`  ✓ Tiêu đề trang: "${pageTitle}"`);
    assert.ok(pageTitle.includes('Tài Khoản Nhân Viên'));

    const searchExists = await evalInBrowser(ws, `!!document.getElementById('search-employees')`);
    assert.strictEqual(searchExists, true, 'Thanh tìm kiếm phải hiển thị');
    console.log('  ✓ Thanh tìm kiếm tài khoản hiển thị.');

    const filterExists = await evalInBrowser(ws, `!!document.getElementById('filter-status')`);
    assert.strictEqual(filterExists, true, 'Bộ lọc trạng thái phải hiển thị');
    console.log('  ✓ Hộp chọn lọc theo trạng thái hiển thị.');

    const headers = await evalInBrowser(ws, `
      Array.from(document.querySelectorAll('#employees-table thead th')).map(th => th.textContent.trim())
    `);
    console.log('  ✓ Các cột hiển thị trong bảng danh sách:', headers);
    assert.ok(headers.includes('Tên đăng nhập'));
    assert.ok(headers.includes('Họ Tên'));
    assert.ok(headers.includes('Vai Trò'));
    assert.ok(headers.includes('Trạng Thái'));

    // 4. Mở modal "+ Thêm Thu Ngân"
    console.log('3. Mở Modal Thêm Thu Ngân...');
    await evalInBrowser(ws, `showAddEmployeeModal()`);
    await sleep(500);

    const modalVisible = await evalInBrowser(ws, `
      document.getElementById('add-employee-modal').style.display === 'block'
    `);
    assert.strictEqual(modalVisible, true, 'Modal thêm thu ngân phải hiển thị');

    const formFields = await evalInBrowser(ws, `
      ({
        username: !!document.getElementById('add-e-username'),
        fullname: !!document.getElementById('add-e-fullname'),
        role: document.getElementById('add-e-role').value,
        password: !!document.getElementById('add-e-password'),
        confirmPassword: !!document.getElementById('add-e-confirm-password')
      })
    `);
    console.log('  ✓ Form thêm thu ngân có đầy đủ các trường:', formFields);
    assert.strictEqual(formFields.username, true);
    assert.strictEqual(formFields.fullname, true);
    assert.strictEqual(formFields.password, true);
    assert.strictEqual(formFields.confirmPassword, true);
    assert.strictEqual(formFields.role, 'CASHIER');

    await evalInBrowser(ws, `closeModal('add-employee-modal')`);
    await sleep(500);

    // 5. Chụp ảnh màn hình trang Tài khoản nhân viên
    const ss = await sendCdp(ws, 'Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'employees_management_screenshot.png'), Buffer.from(ss.data, 'base64'));
    console.log('  ✓ Đã chụp và lưu ảnh màn hình vào employees_management_screenshot.png');

    console.log('\n=== KIỂM THỬ TRÌNH DUYỆT TÀI KHOẢN NHÂN VIÊN THÀNH CÔNG 100%! ===');
  } finally {
    if (ws) ws.close();
    chromeProcess.kill();
  }
}

run().catch((err) => {
  console.error('\n❌ LỖI KIỂM THỬ TRÌNH DUYỆT:', err);
  process.exit(1);
});
