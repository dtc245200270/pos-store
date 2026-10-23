require('dotenv').config();
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const BASE_URL = 'http://localhost:3000';
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ARTIFACT_DIR = 'C:\\Users\\Dell Precision 5550\\.gemini\\antigravity-ide\\brain\\53394d0c-3429-4bb8-8846-0f23d7766d77';
const USER_DATA_DIR = path.join(ARTIFACT_DIR, 'scratch', 'chrome_emp_comp_profile');

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
  console.log('=== KIỂM THỬ TOÀN DIỆN TRANG TÀI KHOẢN NHÂN VIÊN (/employees) ===\n');

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
  const consoleErrors = [];

  try {
    let wsUrl = null;
    for (let i = 0; i < 25; i++) {
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
    console.log('✓ Đã kết nối CDP tới Chrome.');

    ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', reject);
    });

    ws.addEventListener('message', (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        const text = msg.params.args.map(a => a.value || a.description || '').join(' ');
        consoleErrors.push(text);
      }
    });

    await sendCdp(ws, 'Page.enable');
    await sendCdp(ws, 'Runtime.enable');
    await sendCdp(ws, 'Network.enable');

    // 1. Đăng nhập Manager
    console.log('1. Đăng nhập tài khoản Quản lý...');
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/login` });
    await sleep(1000);

    const mgrPass = process.env.INITIAL_MANAGER_PASSWORD || 'VeryStrongPass123!@#';
    await evalInBrowser(ws, `
      document.getElementById('username').value = 'manager';
      document.getElementById('password').value = ${JSON.stringify(mgrPass)};
      document.getElementById('login-form').dispatchEvent(new Event('submit', { cancelable: true }));
    `);
    await sleep(1800);

    // 2. Mở /employees
    console.log('2. Điều hướng vào /employees...');
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/employees` });
    await sleep(1500);

    const title = await evalInBrowser(ws, 'document.title');
    assert.ok(title.includes('Tài Khoản Nhân Viên'), 'Tiêu đề trang không đúng');
    console.log(`  ✓ Tiêu đề trang: "${title}"`);

    // Kiểm tra cấu trúc bảng và dữ liệu nhân viên
    const rowCount = await evalInBrowser(ws, 'document.querySelectorAll("#employees-table tbody tr").length');
    console.log(`  ✓ Bảng hiển thị ${rowCount} dòng tài khoản.`);
    assert.ok(rowCount > 0, 'Phải có ít nhất 1 dòng tài khoản');

    // 3. KIỂM TRA 1: Thêm tài khoản modal
    console.log('\n3. Kiểm tra Modal Thêm Tài Khoản:');
    // Mở modal
    await evalInBrowser(ws, `showAddEmployeeModal()`);
    await sleep(400);

    let modalAddState = await evalInBrowser(ws, `({
      isShown: document.getElementById('add-employee-modal').classList.contains('show'),
      display: document.getElementById('add-employee-modal').style.display,
      backdropCount: document.querySelectorAll('.modal-backdrop').length,
      bodyHasModalOpen: document.body.classList.contains('modal-open'),
      dialogHasScrollable: document.querySelector('#add-employee-modal .modal-dialog').classList.contains('modal-dialog-scrollable'),
      dialogHasCentered: document.querySelector('#add-employee-modal .modal-dialog').classList.contains('modal-dialog-centered')
    })`);
    console.log('  ✓ Trạng thái mở modal Thêm:', modalAddState);
    assert.strictEqual(modalAddState.isShown, true, 'Modal phải có class .show');
    assert.strictEqual(modalAddState.display, 'block', 'Modal style.display phải là block');
    assert.strictEqual(modalAddState.backdropCount, 1, 'Phải có đúng 1 backdrop');
    assert.strictEqual(modalAddState.bodyHasModalOpen, true, 'Body phải có class modal-open');
    assert.strictEqual(modalAddState.dialogHasScrollable, true, 'Modal phải có modal-dialog-scrollable');
    assert.strictEqual(modalAddState.dialogHasCentered, true, 'Modal phải có modal-dialog-centered');

    // Kiểm tra validation khi submit rỗng
    await evalInBrowser(ws, `submitAddEmployee()`);
    await sleep(200);
    const addErr = await evalInBrowser(ws, `document.getElementById('add-e-error').textContent`);
    assert.ok(addErr.includes('Vui lòng điền đầy đủ'), `Thông báo lỗi không đúng: "${addErr}"`);
    console.log(`  ✓ Kiểm tra validation submit rỗng hiển thị lỗi: "${addErr}"`);

    // Bấm nút Hủy
    await evalInBrowser(ws, `closeModal('add-employee-modal')`);
    await sleep(400);

    let closedAddState = await evalInBrowser(ws, `({
      isShown: document.getElementById('add-employee-modal').classList.contains('show'),
      backdropCount: document.querySelectorAll('.modal-backdrop').length,
      bodyHasModalOpen: document.body.classList.contains('modal-open')
    })`);
    console.log('  ✓ Trạng thái sau khi Hủy modal Thêm:', closedAddState);
    assert.strictEqual(closedAddState.isShown, false, 'Modal phải ẩn đi');
    assert.strictEqual(closedAddState.backdropCount, 0, 'Backdrop phải biến mất hoàn toàn');
    assert.strictEqual(closedAddState.bodyHasModalOpen, false, 'Body không còn class modal-open');

    // Mở lại modal Thêm để đảm bảo không bị che trang và lỗi cũ đã được xóa
    await evalInBrowser(ws, `showAddEmployeeModal()`);
    await sleep(400);
    const addErrCleared = await evalInBrowser(ws, `document.getElementById('add-e-error').textContent`);
    assert.strictEqual(addErrCleared, '', 'Lỗi cũ phải được xóa khi mở lại modal');
    console.log('  ✓ Mở lại modal Thêm thành công, lỗi cũ đã được xóa sạch.');

    await evalInBrowser(ws, `closeModal('add-employee-modal')`);
    await sleep(400);

    const bCountBefore = await evalInBrowser(ws, `document.querySelectorAll('.modal-backdrop').length`);
    assert.strictEqual(bCountBefore, 0, 'Không còn backdrop trước khi mở modal Sửa');

    // 4. KIỂM TRA 2: Sửa thông tin nhân viên modal
    console.log('\n4. Kiểm tra Modal Sửa Thông Tin Nhân Viên:');
    const firstEmp = await evalInBrowser(ws, `allEmployees[0]`);
    console.log(`  ✓ Kiểm tra tài khoản đầu tiên: ${firstEmp.username} (${firstEmp.full_name})`);

    await evalInBrowser(ws, `showEditEmployeeModal(${firstEmp.id})`);
    await sleep(400);

    const editFields = await evalInBrowser(ws, `({
      id: document.getElementById('edit-e-id').value,
      username: document.getElementById('edit-e-username').value,
      fullname: document.getElementById('edit-e-fullname').value,
      role: document.getElementById('edit-e-role').value,
      isShown: document.getElementById('edit-employee-modal').classList.contains('show'),
      backdropCount: document.querySelectorAll('.modal-backdrop').length
    })`);
    console.log('  ✓ Dữ liệu hiển thị trong modal Sửa:', editFields);
    assert.strictEqual(editFields.isShown, true, 'Modal Sửa phải hiển thị');
    assert.strictEqual(editFields.username, firstEmp.username, 'Username phải đúng');
    assert.strictEqual(editFields.fullname, firstEmp.full_name, 'Họ tên phải đúng');
    assert.strictEqual(editFields.role, firstEmp.role, 'Vai trò phải đúng');
    assert.strictEqual(editFields.backdropCount, 1, 'Phải có đúng 1 backdrop');

    // Kiểm tra validation khi họ tên trống
    await evalInBrowser(ws, `
      document.getElementById('edit-e-fullname').value = '';
      submitEditEmployee();
    `);
    await sleep(200);
    const editErr = await evalInBrowser(ws, `document.getElementById('edit-e-error').textContent`);
    assert.ok(editErr.includes('không được để trống'), `Lỗi sửa họ tên không đúng: "${editErr}"`);
    console.log(`  ✓ Kiểm tra validation khi để trống họ tên: "${editErr}"`);

    // Đóng modal Sửa
    await evalInBrowser(ws, `closeModal('edit-employee-modal')`);
    await sleep(400);
    const backdropsAfterEdit = await evalInBrowser(ws, `document.querySelectorAll('.modal-backdrop').length`);
    assert.strictEqual(backdropsAfterEdit, 0, 'Backdrop sau khi đóng modal Sửa phải bằng 0');

    // 5. KIỂM TRA 3: Modal Đặt lại mật khẩu
    console.log('\n5. Kiểm tra Modal Đặt Lại Mật Khẩu:');
    await evalInBrowser(ws, `showResetPassModal(${firstEmp.id})`);
    await sleep(400);

    const resetFields = await evalInBrowser(ws, `({
      id: document.getElementById('rp-id').value,
      usernameText: document.getElementById('rp-username').textContent,
      isShown: document.getElementById('reset-pass-modal').classList.contains('show'),
      backdropCount: document.querySelectorAll('.modal-backdrop').length
    })`);
    console.log('  ✓ Modal Đặt lại mật khẩu hiển thị:', resetFields);
    assert.strictEqual(resetFields.isShown, true, 'Modal Đặt lại mật khẩu phải hiển thị');
    assert.ok(resetFields.usernameText.includes(firstEmp.username), 'Phải chứa tên đăng nhập');
    assert.strictEqual(resetFields.backdropCount, 1, 'Phải có 1 backdrop');

    // Kiểm tra validation mật khẩu < 8 ký tự
    await evalInBrowser(ws, `
      document.getElementById('rp-password').value = '12345';
      document.getElementById('rp-confirm-password').value = '12345';
      submitResetPassword();
    `);
    await sleep(200);
    let resetErr = await evalInBrowser(ws, `document.getElementById('rp-error').textContent`);
    assert.ok(resetErr.includes('ít nhất 8 ký tự'), `Lỗi mật khẩu ngắn: "${resetErr}"`);
    console.log(`  ✓ Kiểm tra validation mật khẩu < 8 ký tự: "${resetErr}"`);

    // Kiểm tra validation mật khẩu không khớp
    await evalInBrowser(ws, `
      document.getElementById('rp-password').value = 'Password123!';
      document.getElementById('rp-confirm-password').value = 'DifferentPass123!';
      submitResetPassword();
    `);
    await sleep(200);
    resetErr = await evalInBrowser(ws, `document.getElementById('rp-error').textContent`);
    assert.ok(resetErr.includes('không khớp'), `Lỗi mật khẩu không khớp: "${resetErr}"`);
    console.log(`  ✓ Kiểm tra validation mật khẩu không khớp: "${resetErr}"`);

    // Đóng modal Đặt lại mật khẩu
    await evalInBrowser(ws, `closeModal('reset-pass-modal')`);
    await sleep(400);
    const backdropsAfterReset = await evalInBrowser(ws, `document.querySelectorAll('.modal-backdrop').length`);
    assert.strictEqual(backdropsAfterReset, 0, 'Backdrop sau khi đóng modal Đặt lại mật khẩu phải bằng 0');

    // 6. KIỂM TRA 4: Dropdown menu "Thao tác" với Popper strategy fixed
    console.log('\n6. Kiểm tra Dropdown Menu "Thao tác":');
    // Dropdown ở dòng đầu tiên
    await evalInBrowser(ws, `
      const btn = document.querySelector('#employees-table tbody tr:first-child [data-bs-toggle="dropdown"]');
      btn.click();
    `);
    await sleep(300);

    const firstDropdownState = await evalInBrowser(ws, `(() => {
      const menu = document.querySelector('#employees-table tbody tr:first-child .dropdown-menu');
      const rect = menu.getBoundingClientRect();
      const style = window.getComputedStyle(menu);
      const items = Array.from(menu.querySelectorAll('.dropdown-item')).map(it => it.textContent.trim());
      return {
        isShown: menu.classList.contains('show'),
        position: style.position,
        items,
        rect: { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width, height: rect.height }
      };
    })()`);
    console.log('  ✓ Dropdown dòng đầu tiên:', {
      isShown: firstDropdownState.isShown,
      position: firstDropdownState.position,
      items: firstDropdownState.items
    });
    assert.strictEqual(firstDropdownState.isShown, true, 'Dropdown menu dòng đầu phải hiển thị');
    assert.strictEqual(firstDropdownState.position, 'fixed', 'Dropdown Popper position strategy phải là fixed');
    assert.strictEqual(firstDropdownState.items.length, 3, 'Dropdown phải có đủ 3 mục');
    assert.ok(firstDropdownState.items[0].includes('Đặt lại mật khẩu'));
    assert.ok(firstDropdownState.items[1].includes('Khóa') || firstDropdownState.items[1].includes('Mở khóa'));
    assert.ok(firstDropdownState.items[2].includes('Xóa tài khoản'));

    // Đóng dropdown dòng đầu
    await evalInBrowser(ws, `
      document.querySelector('#employees-table tbody tr:first-child [data-bs-toggle="dropdown"]').click();
    `);
    await sleep(300);

    // Dropdown ở dòng cuối cùng
    await evalInBrowser(ws, `
      const lastBtn = document.querySelector('#employees-table tbody tr:last-child [data-bs-toggle="dropdown"]');
      lastBtn.click();
    `);
    await sleep(300);

    const lastDropdownState = await evalInBrowser(ws, `(() => {
      const menu = document.querySelector('#employees-table tbody tr:last-child .dropdown-menu');
      const rect = menu.getBoundingClientRect();
      const style = window.getComputedStyle(menu);
      const items = Array.from(menu.querySelectorAll('.dropdown-item')).map(it => it.textContent.trim());
      return {
        isShown: menu.classList.contains('show'),
        position: style.position,
        items,
        fitsViewport: rect.bottom <= window.innerHeight && rect.right <= window.innerWidth
      };
    })()`);
    console.log('  ✓ Dropdown dòng cuối cùng:', lastDropdownState);
    assert.strictEqual(lastDropdownState.isShown, true, 'Dropdown menu dòng cuối phải hiển thị');
    assert.strictEqual(lastDropdownState.position, 'fixed', 'Dropdown Popper position strategy dòng cuối phải là fixed');
    assert.strictEqual(lastDropdownState.items.length, 3, 'Dropdown dòng cuối phải có đủ 3 mục');
    assert.strictEqual(lastDropdownState.fitsViewport, true, 'Dropdown không tràn ra ngoài viewport');

    // Đóng dropdown dòng cuối
    await evalInBrowser(ws, `
      document.querySelector('#employees-table tbody tr:last-child [data-bs-toggle="dropdown"]').click();
    `);
    await sleep(300);

    // Kiểm tra re-render bảng khi tìm kiếm và dispose instance cũ
    console.log('  ✓ Kiểm tra tìm kiếm và re-render bảng...');
    await evalInBrowser(ws, `
      document.getElementById('search-employees').value = 'manager';
      document.getElementById('search-employees').dispatchEvent(new Event('input'));
    `);
    await sleep(400);

    const searchCount = await evalInBrowser(ws, 'document.querySelectorAll("#employees-table tbody tr").length');
    console.log(`  ✓ Sau khi tìm "manager": hiển thị ${searchCount} dòng.`);
    assert.ok(searchCount >= 1, 'Phải tìm thấy ít nhất 1 dòng manager');

    // Mở dropdown sau khi tìm kiếm
    await evalInBrowser(ws, `
      document.querySelector('#employees-table tbody tr:first-child [data-bs-toggle="dropdown"]').click();
    `);
    await sleep(300);
    const searchDropdownShown = await evalInBrowser(ws, `
      document.querySelector('#employees-table tbody tr:first-child .dropdown-menu').classList.contains('show')
    `);
    assert.strictEqual(searchDropdownShown, true, 'Dropdown sau khi search re-render phải hoạt động bình thường');

    // Xóa tìm kiếm để phục hồi danh sách đầy đủ
    await evalInBrowser(ws, `
      document.getElementById('search-employees').value = '';
      document.getElementById('search-employees').dispatchEvent(new Event('input'));
    `);
    await sleep(400);

    // 7. KIỂM TRA 5: Mở/đóng modal nhiều lần không có backdrop thừa
    console.log('\n7. Kiểm tra đóng mở modal nhiều lần:');
    for (let cycle = 1; cycle <= 5; cycle++) {
      await evalInBrowser(ws, `showAddEmployeeModal()`);
      await sleep(400);
      await evalInBrowser(ws, `closeModal('add-employee-modal')`);
      await sleep(400);
    }
    const finalBackdrops = await evalInBrowser(ws, `document.querySelectorAll('.modal-backdrop').length`);
    const finalBodyModalOpen = await evalInBrowser(ws, `document.body.classList.contains('modal-open')`);
    console.log(`  ✓ Sau 5 lần đóng mở liên tiếp: backdrops = ${finalBackdrops}, body modal-open = ${finalBodyModalOpen}`);
    assert.strictEqual(finalBackdrops, 0, 'Không được còn bất kỳ backdrop thừa nào');
    assert.strictEqual(finalBodyModalOpen, false, 'Body không được còn class modal-open');

    // 8. KIỂM TRA 6: Kiểm tra giao diện trên màn hình nhỏ (Mobile 390x844)
    console.log('\n8. Kiểm tra trên màn hình di động (390x844)...');
    await sendCdp(ws, 'Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true
    });
    await sleep(500);

    // Mở modal trên mobile
    await evalInBrowser(ws, `showAddEmployeeModal()`);
    await sleep(400);

    const mobileModalDialog = await evalInBrowser(ws, `(() => {
      const dialog = document.querySelector('#add-employee-modal .modal-dialog');
      const rect = dialog.getBoundingClientRect();
      return {
        width: rect.width,
        fitsScreen: rect.width <= 390,
        classes: Array.from(dialog.classList)
      };
    })()`);
    console.log('  ✓ Kích thước modal dialog trên mobile:', mobileModalDialog);
    assert.strictEqual(mobileModalDialog.fitsScreen, true, 'Hộp thoại modal phải vừa màn hình mobile');

    // Chụp screenshot mobile modal
    const ssModal = await sendCdp(ws, 'Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'employees_mobile_modal_390px.png'), Buffer.from(ssModal.data, 'base64'));
    console.log('  ✓ Đã lưu ảnh chụp modal mobile vào employees_mobile_modal_390px.png');

    await evalInBrowser(ws, `closeModal('add-employee-modal')`);
    await sleep(400);

    // Mở dropdown trên mobile
    await evalInBrowser(ws, `
      document.querySelector('#employees-table tbody tr:first-child [data-bs-toggle="dropdown"]').click();
    `);
    await sleep(300);

    const mobileDropdown = await evalInBrowser(ws, `(() => {
      const menu = document.querySelector('#employees-table tbody tr:first-child .dropdown-menu');
      const rect = menu.getBoundingClientRect();
      return {
        isShown: menu.classList.contains('show'),
        right: rect.right,
        left: rect.left,
        fitsMobile: rect.right <= 390 && rect.left >= 0
      };
    })()`);
    console.log('  ✓ Dropdown trên mobile:', mobileDropdown);
    assert.strictEqual(mobileDropdown.isShown, true, 'Dropdown trên mobile phải mở được');

    // Chụp screenshot mobile dropdown
    const ssDropdown = await sendCdp(ws, 'Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'employees_mobile_dropdown_390px.png'), Buffer.from(ssDropdown.data, 'base64'));
    console.log('  ✓ Đã lưu ảnh chụp dropdown mobile vào employees_mobile_dropdown_390px.png');

    // Reset device metrics
    await sendCdp(ws, 'Emulation.clearDeviceMetricsOverride');
    await sleep(300);

    // Kiểm tra console errors
    console.log('\n9. Kiểm tra lỗi JavaScript Console:');
    console.log(`  ✓ Số lỗi console ghi nhận: ${consoleErrors.length}`);
    if (consoleErrors.length > 0) {
      console.log('  ⚠️ Các lỗi console:', consoleErrors);
    }
    assert.strictEqual(consoleErrors.length, 0, 'Không được có lỗi Console nào trong suốt quá trình thao tác');

    console.log('\n=== TẤT CẢ CÁC BƯỚC KIỂM THỬ GIAO DIỆN & TƯƠNG TÁC ĐÃ THÀNH CÔNG 100%! ===');
  } finally {
    if (ws) ws.close();
    chromeProcess.kill();
  }
}

run().catch((err) => {
  console.error('\n❌ LỖI KIỂM THỬ:', err);
  process.exit(1);
});
