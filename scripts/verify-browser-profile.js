require('dotenv').config();
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const BASE_URL = 'http://localhost:3000';
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ARTIFACT_DIR = 'C:\\Users\\Dell Precision 5550\\.gemini\\antigravity-ide\\brain\\73031e9b-50f2-4c96-9b6a-5f67e969e504';
const USER_DATA_DIR = path.join(ARTIFACT_DIR, 'scratch', 'chrome_prof_test_profile');

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
  console.log('=== BẮT ĐẦU KIỂM THỬ TRÌNH DUYỆT TRANG TÀI KHOẢN CỦA TÔI ===\n');

  if (!fs.existsSync(USER_DATA_DIR)) {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  }

  const chromeProcess = spawn(CHROME_PATH, [
    '--headless=new',
    '--remote-debugging-port=9226',
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

    // 1. Đăng nhập Manager trên port 3000
    console.log('1. Đăng nhập tài khoản Quản lý...');
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/login` });
    await sleep(1000);

    const mgrPass = process.env.INITIAL_MANAGER_PASSWORD || 'VeryStrongPass123!@#';
    await evalInBrowser(ws, `
      document.getElementById('username').value = 'manager';
      document.getElementById('password').value = ${JSON.stringify(mgrPass)};
      document.getElementById('login-form').dispatchEvent(new Event('submit', { cancelable: true }));
    `);
    await sleep(2000);

    // 2. Mở trang /profile
    console.log('2. Điều hướng đến trang /profile...');
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/profile` });
    await sleep(1500);

    // 3. Kiểm tra các trường hiển thị thông tin
    const profileInfo = await evalInBrowser(ws, `
      ({
        username: document.getElementById('profile-username').textContent.trim(),
        fullname: document.getElementById('profile-fullname').textContent.trim(),
        role: document.getElementById('profile-role-text').textContent.trim(),
        hasCurrentPassInput: !!document.getElementById('current_password'),
        hasNewPassInput: !!document.getElementById('new_password'),
        hasConfirmPassInput: !!document.getElementById('confirm_password'),
        hasSubmitBtn: !!document.getElementById('btn-submit-change-pass')
      })
    `);
    console.log('  ✓ Thông tin tài khoản hiển thị:', profileInfo);
    assert.strictEqual(profileInfo.username, 'manager');
    assert.strictEqual(profileInfo.role, 'Quản lý');
    assert.strictEqual(profileInfo.hasCurrentPassInput, true);
    assert.strictEqual(profileInfo.hasNewPassInput, true);
    assert.strictEqual(profileInfo.hasConfirmPassInput, true);
    assert.strictEqual(profileInfo.hasSubmitBtn, true);

    // 4. Thử nhập xác nhận mật khẩu không khớp trên form
    console.log('3. Thử submit form với xác nhận mật khẩu không khớp...');
    await evalInBrowser(ws, `
      document.getElementById('current_password').value = ${JSON.stringify(mgrPass)};
      document.getElementById('new_password').value = 'NewPass123!@#';
      document.getElementById('confirm_password').value = 'MismatchPass456!@#';
      document.getElementById('change-password-form').dispatchEvent(new Event('submit', { cancelable: true }));
    `);
    await sleep(500);

    const clientErrMsg = await evalInBrowser(ws, `document.getElementById('cp-error').textContent.trim()`);
    console.log(`  ✓ Thông báo lỗi hiển thị: "${clientErrMsg}"`);
    assert.ok(clientErrMsg.includes('không khớp'));

    // 5. Chụp ảnh màn hình trang Tài khoản của tôi
    const ss = await sendCdp(ws, 'Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'profile_page_screenshot.png'), Buffer.from(ss.data, 'base64'));
    console.log('  ✓ Đã chụp và lưu ảnh màn hình vào profile_page_screenshot.png');

    console.log('\n=== KIỂM THỬ TRÌNH DUYỆT TRANG TÀI KHOẢN CỦA TÔI THÀNH CÔNG 100%! ===');
  } finally {
    if (ws) ws.close();
    chromeProcess.kill();
  }
}

run().catch((err) => {
  console.error('\n❌ LỖI KIỂM THỬ TRÌNH DUYỆT:', err);
  process.exit(1);
});
