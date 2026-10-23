require('dotenv').config();
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const BASE_URL = 'http://localhost:3000';
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const ARTIFACT_DIR = 'C:\\Users\\Dell Precision 5550\\.gemini\\antigravity-ide\\brain\\53394d0c-3429-4bb8-8846-0f23d7766d77';
const USER_DATA_DIR = path.join(ARTIFACT_DIR, 'scratch', 'chrome_fouc_test_profile');

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
  console.log('=== KIỂM THỬ KHÔNG CHỚP TRẮNG, KHÔNG GIẬT KHUNG & CHUYỂN TRANG ỔN ĐỊNH ===\n');

  if (!fs.existsSync(USER_DATA_DIR)) {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  }

  const chromeProcess = spawn(CHROME_PATH, [
    '--headless=new',
    '--remote-debugging-port=9227',
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
    console.log('✓ Kết nối CDP tới Chrome thành công.');

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
    console.log('1. Đăng nhập Manager...');
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/login` });
    await sleep(1000);

    const mgrPass = process.env.INITIAL_MANAGER_PASSWORD || 'VeryStrongPass123!@#';
    await evalInBrowser(ws, `
      document.getElementById('username').value = 'manager';
      document.getElementById('password').value = ${JSON.stringify(mgrPass)};
      document.getElementById('login-form').dispatchEvent(new Event('submit', { cancelable: true }));
    `);
    await sleep(1800);

    const pagesToTest = [
      { path: '/', title: 'Tổng quan' },
      { path: '/sales', title: 'Bán hàng' },
      { path: '/products', title: 'Sản phẩm' },
      { path: '/stock-receipts', title: 'Nhập hàng' },
      { path: '/inventory', title: 'Tồn kho' },
      { path: '/invoices', title: 'Hóa đơn' },
      { path: '/employees', title: 'Tài khoản nhân viên' },
      { path: '/profile', title: 'Tài khoản của tôi' }
    ];

    // 2. KIỂM THỬ TRẠNG THÁI MỞ RỘNG (EXPANDED - 260px)
    console.log('\n2. Kiểm tra chuyển qua lại các trang ở trạng thái MỞ RỘNG:');
    for (const p of pagesToTest) {
      await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}${p.path}` });
      await sleep(400);

      const state = await evalInBrowser(ws, `(() => {
        const sidebar = document.getElementById('posManagerSidebar');
        const topbar = document.getElementById('posTopbar');
        const bodyStyle = window.getComputedStyle(document.body);
        const sidebarStyle = sidebar ? window.getComputedStyle(sidebar) : null;
        const topbarStyle = topbar ? window.getComputedStyle(topbar) : null;
        const activeLink = document.querySelector('.pos-manager-sidebar .nav-link.active');
        return {
          bodyPaddingLeft: bodyStyle.paddingLeft,
          bodyBg: bodyStyle.backgroundColor,
          sidebarWidth: sidebarStyle ? sidebarStyle.width : null,
          topbarLeft: topbarStyle ? topbarStyle.left : null,
          hasTransitioningClass: document.body.classList.contains('sidebar-transitioning'),
          activeLinkText: activeLink ? activeLink.textContent.trim() : null,
          hasHorizontalScroll: sidebar ? sidebar.scrollWidth > sidebar.clientWidth : false
        };
      })()`);

      console.log(`  ✓ Trang ${p.path} (${p.title}): sidebarWidth = ${state.sidebarWidth}, bodyPaddingLeft = ${state.bodyPaddingLeft}, scrollX = ${state.hasHorizontalScroll}`);
      assert.strictEqual(state.sidebarWidth, '260px', `Sidebar width trên ${p.path} phải là 260px`);
      assert.strictEqual(state.bodyPaddingLeft, '260px', `Body padding-left trên ${p.path} phải là 260px`);
      assert.strictEqual(state.topbarLeft, '260px', `Topbar left trên ${p.path} phải là 260px`);
      assert.strictEqual(state.hasTransitioningClass, false, 'Không được có class sidebar-transitioning khi tải trang');
      assert.strictEqual(state.hasHorizontalScroll, false, 'Sidebar không được có thanh cuộn ngang');
    }

    // 3. THU GỌN SIDEBAR VÀ KIỂM TRA LỖI NÚT TÀI KHOẢN, TÊN NHÓM
    console.log('\n3. Thu gọn sidebar trên desktop...');
    await evalInBrowser(ws, `
      document.getElementById('btn-desktop-sidebar-collapse').click();
    `);
    await sleep(400);

    const collapsedState = await evalInBrowser(ws, `(() => {
      const sidebar = document.getElementById('posManagerSidebar');
      const groupTitle = document.querySelector('.pos-sidebar-group-title');
      const expandedFooter = document.querySelector('.pos-sidebar-footer-expanded');
      const collapsedFooter = document.querySelector('.pos-sidebar-footer-collapsed');
      const groupStyle = groupTitle ? window.getComputedStyle(groupTitle) : null;
      const expStyle = expandedFooter ? window.getComputedStyle(expandedFooter) : null;
      const colStyle = collapsedFooter ? window.getComputedStyle(collapsedFooter) : null;
      return {
        sidebarWidth: window.getComputedStyle(sidebar).width,
        isGroupTextHidden: groupStyle ? (groupStyle.color === 'transparent' || groupStyle.fontSize === '0px' || groupStyle.height === '1px') : false,
        isExpandedFooterHidden: expStyle ? expStyle.display === 'none' : false,
        isCollapsedFooterVisible: colStyle ? colStyle.display === 'flex' : false,
        hasHorizontalScroll: sidebar.scrollWidth > sidebar.clientWidth
      };
    })()`);

    console.log('  ✓ Trạng thái thu gọn ngay sau khi bấm nút:', collapsedState);
    assert.strictEqual(collapsedState.sidebarWidth, '78px', 'Sidebar width phải thu về 78px');
    assert.strictEqual(collapsedState.isGroupTextHidden, true, 'Tên nhóm phải được ẩn chữ và thay bằng đường phân cách');
    assert.strictEqual(collapsedState.isExpandedFooterHidden, true, 'Khối nút có chữ "Tài khoản" phải bị ẩn hoàn toàn');
    assert.strictEqual(collapsedState.isCollapsedFooterVisible, true, 'Khối icon thu gọn phải hiển thị');
    assert.strictEqual(collapsedState.hasHorizontalScroll, false, 'Không được có thanh cuộn ngang trong sidebar thu gọn');

    // 4. KIỂM THỬ CHUYỂN QUA LẠI TẤT CẢ CÁC TRANG Ở TRẠNG THÁI THU GỌN (78px)
    console.log('\n4. Kiểm tra chuyển qua lại giữa tất cả các trang ở trạng thái THU GỌN (ổn định 78px):');
    for (const p of pagesToTest) {
      await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}${p.path}` });
      await sleep(400);

      const state = await evalInBrowser(ws, `(() => {
        const sidebar = document.getElementById('posManagerSidebar');
        const topbar = document.getElementById('posTopbar');
        const bodyStyle = window.getComputedStyle(document.body);
        const sidebarStyle = sidebar ? window.getComputedStyle(sidebar) : null;
        const topbarStyle = topbar ? window.getComputedStyle(topbar) : null;
        return {
          htmlHasCollapsed: document.documentElement.classList.contains('sidebar-collapsed'),
          bodyHasCollapsed: document.body.classList.contains('sidebar-collapsed'),
          bodyPaddingLeft: bodyStyle.paddingLeft,
          sidebarWidth: sidebarStyle ? sidebarStyle.width : null,
          topbarLeft: topbarStyle ? topbarStyle.left : null,
          hasTransitioningClass: document.body.classList.contains('sidebar-transitioning'),
          hasHorizontalScroll: sidebar ? sidebar.scrollWidth > sidebar.clientWidth : false
        };
      })()`);

      console.log(`  ✓ Trang ${p.path} (${p.title}): sidebarWidth = ${state.sidebarWidth}, bodyPaddingLeft = ${state.bodyPaddingLeft}, htmlCollapsed = ${state.htmlHasCollapsed}`);
      assert.strictEqual(state.htmlHasCollapsed, true, `html trên ${p.path} phải có class sidebar-collapsed ngay từ head`);
      assert.strictEqual(state.sidebarWidth, '78px', `Sidebar width trên ${p.path} phải giữ nguyên 78px`);
      assert.strictEqual(state.bodyPaddingLeft, '78px', `Body padding-left trên ${p.path} phải là 78px`);
      assert.strictEqual(state.topbarLeft, '78px', `Topbar left trên ${p.path} phải là 78px`);
      assert.strictEqual(state.hasTransitioningClass, false, 'Không có class sidebar-transitioning khi chuyển trang');
      assert.strictEqual(state.hasHorizontalScroll, false, 'Sidebar không có thanh cuộn ngang');
    }

    // 5. KIỂM THỬ TẢI LẠI TRANG (RELOAD / F5)
    console.log('\n5. Kiểm tra Tải lại trang (Reload / F5)...');
    await sendCdp(ws, 'Page.reload');
    await sleep(600);

    const reloadState = await evalInBrowser(ws, `({
      sidebarWidth: window.getComputedStyle(document.getElementById('posManagerSidebar')).width,
      bodyPaddingLeft: window.getComputedStyle(document.body).paddingLeft,
      htmlCollapsed: document.documentElement.classList.contains('sidebar-collapsed')
    })`);
    console.log('  ✓ Trạng thái sau Reload:', reloadState);
    assert.strictEqual(reloadState.sidebarWidth, '78px', 'Sau reload sidebar vẫn giữ nguyên 78px');
    assert.strictEqual(reloadState.htmlCollapsed, true, 'html vẫn giữ sidebar-collapsed');

    // 6. KIỂM THỬ NÚT BACK / FORWARD
    console.log('\n6. Kiểm tra nút Back / Forward...');
    // Điều hướng tới /products rồi tới /invoices
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/products` });
    await sleep(400);
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/invoices` });
    await sleep(400);

    // Bấm Back -> quay lại /products
    await evalInBrowser(ws, `window.history.back()`);
    await sleep(500);
    const pathAfterBack = await evalInBrowser(ws, `window.location.pathname`);
    const widthAfterBack = await evalInBrowser(ws, `window.getComputedStyle(document.getElementById('posManagerSidebar')).width`);
    console.log(`  ✓ Sau khi Back: đường dẫn = "${pathAfterBack}", sidebarWidth = ${widthAfterBack}`);
    assert.strictEqual(pathAfterBack, '/products');
    assert.strictEqual(widthAfterBack, '78px');

    // Bấm Forward -> quay lại /invoices
    await evalInBrowser(ws, `window.history.forward()`);
    await sleep(500);
    const pathAfterForward = await evalInBrowser(ws, `window.location.pathname`);
    const widthAfterForward = await evalInBrowser(ws, `window.getComputedStyle(document.getElementById('posManagerSidebar')).width`);
    console.log(`  ✓ Sau khi Forward: đường dẫn = "${pathAfterForward}", sidebarWidth = ${widthAfterForward}`);
    assert.strictEqual(pathAfterForward, '/invoices');
    assert.strictEqual(widthAfterForward, '78px');

    // 7. Chụp ảnh màn hình ở trạng thái thu gọn
    const ssCollapsed = await sendCdp(ws, 'Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'admin_nav_collapsed_perfect_78px.png'), Buffer.from(ssCollapsed.data, 'base64'));
    console.log('  ✓ Đã lưu ảnh chụp sidebar thu gọn vào admin_nav_collapsed_perfect_78px.png');

    // 8. Mở rộng lại và chụp ảnh màn hình
    await evalInBrowser(ws, `
      document.getElementById('btn-desktop-sidebar-collapse').click();
    `);
    await sleep(400);
    const ssExpanded = await sendCdp(ws, 'Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'admin_nav_expanded_perfect_260px.png'), Buffer.from(ssExpanded.data, 'base64'));
    console.log('  ✓ Đã lưu ảnh chụp sidebar mở rộng vào admin_nav_expanded_perfect_260px.png');

    // 9. Kiểm tra console errors
    console.log('\n7. Kiểm tra lỗi JavaScript Console:');
    console.log(`  ✓ Số lỗi console ghi nhận: ${consoleErrors.length}`);
    if (consoleErrors.length > 0) {
      console.log('  ⚠️ Các lỗi console:', consoleErrors);
    }
    assert.strictEqual(consoleErrors.length, 0, 'Không được có bất kỳ lỗi Console nào');

    console.log('\n=== TẤT CẢ CÁC BÀI KIỂM THỬ KHÔNG CHỚP TRẮNG & ỔN ĐỊNH BỐ CỤC ĐẠT 100%! ===');
  } finally {
    if (ws) ws.close();
    chromeProcess.kill();
  }
}

run().catch((err) => {
  console.error('\n❌ LỖI KIỂM THỬ:', err);
  process.exit(1);
});
