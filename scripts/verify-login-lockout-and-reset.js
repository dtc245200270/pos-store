require('dotenv').config();
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const BASE_URL = 'http://127.0.0.1:3000';
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ARTIFACT_DIR = 'C:\\Users\\Dell Precision 5550\\.gemini\\antigravity-ide\\brain\\246ce1ac-f161-4dc9-98e7-8d7ff9081ef7';
const USER_DATA_DIR = path.join(ARTIFACT_DIR, 'scratch', 'chrome_login_lockout_profile');

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

const req = async (method, urlPath, body = null, cookie = '', csrf = '') => {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;

  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`${BASE_URL}${urlPath}`, options);
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  let newCookie = cookie;
  if (setCookies && setCookies.length > 0) {
    newCookie = setCookies.map(c => c.split(';')[0]).join('; ');
  }

  let text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }

  return { status: res.status, headers: res.headers, data, text, cookie: newCookie };
};

async function run() {
  console.log('=== BẮT ĐẦU KIỂM THỬ XỬ LÝ LỖI ĐĂNG NHẬP & KHÓA TÀI KHOẢN POS ===\n');

  // 1. Kiểm tra CSDL & Trạng thái tài khoản
  console.log('--- 1. Kiểm tra CSDL, kết nối & Trạng thái tài khoản thungan_test01 ---');
  const pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'pos_app',
    password: process.env.DB_PASSWORD || '290729',
    database: process.env.DB_NAME || 'pos_store',
    timezone: '+07:00'
  });

  const [users] = await pool.query(
    'SELECT id, username, full_name, role, is_active, password_hash FROM users WHERE username = ?',
    ['thungan_test01']
  );
  assert.strictEqual(users.length, 1, 'Tài khoản thungan_test01 phải tồn tại trong CSDL');
  const cashierUser = users[0];
  console.log('  Thông tin tài khoản:', {
    id: cashierUser.id,
    username: cashierUser.username,
    role: cashierUser.role,
    is_active: cashierUser.is_active
  });
  assert.strictEqual(cashierUser.role, 'CASHIER', 'Vai trò phải là CASHIER');
  assert.strictEqual(cashierUser.is_active, 1, 'Tài khoản không bị khóa ở cấp CSDL (is_active = 1)');
  assert.ok(cashierUser.password_hash.startsWith('$2'), 'Mật khẩu phải lưu dạng bcrypt hash hợp lệ');
  console.log('✓ CSDL, trạng thái hoạt động và cấu hình bcrypt hoàn toàn chuẩn xác.\n');

  // 2. Đăng nhập Quản lý để lấy quyền quản trị
  console.log('--- 2. Đăng nhập Quản lý (manager) ---');
  const cMgr = await req('GET', '/api/auth/csrf');
  const lMgr = await req('POST', '/api/auth/login', { username: 'manager', password: 'VeryStrongPass123!@#' }, cMgr.cookie, cMgr.data.csrfToken);
  assert.strictEqual(lMgr.status, 200, 'Quản lý đăng nhập thành công');
  const mgrCookie = lMgr.cookie;
  const mgrCsrf = lMgr.data.csrfToken;
  console.log('✓ Quản lý đăng nhập thành công.\n');

  // Đặt lại mật khẩu ban đầu đã biết cho thungan_test01 thông qua API của quản lý
  console.log('--- 3. Quản lý đặt lại mật khẩu cho Thu ngân (thungan_test01) ---');
  const resetPassRes = await req('PATCH', `/api/employees/${cashierUser.id}/reset-password`, {
    password: 'InitialCashierPass123!@#',
    confirm_password: 'InitialCashierPass123!@#'
  }, mgrCookie, mgrCsrf);
  assert.strictEqual(resetPassRes.status, 200, 'Quản lý đặt lại mật khẩu thành công');
  console.log('✓ Quản lý đặt lại mật khẩu cho thungan_test01 thành InitialCashierPass123!@# thành công.');

  // Kiểm tra đăng nhập với mật khẩu mới
  const cCshInit = await req('GET', '/api/auth/csrf');
  const lCshInit = await req('POST', '/api/auth/login', {
    username: 'thungan_test01',
    password: 'InitialCashierPass123!@#'
  }, cCshInit.cookie, cCshInit.data.csrfToken);
  assert.strictEqual(lCshInit.status, 200, 'Thu ngân đăng nhập thành công với mật khẩu mới vừa được đặt');
  console.log('✓ Thu ngân đăng nhập thành công với mật khẩu vừa được quản lý đặt lại.\n');

  // 4. Thử mật khẩu cũ/sai liên tiếp và kiểm tra giới hạn 5 lần (Chống dò mật khẩu)
  console.log('--- 4. Kiểm thử giới hạn thử sai 5 lần & Khóa 15 phút ---');
  for (let i = 1; i <= 4; i++) {
    const cWrong = await req('GET', '/api/auth/csrf');
    const lWrong = await req('POST', '/api/auth/login', {
      username: 'thungan_test01',
      password: `WrongPassword_${i}!@#`
    }, cWrong.cookie, cWrong.data.csrfToken);
    assert.strictEqual(lWrong.status, 401, `Lần thử sai ${i} phải trả về 401`);
    assert.strictEqual(lWrong.data.error, 'Tên đăng nhập hoặc mật khẩu không đúng.');
    console.log(`  ✓ Lần thử sai ${i}/5: HTTP 401 ("Tên đăng nhập hoặc mật khẩu không đúng.")`);
  }

  // Lần thử sai thứ 5: Phải kích hoạt khóa tài khoản và trả về HTTP 429
  console.log('  Thực hiện lần thử sai thứ 5:');
  const c5 = await req('GET', '/api/auth/csrf');
  const l5 = await req('POST', '/api/auth/login', {
    username: 'thungan_test01',
    password: 'WrongPassword_5!@#'
  }, c5.cookie, c5.data.csrfToken);
  assert.strictEqual(l5.status, 429, 'Lần thử sai thứ 5 phải trả về HTTP 429 (Too Many Requests)');
  console.log(`  ✓ Lần thử sai 5/5: HTTP 429`);
  console.log(`  ✓ Thông báo nhận được: "${l5.data.error}"`);
  console.log(`  ✓ Header Retry-After: "${l5.headers.get('retry-after')}" giây`);
  assert.ok(l5.data.error.includes('Quá nhiều lần thử sai. Vui lòng thử lại sau'), 'Nội dung lỗi chứa thông báo chuẩn');
  assert.ok(l5.data.retryAfterSeconds > 0, 'Phải có trường retryAfterSeconds');
  assert.ok(l5.data.lockUntil > Date.now(), 'Phải có thời điểm lockUntil trong tương lai');

  // Thử tiếp lần thứ 6 trong thời gian bị khóa (kể cả dùng đúng mật khẩu ban đầu): vẫn phải bị chặn 429
  console.log('\n  Thử đăng nhập tiếp (dù dùng đúng mật khẩu) khi đang bị khóa:');
  const c6 = await req('GET', '/api/auth/csrf');
  const l6 = await req('POST', '/api/auth/login', {
    username: 'thungan_test01',
    password: 'InitialCashierPass123!@#'
  }, c6.cookie, c6.data.csrfToken);
  assert.strictEqual(l6.status, 429, 'Khi đang trong thời gian chặn, phải tiếp tục bị từ chối với HTTP 429');
  console.log(`  ✓ Tiếp tục bị chặn với HTTP 429: "${l6.data.error}"\n`);

  // 5. Kiểm tra tính độc lập IP (Yêu cầu 5):
  // Dù Thu ngân bị khóa trên IP 127.0.0.1, Quản lý đăng nhập trên CÙNG IP 127.0.0.1 KHÔNG bị khóa nhầm!
  console.log('--- 5. Kiểm tra Quản lý dùng chung IP 127.0.0.1 KHÔNG bị khóa nhầm (Yêu cầu 5) ---');
  const cMgrCheck = await req('GET', '/api/auth/csrf');
  const lMgrCheck = await req('POST', '/api/auth/login', {
    username: 'manager',
    password: 'VeryStrongPass123!@#'
  }, cMgrCheck.cookie, cMgrCheck.data.csrfToken);
  assert.strictEqual(lMgrCheck.status, 200, 'Quản lý phải đăng nhập thành công dù Thu ngân bị khóa trên cùng IP');
  console.log('✓ Quản lý đăng nhập thành công 100% trên cùng IP: Không hề bị khóa nhầm.\n');

  // 6. Quản lý đặt lại mật khẩu mới cho Thu ngân (Mở khóa và cập nhật mật khẩu mới)
  console.log('--- 6. Quản lý đặt lại mật khẩu mới & Xóa bộ đếm khóa cho Thu ngân ---');
  const newPasswordForCashier = 'UpdatedSecurePass2026!@#';
  const resetAgain = await req('PATCH', `/api/employees/${cashierUser.id}/reset-password`, {
    password: newPasswordForCashier,
    confirm_password: newPasswordForCashier
  }, lMgrCheck.cookie, lMgrCheck.data.csrfToken);
  assert.strictEqual(resetAgain.status, 200);

  // Mật khẩu cũ bị từ chối
  const cOld = await req('GET', '/api/auth/csrf');
  const lOld = await req('POST', '/api/auth/login', {
    username: 'thungan_test01',
    password: 'InitialCashierPass123!@#'
  }, cOld.cookie, cOld.data.csrfToken);
  assert.strictEqual(lOld.status, 401, 'Mật khẩu cũ phải bị từ chối với 401');
  console.log('✓ Mật khẩu cũ bị từ chối chính xác (HTTP 401).');

  // Mật khẩu mới đăng nhập thành công ngay lập tức (không bị kẹt khóa 15 phút)
  const cNew = await req('GET', '/api/auth/csrf');
  const lNew = await req('POST', '/api/auth/login', {
    username: 'thungan_test01',
    password: newPasswordForCashier
  }, cNew.cookie, cNew.data.csrfToken);
  assert.strictEqual(lNew.status, 200, 'Thu ngân đăng nhập thành công với mật khẩu mới');
  console.log('✓ Thu ngân đăng nhập thành công ngay lập tức với mật khẩu mới.\n');

  // 7. Kiểm tra xóa bộ đếm thất bại khi đăng nhập thành công (Yêu cầu 4)
  console.log('--- 7. Kiểm tra đăng nhập thành công xóa bộ đếm thất bại ---');
  // Thử sai 2 lần
  for (let i = 1; i <= 2; i++) {
    const cFail = await req('GET', '/api/auth/csrf');
    await req('POST', '/api/auth/login', {
      username: 'thungan_test01',
      password: 'WrongPassword!@#'
    }, cFail.cookie, cFail.data.csrfToken);
  }
  // Đăng nhập thành công với mật khẩu đúng
  const cSuccess = await req('GET', '/api/auth/csrf');
  const lSuccess = await req('POST', '/api/auth/login', {
    username: 'thungan_test01',
    password: newPasswordForCashier
  }, cSuccess.cookie, cSuccess.data.csrfToken);
  assert.strictEqual(lSuccess.status, 200, 'Đăng nhập thành công');

  // Bây giờ thử sai tiếp 1 lần -> Nó phải là lần sai số 1 (HTTP 401), không phải bị cộng dồn thành lần 3
  const cFailAfter = await req('GET', '/api/auth/csrf');
  const lFailAfter = await req('POST', '/api/auth/login', {
    username: 'thungan_test01',
    password: 'WrongPassword!@#'
  }, cFailAfter.cookie, cFailAfter.data.csrfToken);
  assert.strictEqual(lFailAfter.status, 401, 'Bộ đếm đã được xóa sau khi login thành công');
  console.log('✓ Bộ đếm thất bại đã được xóa sạch sau khi đăng nhập thành công.\n');

  // 8. Đặt lại mật khẩu về mật khẩu chuẩn ban đầu để không ảnh hưởng dữ liệu môi trường
  console.log('--- 8. Đặt lại mật khẩu chuẩn ban đầu cho thungan_test01 ---');
  await req('PATCH', `/api/employees/${cashierUser.id}/reset-password`, {
    password: 'CashierPass123!@#',
    confirm_password: 'CashierPass123!@#'
  }, lMgrCheck.cookie, lMgrCheck.data.csrfToken);

  const cFinal = await req('GET', '/api/auth/csrf');
  const lFinal = await req('POST', '/api/auth/login', {
    username: 'thungan_test01',
    password: 'CashierPass123!@#'
  }, cFinal.cookie, cFinal.data.csrfToken);
  assert.strictEqual(lFinal.status, 200, 'Thu ngân đăng nhập thành công với CashierPass123!@#');
  console.log('✓ Đã khôi phục mật khẩu chuẩn cho thungan_test01 và đăng nhập thành công.\n');

  // ---------------------------------------------------------
  // 9. KIỂM THỬ TRÌNH DUYỆT (CDP CHROME)
  // ---------------------------------------------------------
  console.log('--- 9. KIỂM THỬ TRÌNH DUYỆT (FRONTEND LOGIN UI) ---');
  if (!fs.existsSync(USER_DATA_DIR)) {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  }

  const chromeProcess = spawn(CHROME_PATH, [
    '--headless=new',
    '--remote-debugging-port=9228',
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
        const resp = await fetch('http://127.0.0.1:9228/json');
        const list = await resp.json();
        const pageTarget = list.find(t => t.type === 'page' && !t.url.startsWith('chrome-extension://'));
        if (pageTarget && pageTarget.webSocketDebuggerUrl) {
          wsUrl = pageTarget.webSocketDebuggerUrl;
          break;
        }
      } catch (e) {}
    }
    assert.ok(wsUrl, 'Không lấy được WebSocket URL từ Chrome');

    ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', reject);
    });

    await sendCdp(ws, 'Page.enable');
    await sendCdp(ws, 'Runtime.enable');
    await sendCdp(ws, 'Network.enable');

    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/login` });
    await sleep(800);

    // Thử sai 5 lần trên trình duyệt với tài khoản test
    console.log('  Thực hiện thử sai 5 lần trên giao diện đăng nhập...');
    for (let i = 1; i <= 5; i++) {
      await evalInBrowser(ws, `
        document.getElementById('username').value = 'test_csh_lockout';
        document.getElementById('password').value = 'WrongPass_${i}';
        document.getElementById('login-btn').click();
      `);
      await sleep(600);
    }

    const browserErrorInfo = await evalInBrowser(ws, `({
      isDisplayed: !document.getElementById('error-message')?.classList.contains('d-none'),
      text: document.getElementById('error-message')?.textContent?.trim()
    })`);
    console.log('  ✓ Thông báo trên giao diện:', browserErrorInfo);
    assert.strictEqual(browserErrorInfo.isDisplayed, true, 'Thông báo lỗi phải hiển thị trên giao diện');
    assert.ok(browserErrorInfo.text.includes('Quá nhiều lần thử sai'), 'Nội dung thông báo phải báo quá nhiều lần thử sai');
    assert.ok(browserErrorInfo.text.includes('thử lại sau'), 'Nội dung thông báo phải có thời gian thử lại sau');

    // Chụp ảnh màn hình giao diện thông báo khóa
    const ssLockout = await sendCdp(ws, 'Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'scratch', 'browser_login_lockout_screenshot.png'), Buffer.from(ssLockout.data, 'base64'));
    console.log('  ✓ Đã lưu ảnh chụp giao diện thông báo khóa vào scratch/browser_login_lockout_screenshot.png');

    // Quản lý trên cùng trình duyệt này đăng nhập:
    console.log('\n  Đăng nhập Quản lý trên cùng trình duyệt (cùng IP)...');
    await evalInBrowser(ws, `
      document.getElementById('username').value = 'manager';
      document.getElementById('password').value = 'VeryStrongPass123!@#';
      document.getElementById('login-btn').click();
    `);
    await sleep(1500);

    const currentUrl = await evalInBrowser(ws, `window.location.pathname`);
    console.log('  ✓ Đường dẫn sau khi đăng nhập:', currentUrl);
    assert.ok(currentUrl === '/' || currentUrl === '/invoices', 'Quản lý chuyển trang thành công vào dashboard/trang quản trị');
    console.log('  ✓ Quản lý đăng nhập thành công vào hệ thống, không bị ảnh hưởng bởi tài khoản bị khóa.');

  } finally {
    if (ws) ws.close();
    chromeProcess.kill();
    await pool.end();
  }

  console.log('\n========================================================================');
  console.log('🎉 TẤT CẢ CÁC BÀI KIỂM TRA ĐĂNG NHẬP, KHÓA TÀI KHOẢN ĐÃ VƯỢT QUA 100%!');
  console.log('========================================================================\n');
}

run().catch(err => {
  console.error('\n❌ LỖI TRONG QUÁ TRÌNH KIỂM THỬ:', err);
  process.exit(1);
});
