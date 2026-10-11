require('dotenv').config();
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'http://127.0.0.1:3000';
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ARTIFACT_DIR = 'C:\\Users\\Dell Precision 5550\\.gemini\\antigravity-ide\\brain\\246ce1ac-f161-4dc9-98e7-8d7ff9081ef7';
const USER_DATA_DIR = path.join(ARTIFACT_DIR, 'scratch', 'chrome_invoice_filter_profile');

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
  console.log('=== BẮT ĐẦU KIỂM THỬ BỘ LỌC KHOẢNG NGÀY HÓA ĐƠN ===\n');

  // ---------------------------------------------------------
  // PHẦN 1: KIỂM THỬ BACKEND API
  // ---------------------------------------------------------
  console.log('--- PHẦN 1: KIỂM THỬ BACKEND API ---');

  // 1. Đăng nhập Manager & Cashier
  const cMgr = await req('GET', '/api/auth/csrf');
  const lMgr = await req('POST', '/api/auth/login', { username: 'manager', password: 'VeryStrongPass123!@#' }, cMgr.cookie, cMgr.data.csrfToken);
  assert.strictEqual(lMgr.status, 200, 'Manager đăng nhập thành công');
  const mgrCookie = lMgr.cookie;

  const cCsh = await req('GET', '/api/auth/csrf');
  const lCsh = await req('POST', '/api/auth/login', { username: 'thungan_test01', password: 'CashierPass123!@#' }, cCsh.cookie, cCsh.data.csrfToken);
  assert.strictEqual(lCsh.status, 200, 'Cashier đăng nhập thành công');
  const cshCookie = lCsh.cookie;

  console.log('✓ Đăng nhập thành công cả Quản lý và Thu ngân.');

  // 2. Kiểm tra khoảng ngày ngược trên backend (Manager)
  console.log('\n2. Kiểm tra backend chặn ngày nhập ngược (from_date > to_date):');
  const revMgr = await req('GET', '/api/invoices?from_date=2026-10-12&to_date=2026-10-11', null, mgrCookie);
  assert.strictEqual(revMgr.status, 400, 'Backend phải trả về HTTP 400 khi từ ngày > đến ngày');
  assert.strictEqual(revMgr.data.error, 'Từ ngày không được lớn hơn Đến ngày.', 'Thông báo lỗi phải chính xác');
  console.log('✓ Quản lý gọi API ngày ngược: HTTP 400, thông báo "Từ ngày không được lớn hơn Đến ngày."');

  // 3. Kiểm tra khoảng ngày ngược trên backend (Cashier)
  const revCsh = await req('GET', '/api/invoices?from_date=2026-10-12&to_date=2026-10-11', null, cshCookie);
  assert.strictEqual(revCsh.status, 400, 'Backend phải trả về HTTP 400 cho Thu ngân khi từ ngày > đến ngày');
  assert.strictEqual(revCsh.data.error, 'Từ ngày không được lớn hơn Đến ngày.');
  console.log('✓ Thu ngân gọi API ngày ngược: HTTP 400, thông báo "Từ ngày không được lớn hơn Đến ngày."');

  // 4. Kiểm tra định dạng ngày không hợp lệ
  const invDateRes = await req('GET', '/api/invoices?from_date=invalid-date&to_date=2026-10-11', null, mgrCookie);
  assert.strictEqual(invDateRes.status, 400, 'Định dạng ngày sai phải trả 400');
  console.log('✓ Ngày không đúng định dạng bị từ chối với HTTP 400.');

  // 5. Kiểm tra lọc cùng một ngày (from_date == to_date)
  const sameDayRes = await req('GET', '/api/invoices?from_date=2026-10-11&to_date=2026-10-11', null, mgrCookie);
  assert.strictEqual(sameDayRes.status, 200, 'Lọc cùng một ngày phải trả về HTTP 200');
  assert.ok(sameDayRes.data.invoices !== undefined || Array.isArray(sameDayRes.data), 'Dữ liệu hóa đơn hợp lệ');
  console.log('✓ Lọc cùng một ngày (11/10/2026 - 11/10/2026) trả về HTTP 200 thành công.');

  // 6. Kiểm tra chỉ nhập từ ngày (to_date bỏ trống)
  const fromOnlyRes = await req('GET', '/api/invoices?from_date=2026-10-11', null, mgrCookie);
  assert.strictEqual(fromOnlyRes.status, 200, 'Chỉ nhập Từ ngày phải trả về HTTP 200');
  console.log('✓ Chỉ nhập Từ ngày (Đến ngày bỏ trống): HTTP 200 thành công.');

  // 7. Kiểm tra chỉ nhập đến ngày (from_date bỏ trống)
  const toOnlyRes = await req('GET', '/api/invoices?to_date=2026-10-11', null, mgrCookie);
  assert.strictEqual(toOnlyRes.status, 200, 'Chỉ nhập Đến ngày phải trả về HTTP 200');
  console.log('✓ Chỉ nhập Đến ngày (Từ ngày bỏ trống): HTTP 200 thành công.');

  // 8. Kiểm tra cả hai ô ngày bỏ trống
  const noDateRes = await req('GET', '/api/invoices', null, mgrCookie);
  assert.strictEqual(noDateRes.status, 200, 'Cả hai ô ngày bỏ trống phải trả về HTTP 200');
  console.log('✓ Cả hai ô ngày bỏ trống: HTTP 200 thành công.');

  // 9. Kiểm tra phân quyền: Thu ngân chỉ xem hóa đơn của mình, Quản lý xem toàn bộ
  const listMgr = await req('GET', '/api/invoices?page=1&limit=50', null, mgrCookie);
  const listCsh = await req('GET', '/api/invoices?page=1&limit=50', null, cshCookie);
  assert.strictEqual(listMgr.status, 200);
  assert.strictEqual(listCsh.status, 200);
  const mgrInvs = listMgr.data.invoices || listMgr.data;
  const cshInvs = listCsh.data.invoices || listCsh.data;
  console.log(`✓ Quản lý xem được tổng cộng: ${listMgr.data.total || mgrInvs.length} hóa đơn.`);
  console.log(`✓ Thu ngân xem được tổng cộng: ${listCsh.data.total || cshInvs.length} hóa đơn.`);
  // Kiểm tra mọi hóa đơn của Thu ngân phải do thungan_test01 tạo
  cshInvs.forEach(inv => {
    assert.strictEqual(inv.created_by_name, 'Nhân viên kiểm thử đã sửa', 'Thu ngân chỉ thấy hóa đơn của chính mình');
  });
  console.log('✓ Phân quyền chuẩn xác: Thu ngân chỉ thấy hóa đơn của mình, Quản lý thấy toàn bộ.\n');

  // ---------------------------------------------------------
  // PHẦN 2: KIỂM THỬ TRÌNH DUYỆT (FRONTEND UI VÀ TƯƠNG TÁC)
  // ---------------------------------------------------------
  console.log('--- PHẦN 2: KIỂM THỬ TRÌNH DUYỆT (FRONTEND UI) ---');

  if (!fs.existsSync(USER_DATA_DIR)) {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  }

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

    ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', reject);
    });

    await sendCdp(ws, 'Page.enable');
    await sendCdp(ws, 'Runtime.enable');
    await sendCdp(ws, 'Network.enable');

    // 1. Đăng nhập với tài khoản Quản lý
    console.log('1. Đăng nhập Quản lý trên trình duyệt...');
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/login` });
    await sleep(800);

    await evalInBrowser(ws, `
      (async () => {
        const token = await fetchCsrfToken();
        await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
          body: JSON.stringify({ username: 'manager', password: 'VeryStrongPass123!@#' })
        });
      })()
    `);
    await sleep(500);

    // 2. Vào trang Quản lý hóa đơn
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/invoices` });
    await sleep(1200);

    // Lấy số dòng ban đầu trong bảng
    const initialRowsCount = await evalInBrowser(ws, `document.querySelectorAll('#invoices-table tbody tr').length`);
    const initialFirstRowText = await evalInBrowser(ws, `document.querySelector('#invoices-table tbody tr td:nth-child(2)')?.textContent?.trim()`);
    console.log(`  ✓ Số dòng hóa đơn ban đầu: ${initialRowsCount}, hóa đơn đầu: ${initialFirstRowText}`);
    assert.ok(initialRowsCount > 0, 'Bảng phải có dữ liệu hóa đơn ban đầu');

    // 3. Nhập khoảng ngày ngược: Từ ngày 12/10/2026, Đến ngày 11/10/2026 rồi bấm Lọc
    console.log('\n2. Nhập Từ ngày 12/10/2026, Đến ngày 11/10/2026 và bấm "Lọc"...');
    await evalInBrowser(ws, `
      document.getElementById('filter-from-date').value = '2026-10-12';
      document.getElementById('filter-to-date').value = '2026-10-11';
      document.getElementById('btn-apply-filter').click();
    `);
    await sleep(500);

    // Kiểm tra thông báo lỗi hiển thị rõ
    const errorAlertInfo = await evalInBrowser(ws, `({
      display: document.getElementById('filter-error-alert')?.style.display,
      text: document.getElementById('filter-error-text')?.textContent?.trim()
    })`);
    console.log('  ✓ Trạng thái thông báo lỗi:', errorAlertInfo);
    assert.ok(errorAlertInfo.display !== 'none', 'Thông báo lỗi phải đang hiển thị');
    assert.strictEqual(errorAlertInfo.text, 'Từ ngày không được lớn hơn Đến ngày.', 'Nội dung thông báo lỗi phải đúng yêu cầu');

    // Kiểm tra giữ nguyên giá trị người dùng đã nhập
    const currentInputValues = await evalInBrowser(ws, `({
      fromDate: document.getElementById('filter-from-date').value,
      toDate: document.getElementById('filter-to-date').value
    })`);
    console.log('  ✓ Giá trị ô nhập giữ nguyên:', currentInputValues);
    assert.strictEqual(currentInputValues.fromDate, '2026-10-12', 'Giữ nguyên Từ ngày người dùng đã nhập');
    assert.strictEqual(currentInputValues.toDate, '2026-10-11', 'Giữ nguyên Đến ngày người dùng đã nhập');

    // Kiểm tra không thay danh sách hiện tại bằng kết quả trống
    const rowsCountAfterError = await evalInBrowser(ws, `document.querySelectorAll('#invoices-table tbody tr').length`);
    const firstRowTextAfterError = await evalInBrowser(ws, `document.querySelector('#invoices-table tbody tr td:nth-child(2)')?.textContent?.trim()`);
    console.log(`  ✓ Số dòng hóa đơn sau khi bị lỗi: ${rowsCountAfterError}, hóa đơn đầu: ${firstRowTextAfterError}`);
    assert.strictEqual(rowsCountAfterError, initialRowsCount, 'Danh sách hóa đơn hiện tại phải được giữ nguyên, KHÔNG bị thay bằng kết quả trống');
    assert.strictEqual(firstRowTextAfterError, initialFirstRowText, 'Nội dung dòng đầu tiên không bị đổi');

    // Chụp ảnh bằng chứng lỗi và giữ danh sách
    const ssError = await sendCdp(ws, 'Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'scratch', 'browser_invoice_filter_error.png'), Buffer.from(ssError.data, 'base64'));
    console.log('  ✓ Đã chụp ảnh lưu vào scratch/browser_invoice_filter_error.png');

    // 4. Lọc lại với ngày hợp lệ: Từ ngày 2026-10-01, Đến ngày 2026-10-12 rồi bấm Lọc
    console.log('\n3. Lọc lại với ngày hợp lệ (Từ ngày 01/10/2026, Đến ngày 12/10/2026)...');
    await evalInBrowser(ws, `
      document.getElementById('filter-from-date').value = '2026-10-01';
      document.getElementById('filter-to-date').value = '2026-10-12';
      document.getElementById('btn-apply-filter').click();
    `);
    await sleep(800);

    // Kiểm tra thông báo lỗi đã bị xóa
    const errorAlertAfterValid = await evalInBrowser(ws, `({
      display: document.getElementById('filter-error-alert')?.style.display,
      text: document.getElementById('filter-error-text')?.textContent?.trim()
    })`);
    console.log('  ✓ Trạng thái thông báo lỗi sau khi lọc ngày hợp lệ:', errorAlertAfterValid);
    assert.strictEqual(errorAlertAfterValid.display, 'none', 'Thông báo lỗi phải bị ẩn đi khi lọc ngày hợp lệ');
    assert.strictEqual(errorAlertAfterValid.text, '', 'Nội dung lỗi đã được xóa');

    // 5. Thử lại nhập ngày ngược rồi bấm "Đặt lại"
    console.log('\n4. Nhập lại ngày ngược rồi bấm "Đặt lại"...');
    await evalInBrowser(ws, `
      document.getElementById('filter-from-date').value = '2026-10-15';
      document.getElementById('filter-to-date').value = '2026-10-10';
      document.getElementById('btn-apply-filter').click();
    `);
    await sleep(300);

    const errorAlertReappeared = await evalInBrowser(ws, `document.getElementById('filter-error-text')?.textContent?.trim()`);
    assert.strictEqual(errorAlertReappeared, 'Từ ngày không được lớn hơn Đến ngày.');

    // Bấm Đặt lại
    await evalInBrowser(ws, `document.getElementById('btn-reset-filter').click()`);
    await sleep(800);

    // Kiểm tra sau khi bấm Đặt lại: thông báo lỗi biến mất, các ô ngày được xóa trắng
    const resetState = await evalInBrowser(ws, `({
      errorDisplay: document.getElementById('filter-error-alert')?.style.display,
      errorText: document.getElementById('filter-error-text')?.textContent?.trim(),
      fromDate: document.getElementById('filter-from-date').value,
      toDate: document.getElementById('filter-to-date').value
    })`);
    console.log('  ✓ Trạng thái sau khi bấm Đặt lại:', resetState);
    assert.strictEqual(resetState.errorDisplay, 'none', 'Thông báo lỗi phải bị xóa khi bấm Đặt lại');
    assert.strictEqual(resetState.errorText, '', 'Nội dung lỗi phải rỗng');
    assert.strictEqual(resetState.fromDate, '', 'Ô Từ ngày đã được xóa');
    assert.strictEqual(resetState.toDate, '', 'Ô Đến ngày đã được xóa');

    // 6. Kiểm tra với tài khoản Thu ngân
    console.log('\n5. Kiểm tra tài khoản Thu ngân trên trình duyệt...');
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/login` });
    await sleep(800);

    await evalInBrowser(ws, `
      (async () => {
        const token = await fetchCsrfToken(true);
        await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
          body: JSON.stringify({ username: 'thungan_test01', password: 'CashierPass123!@#' })
        });
      })()
    `);
    await sleep(500);

    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/invoices` });
    await sleep(1200);

    const cashierPageTitle = await evalInBrowser(ws, `document.getElementById('invoices-page-title')?.textContent?.trim()`);
    console.log(`  ✓ Tiêu đề trang cho Thu ngân: "${cashierPageTitle}"`);
    assert.strictEqual(cashierPageTitle, 'HÓA ĐƠN CỦA TÔI');

    // Thu ngân nhập ngày ngược
    await evalInBrowser(ws, `
      document.getElementById('filter-from-date').value = '2026-10-12';
      document.getElementById('filter-to-date').value = '2026-10-11';
      document.getElementById('btn-apply-filter').click();
    `);
    await sleep(400);

    const cshErrorAlert = await evalInBrowser(ws, `({
      display: document.getElementById('filter-error-alert')?.style.display,
      text: document.getElementById('filter-error-text')?.textContent?.trim()
    })`);
    console.log('  ✓ Thu ngân lọc ngày ngược:', cshErrorAlert);
    assert.ok(cshErrorAlert.display !== 'none');
    assert.strictEqual(cshErrorAlert.text, 'Từ ngày không được lớn hơn Đến ngày.');

    // Thu ngân bấm Đặt lại
    await evalInBrowser(ws, `document.getElementById('btn-reset-filter').click()`);
    await sleep(600);
    const cshResetDisplay = await evalInBrowser(ws, `document.getElementById('filter-error-alert')?.style.display`);
    assert.strictEqual(cshResetDisplay, 'none', 'Lỗi bị xóa khi Thu ngân bấm Đặt lại');

    console.log('\n========================================================================');
    console.log('🎉 TẤT CẢ 6 YÊU CẦU CỦA BỘ LỌC KHOẢNG NGÀY HÓA ĐƠN ĐÃ VƯỢT QUA 100%!');
    console.log('========================================================================\n');

  } finally {
    if (ws) ws.close();
    chromeProcess.kill();
  }
}

run().catch((err) => {
  console.error('\n❌ LỖI TRONG QUÁ TRÌNH KIỂM THỬ:', err);
  process.exit(1);
});
