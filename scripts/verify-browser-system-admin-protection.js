require('dotenv').config();
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const BASE_URL = 'http://127.0.0.1:8080';
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ARTIFACT_DIR = 'C:\\Users\\Dell Precision 5550\\.gemini\\antigravity-ide\\brain\\697f8daf-03c0-4e4d-b364-c3b599c89596';
const USER_DATA_DIR = path.join(ARTIFACT_DIR, 'scratch', 'chrome_emp_scoped_profile');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  console.log('=== BẮT ĐẦU KIỂM THỬ TRÌNH DUYỆT CHROME VỚI WEBSITE CỔNG 8080 ===\n');

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
        const pageTarget = list.find((t) => t.type === 'page' && !t.url.startsWith('chrome-extension://'));
        if (pageTarget && pageTarget.webSocketDebuggerUrl) {
          wsUrl = pageTarget.webSocketDebuggerUrl;
          break;
        }
      } catch (e) {}
    }
    assert.ok(wsUrl, 'Không lấy được WebSocket URL từ Chrome');
    console.log('✓ Kết nối CDP tới Chrome thành công trên cổng 9226.');

    ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', reject);
    });

    await sendCdp(ws, 'Page.enable');
    await sendCdp(ws, 'Runtime.enable');

    // 1. Đăng nhập Manager qua cổng 8080
    console.log('1. Đăng nhập tài khoản Quản lý trên cổng 8080...');
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/login` });
    await sleep(1500);

    const mgrPass = process.env.INITIAL_MANAGER_PASSWORD;
    await evalInBrowser(ws, `
      document.getElementById('username').value = 'manager';
      document.getElementById('password').value = ${JSON.stringify(mgrPass)};
      document.getElementById('login-form').dispatchEvent(new Event('submit', { cancelable: true }));
    `);
    await sleep(2000);

    // 2. Mở trang /employees
    console.log('2. Điều hướng đến trang Tài khoản nhân viên (/employees)...');
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/employees` });
    await sleep(2000);

    const pageTitle = await evalInBrowser(ws, 'document.title');
    console.log(`  ✓ Tiêu đề trang: "${pageTitle}"`);
    assert.ok(pageTitle.includes('Tài Khoản Nhân Viên'));

    // 3. Kiểm tra hàng tài khoản manager
    const managerRowData = await evalInBrowser(ws, `
      (() => {
        const rows = Array.from(document.querySelectorAll('#employees-table tbody tr'));
        for (const row of rows) {
          const cells = row.querySelectorAll('td');
          if (cells.length >= 5 && cells[0].textContent.trim() === 'manager') {
            return {
              username: cells[0].textContent.trim(),
              fullName: cells[1].textContent.trim(),
              role: cells[2].textContent.trim(),
              status: cells[3].textContent.trim(),
              actionHtml: cells[4].innerHTML.trim(),
              actionText: cells[4].textContent.trim(),
              hasEditButton: !!cells[4].querySelector('button'),
              hasDropdown: !!cells[4].querySelector('.dropdown')
            };
          }
        }
        return null;
      })()
    `);

    assert.ok(managerRowData, 'Phải tìm thấy dòng tài khoản manager trong bảng');
    console.log('\n3. Thông tin hiển thị dòng tài khoản manager:');
    console.log(`  - Username: ${managerRowData.username}`);
    console.log(`  - Full name: ${managerRowData.fullName}`);
    console.log(`  - Role: ${managerRowData.role}`);
    console.log(`  - Status: ${managerRowData.status}`);
    console.log(`  - Action Text: "${managerRowData.actionText}"`);
    console.log(`  - Có nút Sửa không: ${managerRowData.hasEditButton}`);
    console.log(`  - Có menu dropdown không: ${managerRowData.hasDropdown}`);

    assert.ok(
      managerRowData.actionText.includes('Tài khoản hệ thống — được bảo vệ'),
      'Cột thao tác phải hiển thị đúng text: Tài khoản hệ thống — được bảo vệ'
    );
    assert.strictEqual(managerRowData.hasEditButton, false, 'Dòng manager không được có nút Sửa');
    assert.strictEqual(managerRowData.hasDropdown, false, 'Dòng manager không được có dropdown Thao tác');
    console.log('  ✓ ĐÃ XÁC NHẬN: Dòng manager hiển thị text bảo vệ, không có nút sửa hay thao tác.');

    // 4. Kiểm tra hàng tài khoản thu ngân (thungan_test01)
    const cashierRowData = await evalInBrowser(ws, `
      (() => {
        const rows = Array.from(document.querySelectorAll('#employees-table tbody tr'));
        for (const row of rows) {
          const cells = row.querySelectorAll('td');
          if (cells.length >= 5 && cells[0].textContent.trim() === 'thungan_test01') {
            return {
              username: cells[0].textContent.trim(),
              actionText: cells[4].textContent.trim(),
              hasEditButton: !!cells[4].querySelector('button'),
              hasDropdown: !!cells[4].querySelector('.dropdown')
            };
          }
        }
        return null;
      })()
    `);

    if (cashierRowData) {
      console.log('\n4. Thông tin hiển thị dòng thu ngân thungan_test01:');
      console.log(`  - Username: ${cashierRowData.username}`);
      console.log(`  - Có nút Sửa: ${cashierRowData.hasEditButton}`);
      console.log(`  - Có menu dropdown: ${cashierRowData.hasDropdown}`);
      assert.strictEqual(cashierRowData.hasEditButton, true, 'Dòng thu ngân phải có nút Sửa');
      assert.strictEqual(cashierRowData.hasDropdown, true, 'Dòng thu ngân phải có dropdown Thao tác');
      console.log('  ✓ ĐÃ XÁC NHẬN: Thu ngân vẫn giữ đầy đủ nút Sửa và Thao tác.');
    }

    // 5. Thử gọi trực tiếp hàm showEditEmployeeModal(1) từ client JavaScript
    console.log('\n5. Kiểm tra cố tình gọi showEditEmployeeModal(1) từ client...');
    await evalInBrowser(ws, `
      if (typeof showEditEmployeeModal === 'function') {
        showEditEmployeeModal(1);
      }
    `);
    await sleep(500);

    const editModalState = await evalInBrowser(ws, `
      (() => {
        const modal = document.getElementById('edit-employee-modal');
        if (!modal) return { exists: false };
        const isShown = modal.classList.contains('show');
        const displayStyle = window.getComputedStyle(modal).display;
        return {
          exists: true,
          isShown,
          displayStyle
        };
      })()
    `);

    console.log(`  - Modal edit-employee-modal exists: ${editModalState.exists}`);
    console.log(`  - Modal has class 'show': ${editModalState.isShown}`);
    console.log(`  - Modal computed display: ${editModalState.displayStyle}`);
    assert.strictEqual(editModalState.isShown, false, 'Modal sửa KHÔNG ĐƯỢC có class show');
    assert.strictEqual(editModalState.displayStyle, 'none', 'Modal sửa KHÔNG ĐƯỢC hiển thị (display phải là none)');
    console.log('  ✓ ĐÃ XÁC NHẬN: Không thể mở form sửa tài khoản hệ thống!');

    // 6. Thử gọi trực tiếp hàm showResetPassModal(1) từ client JavaScript
    console.log('\n6. Kiểm tra cố tình gọi showResetPassModal(1) từ client...');
    await evalInBrowser(ws, `
      if (typeof showResetPassModal === 'function') {
        showResetPassModal(1);
      }
    `);
    await sleep(500);

    const resetModalState = await evalInBrowser(ws, `
      (() => {
        const modal = document.getElementById('reset-pass-modal');
        if (!modal) return { exists: false };
        const isShown = modal.classList.contains('show');
        const displayStyle = window.getComputedStyle(modal).display;
        return {
          exists: true,
          isShown,
          displayStyle
        };
      })()
    `);

    assert.strictEqual(resetModalState.isShown, false, 'Modal reset pass KHÔNG ĐƯỢC có class show');
    assert.strictEqual(resetModalState.displayStyle, 'none', 'Modal reset pass KHÔNG ĐƯỢC hiển thị');
    console.log('  ✓ ĐÃ XÁC NHẬN: Không thể mở modal đặt lại mật khẩu của tài khoản hệ thống!');

    // Chụp ảnh màn hình lưu vào artifact scratch
    const screenshotData = await sendCdp(ws, 'Page.captureScreenshot', { format: 'png' });
    const screenshotPath = path.join(ARTIFACT_DIR, 'scratch', 'employees_system_admin_protected.png');
    fs.writeFileSync(screenshotPath, Buffer.from(screenshotData.data, 'base64'));
    console.log(`\n✓ Đã chụp ảnh màn hình lưu tại: ${screenshotPath}`);

    console.log('\n=== KIỂM THỬ TRÌNH DUYỆT THÀNH CÔNG HOÀN TOÀN ===');
  } finally {
    if (ws) {
      try { ws.close(); } catch (e) {}
    }
    chromeProcess.kill('SIGTERM');
  }
}

run().catch((err) => {
  console.error('LỖI KIỂM THỬ TRÌNH DUYỆT:', err);
  process.exit(1);
});
