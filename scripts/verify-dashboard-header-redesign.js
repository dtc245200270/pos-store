require('dotenv').config();
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'http://localhost:3000';
const ARTIFACTS_DIR = 'C:\\Users\\Dell Precision 5550\\.gemini\\antigravity-ide\\brain\\53394d0c-3429-4bb8-8846-0f23d7766d77';
const USER_DATA_DIR = path.join(ARTIFACTS_DIR, 'scratch', 'chrome_test_profile');

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

async function setViewport(ws, width, height) {
  await sendCdp(ws, 'Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 768
  });
}

async function navigate(ws, url) {
  await sendCdp(ws, 'Page.navigate', { url });
  await sleep(1000);
}

async function captureScreenshot(ws, filename) {
  const result = await sendCdp(ws, 'Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(result.data, 'base64');
  const outPath = path.join(ARTIFACTS_DIR, filename);
  fs.writeFileSync(outPath, buf);
  console.log(`  ✓ Đã lưu ảnh chụp: ${filename}`);
  return outPath;
}

async function run() {
  console.log('=== BẮT ĐẦU KIỂM THỬ THIẾT KẾ MỚI HEADER TRANG TỔNG QUAN (CHROME HEADLESS) ===\n');

  const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const DEBUG_PORT = 9226;

  const chromeProc = spawn(CHROME_PATH, [
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    `--user-data-dir=${USER_DATA_DIR}`,
    'about:blank'
  ]);

  try {
    const wsUrl = await getWebSocketDebuggerUrl(DEBUG_PORT);
    const ws = new WebSocket(wsUrl);

    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', reject);
    });

    await sendCdp(ws, 'Page.enable');
    await sendCdp(ws, 'Runtime.enable');
    await sendCdp(ws, 'Network.enable');

    await setViewport(ws, 1440, 900);

    // 1. Đăng nhập tài khoản Quản lý
    console.log('1. Đăng nhập tài khoản Quản lý...');
    await navigate(ws, `${BASE_URL}/login`);

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
    console.log('  Kết quả đăng nhập:', loginRes);
    assert.strictEqual(loginRes.ok, true, 'Đăng nhập thành công');

    // Mở trang Tổng quan
    await navigate(ws, `${BASE_URL}/`);
    await sleep(1200);

    // 2. Kiểm tra Tiêu đề & Mô tả bên trái
    console.log('\n2. Kiểm tra Tiêu đề, Mô tả và Icon bên trái:');
    const titleCheck = await evalInBrowser(ws, `
      (() => {
        const titleEl = document.querySelector('.dashboard-header-title');
        const descEl = document.querySelector('.dashboard-header-desc');
        const iconEl = titleEl ? titleEl.querySelector('i') : null;
        const style = titleEl ? window.getComputedStyle(titleEl) : {};
        return {
          titleText: titleEl ? titleEl.textContent.trim() : '',
          descText: descEl ? descEl.textContent.trim() : '',
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          iconClasses: iconEl ? iconEl.className : ''
        };
      })()
    `);
    console.log('  Thông tin tiêu đề:', titleCheck);
    assert.ok(titleCheck.titleText.includes('Tổng quan cửa hàng'), 'Tiêu đề phải là “Tổng quan cửa hàng”');
    assert.strictEqual(titleCheck.descText, 'Theo dõi doanh thu, hóa đơn và tình trạng tồn kho.', 'Mô tả phải khớp');
    assert.strictEqual(titleCheck.fontSize, '26px', 'Cỡ chữ tiêu đề phải là 26px');
    assert.strictEqual(titleCheck.fontWeight, '600', 'Độ đậm tiêu đề phải là 600 (đậm vừa)');
    assert.ok(titleCheck.iconClasses.includes('bi-speedometer2'), 'Icon phải đồng bộ với menu');
    assert.ok(titleCheck.iconClasses.includes('text-primary'), 'Icon dùng màu text-primary đồng bộ');
    console.log('  ✔ Tiêu đề “Tổng quan cửa hàng” 26px đậm vừa, icon và mô tả đạt chuẩn 100%!');

    // 3. Kiểm tra Cụm ngày và Nút Làm mới bên phải
    console.log('\n3. Kiểm tra Cụm ngày và Nút Làm mới bên phải:');
    const headerActionsCheck = await evalInBrowser(ws, `
      (() => {
        const dateBadge = document.getElementById('today-date-badge');
        const dateLabel = document.getElementById('today-date-label');
        const refreshBtn = document.getElementById('btn-refresh-dashboard');
        const actionsContainer = document.querySelector('.dashboard-header-actions');
        
        const dateStyle = dateBadge ? window.getComputedStyle(dateBadge) : {};
        const btnStyle = refreshBtn ? window.getComputedStyle(refreshBtn) : {};
        const containerStyle = actionsContainer ? window.getComputedStyle(actionsContainer) : {};

        const dateIcon = dateBadge ? dateBadge.querySelector('i') : null;
        const btnIcon = refreshBtn ? refreshBtn.querySelector('i') : null;

        return {
          fullDateText: dateBadge ? dateBadge.textContent.trim() : '',
          dateValue: dateLabel ? dateLabel.textContent.trim() : '',
          hasTzString: dateBadge ? dateBadge.textContent.includes('Asia/Ho_Chi_Minh') : false,
          dateFontSize: dateStyle.fontSize,
          dateColor: dateStyle.color,
          dateBgColor: dateStyle.backgroundColor,
          dateBoxShadow: dateStyle.boxShadow,
          dateHeight: Math.round(parseFloat(dateStyle.height)),
          dateFontWeight: dateStyle.fontWeight,
          hasCalendarIcon: dateIcon ? dateIcon.className.includes('bi-calendar3') : false,
          btnText: refreshBtn ? refreshBtn.textContent.trim() : '',
          btnHeight: Math.round(parseFloat(btnStyle.height)),
          hasArrowIcon: btnIcon ? btnIcon.className.includes('bi-arrow-clockwise') : false,
          gap: containerStyle.gap,
          alignItems: containerStyle.alignItems
        };
      })()
    `);
    console.log('  Thông tin cụm ngày & nút:', headerActionsCheck);
    assert.ok(headerActionsCheck.fullDateText.includes('Hôm nay, '), 'Cụm ngày phải chứa “Hôm nay, ”');
    assert.ok(headerActionsCheck.fullDateText.includes('/'), 'Ngày phải có định dạng DD/MM/YYYY');
    assert.strictEqual(headerActionsCheck.hasTzString, false, 'Không được hiển thị chuỗi (Asia/Ho_Chi_Minh)');
    assert.strictEqual(headerActionsCheck.dateFontSize, '14px', 'Cỡ chữ ngày phải là 14px');
    assert.ok(headerActionsCheck.hasCalendarIcon, 'Phải có icon lịch bi-calendar3');
    assert.strictEqual(headerActionsCheck.dateHeight, 40, 'Chiều cao badge ngày là 40px');
    assert.strictEqual(headerActionsCheck.btnHeight, 40, 'Chiều cao nút Làm mới là 40px');
    assert.ok(headerActionsCheck.hasArrowIcon, 'Nút Làm mới phải có icon bi-arrow-clockwise');
    assert.strictEqual(headerActionsCheck.gap, '12px', 'Khoảng cách giữa ngày và nút là 12px');
    assert.strictEqual(headerActionsCheck.alignItems, 'center', 'Căn giữa theo chiều dọc (align-items: center)');
    console.log('  ✔ Cụm ngày 14px, không lộ múi giờ, nút 40px, gap 12px, căn giữa dọc đạt 100%!');

    // 4. Kiểm tra hành vi Nút Làm mới
    console.log('\n4. Kiểm tra hành vi Nút Làm mới (Icon xoay, trạng thái cập nhật, giữ dữ liệu):');
    const refreshFlow = await evalInBrowser(ws, `
      (async () => {
        const btn = document.getElementById('btn-refresh-dashboard');
        
        btn.click();
        
        // Kiểm tra ngay khi vừa bấm
        const duringRefresh = {
          disabled: btn.disabled,
          html: btn.innerHTML,
          hasSpin: btn.innerHTML.includes('spin-animation'),
          hasUpdatingText: btn.textContent.includes('Đang cập nhật…')
        };

        // Chờ hoàn tất làm mới
        await new Promise(r => setTimeout(r, 1200));

        const afterRefresh = {
          disabled: btn.disabled,
          text: btn.textContent.trim(),
          hasNormalIcon: btn.innerHTML.includes('bi-arrow-clockwise') && !btn.innerHTML.includes('spin-animation'),
          contentVisible: !document.getElementById('dashboard-content').classList.contains('d-none'),
          revenueText: document.getElementById('stat-today-revenue').textContent.trim()
        };

        return { duringRefresh, afterRefresh };
      })()
    `);
    console.log('  Trạng thái lúc đang bấm làm mới:', refreshFlow.duringRefresh);
    console.log('  Trạng thái sau khi hoàn tất:', refreshFlow.afterRefresh);

    assert.strictEqual(refreshFlow.duringRefresh.disabled, true, 'Nút phải bị vô hiệu hóa khi đang cập nhật');
    assert.strictEqual(refreshFlow.duringRefresh.hasUpdatingText, true, 'Nút phải hiển thị “Đang cập nhật…”');
    assert.strictEqual(refreshFlow.duringRefresh.hasSpin, true, 'Icon phải có hiệu ứng xoay (spin-animation)');

    assert.strictEqual(refreshFlow.afterRefresh.disabled, false, 'Nút phải được mở lại sau khi cập nhật');
    assert.strictEqual(refreshFlow.afterRefresh.text, 'Làm mới', 'Nút phải trở về “Làm mới”');
    assert.strictEqual(refreshFlow.afterRefresh.contentVisible, true, 'Dữ liệu dashboard vẫn hiển thị đầy đủ');
    console.log('  ✔ Trạng thái nút Làm mới mượt mà, cập nhật thành công không làm mất đăng nhập!');

    // Chụp ảnh màn hình Desktop (1440px)
    await captureScreenshot(ws, 'admin_dashboard_header_redesign_1440px.png');

    // 5. Kiểm tra Responsive trên Mobile (390px)
    console.log('\n5. Kiểm tra Responsive trên Mobile (390px):');
    await setViewport(ws, 390, 844);
    await sleep(600);

    const mobileCheck = await evalInBrowser(ws, `
      (() => {
        const titleEl = document.querySelector('.dashboard-header-title');
        const actionsEl = document.querySelector('.dashboard-header-actions');
        const headerEl = document.querySelector('.dashboard-header');
        
        const titleRect = titleEl.getBoundingClientRect();
        const actionsRect = actionsEl.getBoundingClientRect();
        const headerRect = headerEl.getBoundingClientRect();

        return {
          titleTop: titleRect.top,
          actionsTop: actionsRect.top,
          isActionsBelowTitle: actionsRect.top > titleRect.bottom,
          headerWidth: headerRect.width,
          actionsWidth: actionsRect.width,
          actionsRight: actionsRect.right,
          noOverflow: actionsRect.right <= 390
        };
      })()
    `);
    console.log('  Thông tin layout trên 390px:', mobileCheck);
    assert.strictEqual(mobileCheck.isActionsBelowTitle, true, 'Trên di động cụm ngày và nút phải nằm bên dưới tiêu đề');
    assert.strictEqual(mobileCheck.noOverflow, true, 'Không có tràn ngang màn hình trên di động');

    // Chụp ảnh màn hình Mobile (390px)
    await captureScreenshot(ws, 'admin_dashboard_header_redesign_390px.png');

    console.log('\n======================================================');
    console.log('🎉 TẤT CẢ 5 YÊU CẦU THIẾT KẾ MỚI HEADER ĐÃ ĐẠT 100%! 🎉');
    console.log('======================================================\n');

  } finally {
    chromeProc.kill();
  }
}

run().catch((err) => {
  console.error('\n❌ KIỂM THỬ THẤT BẠI:', err);
  process.exit(1);
});
