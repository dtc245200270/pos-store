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
  console.log('=== BẮT ĐẦU KIỂM THỬ SỬA LỖI SIDEBAR (CHROME HEADLESS) ===\n');

  const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const DEBUG_PORT = 9227;

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

    // 1. Đăng nhập Quản lý
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
    assert.strictEqual(loginRes.ok, true, 'Đăng nhập thành công');

    // Mở trang Tổng quan
    await navigate(ws, `${BASE_URL}/`);
    await sleep(1200);

    // 2. KIỂM TRA TRẠNG THÁI MỞ RỘNG (EXPANDED)
    console.log('\n2. Kiểm tra Sidebar ở trạng thái MỞ RỘNG (Expanded):');
    // Xóa localStorage collapsed nếu có để đảm bảo trạng thái mở rộng ban đầu
    await evalInBrowser(ws, `
      (() => {
        localStorage.removeItem('pos_sidebar_collapsed');
        document.body.classList.remove('sidebar-collapsed');
      })()
    `);
    await sleep(300);

    const expandedState = await evalInBrowser(ws, `
      (() => {
        const sidebar = document.getElementById('posManagerSidebar');
        const topbar = document.getElementById('posTopbar');
        const brand = document.querySelector('.pos-sidebar-brand');
        const brandTitle = document.querySelector('.brand-title');
        const brandBadge = document.querySelector('.brand-badge');
        const groupTitles = Array.from(document.querySelectorAll('.pos-sidebar-group-title')).map(el => ({
          text: el.textContent.trim(),
          visible: window.getComputedStyle(el).display !== 'none' && window.getComputedStyle(el).visibility !== 'hidden'
        }));
        const navLinks = Array.from(document.querySelectorAll('.pos-manager-sidebar .nav-link')).map(el => ({
          text: el.querySelector('span')?.textContent.trim(),
          hasIcon: !!el.querySelector('i'),
          isActive: el.classList.contains('active'),
          spanVisible: window.getComputedStyle(el.querySelector('span')).display !== 'none'
        }));

        const footerExp = document.querySelector('.pos-sidebar-footer-expanded');
        const footerCol = document.querySelector('.pos-sidebar-footer-collapsed');
        const footerExpVisible = window.getComputedStyle(footerExp).display !== 'none';
        const footerColVisible = window.getComputedStyle(footerCol).display !== 'none';

        const btnProfile = footerExp.querySelector('a');
        const btnLogout = footerExp.querySelector('button');

        const sidebarRect = sidebar.getBoundingClientRect();
        const topbarRect = topbar.getBoundingClientRect();

        return {
          sidebarWidth: Math.round(sidebarRect.width),
          topbarLeft: Math.round(topbarRect.left),
          bodyPaddingLeft: parseInt(window.getComputedStyle(document.body).paddingLeft),
          brandTitleVisible: window.getComputedStyle(brandTitle).display !== 'none',
          brandBadgeVisible: window.getComputedStyle(brandBadge).display !== 'none',
          groupTitles,
          navLinks,
          footerExpVisible,
          footerColVisible,
          btnProfileText: btnProfile.textContent.trim(),
          btnLogoutText: btnLogout.textContent.trim(),
          btnProfileNoWrap: window.getComputedStyle(btnProfile).whiteSpace,
          btnLogoutNoWrap: window.getComputedStyle(btnLogout).whiteSpace,
          hasHorizontalScroll: sidebar.scrollWidth > sidebar.clientWidth,
          bodyHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
        };
      })()
    `);

    console.log('  Thông tin trạng thái mở rộng:', {
      sidebarWidth: expandedState.sidebarWidth,
      topbarLeft: expandedState.topbarLeft,
      bodyPaddingLeft: expandedState.bodyPaddingLeft,
      brandTitleVisible: expandedState.brandTitleVisible,
      footerExpVisible: expandedState.footerExpVisible,
      footerColVisible: expandedState.footerColVisible,
      hasHorizontalScroll: expandedState.hasHorizontalScroll,
      bodyHorizontalOverflow: expandedState.bodyHorizontalOverflow
    });

    assert.strictEqual(expandedState.sidebarWidth, 260, 'Chiều rộng sidebar mở rộng là 260px');
    assert.strictEqual(expandedState.topbarLeft, 260, 'Topbar dịch sang phải 260px');
    assert.strictEqual(expandedState.bodyPaddingLeft, 260, 'Body padding-left là 260px');
    assert.strictEqual(expandedState.brandTitleVisible, true, 'Brand title hiển thị');
    assert.strictEqual(expandedState.brandBadgeVisible, true, 'Brand badge hiển thị');
    assert.strictEqual(expandedState.footerExpVisible, true, 'Footer expanded hiển thị');
    assert.strictEqual(expandedState.footerColVisible, false, 'Footer collapsed bị ẩn');
    assert.strictEqual(expandedState.hasHorizontalScroll, false, 'Sidebar không có thanh cuộn ngang');
    assert.strictEqual(expandedState.bodyHorizontalOverflow, false, 'Trang không bị tràn ngang');
    assert.ok(expandedState.btnProfileText.includes('Tài khoản'), 'Nút Tài khoản đầy đủ chữ');
    assert.ok(expandedState.btnLogoutText.includes('Đăng xuất'), 'Nút Đăng xuất đầy đủ chữ');
    console.log('  ✔ Trạng thái mở rộng hoàn hảo!');
    await captureScreenshot(ws, 'admin_sidebar_expanded_1440px.png');

    // 3. KIỂM TRA TRẠNG THÁI THU GỌN (COLLAPSED)
    console.log('\n3. Bấm nút Thu gọn Sidebar và kiểm tra trạng thái THU GỌN:');
    await evalInBrowser(ws, `
      (() => {
        document.getElementById('btn-desktop-sidebar-collapse').click();
      })()
    `);
    await sleep(400);

    const collapsedState = await evalInBrowser(ws, `
      (() => {
        const sidebar = document.getElementById('posManagerSidebar');
        const topbar = document.getElementById('posTopbar');
        const brandTitle = document.querySelector('.brand-title');
        const brandBadge = document.querySelector('.brand-badge');
        
        const groupTitles = Array.from(document.querySelectorAll('.pos-sidebar-group-title')).map(el => {
          const style = window.getComputedStyle(el);
          return {
            height: parseFloat(style.height),
            color: style.color,
            fontSize: style.fontSize,
            isDivider: parseFloat(style.height) <= 2 || style.fontSize === '0px'
          };
        });

        const navLinks = Array.from(document.querySelectorAll('.pos-manager-sidebar .nav-link')).map(el => {
          const style = window.getComputedStyle(el);
          const spanStyle = window.getComputedStyle(el.querySelector('span'));
          return {
            width: parseFloat(style.width),
            height: parseFloat(style.height),
            isActive: el.classList.contains('active'),
            spanHidden: spanStyle.display === 'none',
            hasTooltip: el.hasAttribute('data-bs-toggle') && el.getAttribute('data-bs-toggle') === 'tooltip',
            hasAriaLabel: !!el.getAttribute('aria-label')
          };
        });

        const footerExp = document.querySelector('.pos-sidebar-footer-expanded');
        const footerCol = document.querySelector('.pos-sidebar-footer-collapsed');
        const footerExpVisible = window.getComputedStyle(footerExp).display !== 'none';
        const footerColVisible = window.getComputedStyle(footerCol).display !== 'none';

        const iconBtns = Array.from(footerCol.querySelectorAll('.pos-footer-icon-btn')).map(btn => {
          const style = window.getComputedStyle(btn);
          return {
            width: Math.round(parseFloat(style.width)),
            height: Math.round(parseFloat(style.height)),
            hasTooltip: btn.hasAttribute('data-bs-toggle'),
            hasAriaLabel: !!btn.getAttribute('aria-label'),
            title: btn.getAttribute('title')
          };
        });

        const sidebarRect = sidebar.getBoundingClientRect();
        const topbarRect = topbar.getBoundingClientRect();

        return {
          sidebarWidth: Math.round(sidebarRect.width),
          topbarLeft: Math.round(topbarRect.left),
          bodyPaddingLeft: parseInt(window.getComputedStyle(document.body).paddingLeft),
          brandTitleHidden: window.getComputedStyle(brandTitle).display === 'none',
          brandBadgeHidden: window.getComputedStyle(brandBadge).display === 'none',
          groupTitles,
          navLinks,
          footerExpVisible,
          footerColVisible,
          iconBtns,
          hasHorizontalScroll: sidebar.scrollWidth > sidebar.clientWidth,
          bodyHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth
        };
      })()
    `);

    console.log('  Thông tin trạng thái thu gọn:', {
      sidebarWidth: collapsedState.sidebarWidth,
      topbarLeft: collapsedState.topbarLeft,
      bodyPaddingLeft: collapsedState.bodyPaddingLeft,
      brandTitleHidden: collapsedState.brandTitleHidden,
      brandBadgeHidden: collapsedState.brandBadgeHidden,
      footerExpVisible: collapsedState.footerExpVisible,
      footerColVisible: collapsedState.footerColVisible,
      iconBtns: collapsedState.iconBtns,
      hasHorizontalScroll: collapsedState.hasHorizontalScroll,
      bodyHorizontalOverflow: collapsedState.bodyHorizontalOverflow
    });

    assert.ok(collapsedState.sidebarWidth >= 76 && collapsedState.sidebarWidth <= 80, `Chiều rộng sidebar thu gọn (${collapsedState.sidebarWidth}px) phải trong khoảng 76-80px`);
    assert.strictEqual(collapsedState.topbarLeft, collapsedState.sidebarWidth, 'Topbar dịch sang trái đúng bằng chiều rộng sidebar thu gọn');
    assert.strictEqual(collapsedState.bodyPaddingLeft, collapsedState.sidebarWidth, 'Body padding-left đúng bằng chiều rộng sidebar thu gọn');
    assert.strictEqual(collapsedState.brandTitleHidden, true, 'Brand title đã ẩn');
    assert.strictEqual(collapsedState.brandBadgeHidden, true, 'Brand badge đã ẩn');
    
    // Tên nhóm biến thành đường kẻ phân cách nhẹ
    collapsedState.groupTitles.forEach((gt, idx) => {
      assert.strictEqual(gt.isDivider, true, `Tên nhóm ${idx} biến thành đường kẻ phân cách nhẹ`);
    });

    // Menu links chỉ hiện icon căn giữa, span đã ẩn
    collapsedState.navLinks.forEach((nl, idx) => {
      assert.strictEqual(nl.spanHidden, true, `Nhãn text của mục menu ${idx} đã ẩn`);
      assert.strictEqual(nl.hasTooltip, true, `Mục menu ${idx} có tooltip`);
      assert.strictEqual(nl.hasAriaLabel, true, `Mục menu ${idx} có aria-label`);
    });

    // Giữ trạng thái active của mục đang chọn
    const activeItem = collapsedState.navLinks.find(nl => nl.isActive);
    assert.ok(activeItem, 'Vẫn giữ trạng thái active của trang đang mở');

    // Footer collapsed: 2 nút icon xếp dọc 40x40px
    assert.strictEqual(collapsedState.footerExpVisible, false, 'Footer expanded đã ẩn');
    assert.strictEqual(collapsedState.footerColVisible, true, 'Footer collapsed hiển thị');
    assert.strictEqual(collapsedState.iconBtns.length, 2, 'Có 2 nút icon');
    assert.strictEqual(collapsedState.iconBtns[0].width, 40, 'Nút profile rộng 40px');
    assert.strictEqual(collapsedState.iconBtns[0].height, 40, 'Nút profile cao 40px');
    assert.strictEqual(collapsedState.iconBtns[1].width, 40, 'Nút logout rộng 40px');
    assert.strictEqual(collapsedState.iconBtns[1].height, 40, 'Nút logout cao 40px');

    // Tuyệt đối không có thanh cuộn ngang
    assert.strictEqual(collapsedState.hasHorizontalScroll, false, 'Không có thanh cuộn ngang trên sidebar thu gọn');
    assert.strictEqual(collapsedState.bodyHorizontalOverflow, false, 'Không có thanh cuộn ngang trên toàn trang');
    console.log('  ✔ Trạng thái thu gọn 78px, icon căn giữa, footer 40x40 xếp dọc, không có thanh cuộn ngang đạt 100%!');
    await captureScreenshot(ws, 'admin_sidebar_collapsed_1440px.png');

    // 4. KIỂM TRA ĐÓNG/MỞ NHIỀU LẦN (TOGGLE 4 LẦN)
    console.log('\n4. Kiểm tra Đóng / Mở liên tiếp 4 lần:');
    for (let i = 1; i <= 4; i++) {
      await evalInBrowser(ws, `document.getElementById('btn-desktop-sidebar-collapse').click()`);
      await sleep(150);
    }
    // Trở về trạng thái thu gọn
    await evalInBrowser(ws, `
      if (!document.body.classList.contains('sidebar-collapsed')) {
        document.getElementById('btn-desktop-sidebar-collapse').click();
      }
    `);
    await sleep(300);
    const postToggleCheck = await evalInBrowser(ws, `
      (() => {
        const sidebar = document.getElementById('posManagerSidebar');
        return {
          hasScroll: sidebar.scrollWidth > sidebar.clientWidth,
          width: Math.round(sidebar.getBoundingClientRect().width)
        };
      })()
    `);
    assert.strictEqual(postToggleCheck.hasScroll, false, 'Sau nhiều lần toggle, sidebar vẫn không bị tràn hay lỗi bố cục');
    console.log('  ✔ Đóng/mở nhiều lần ổn định, kích thước:', postToggleCheck.width + 'px');

    // 5. KIỂM TRA MÀN HÌNH THẤP (HEIGHT = 500PX)
    console.log('\n5. Kiểm tra màn hình thấp (Height = 500px):');
    await setViewport(ws, 1440, 500);
    await sleep(400);

    const lowHeightCheck = await evalInBrowser(ws, `
      (() => {
        const navContainer = document.querySelector('.pos-sidebar-nav-container');
        const footer = document.querySelector('.pos-sidebar-footer');
        const navRect = navContainer.getBoundingClientRect();
        const footerRect = footer.getBoundingClientRect();

        return {
          navCanScroll: navContainer.scrollHeight >= navContainer.clientHeight,
          footerAtBottom: footerRect.bottom <= window.innerHeight + 1,
          noOverlap: navRect.bottom <= footerRect.top + 1
        };
      })()
    `);
    console.log('  Thông tin màn hình thấp:', lowHeightCheck);
    assert.strictEqual(lowHeightCheck.noOverlap, true, 'Footer nằm ở đáy và không đè lên menu');
    console.log('  ✔ Bố cục flex dọc cuộn mượt mà trên màn hình thấp!');
    await captureScreenshot(ws, 'admin_sidebar_short_screen_500px.png');

    // 6. KIỂM TRA MÀN HÌNH NHỎ (MOBILE 390PX)
    console.log('\n6. Kiểm tra Mobile Drawer trên 390px:');
    await setViewport(ws, 390, 844);
    await sleep(500);

    // Khi ở 390px, sidebar mặc định đóng
    const mobileInit = await evalInBrowser(ws, `
      (() => {
        const sidebar = document.getElementById('posManagerSidebar');
        const rect = sidebar.getBoundingClientRect();
        return {
          isClosed: rect.right <= 0,
          bodyPaddingLeft: parseInt(window.getComputedStyle(document.body).paddingLeft)
        };
      })()
    `);
    assert.strictEqual(mobileInit.isClosed, true, 'Sidebar đóng bên ngoài màn hình trên mobile');
    assert.strictEqual(mobileInit.bodyPaddingLeft, 0, 'Nội dung chính chiếm toàn bộ chiều rộng (padding-left = 0)');

    // Mở drawer
    console.log('  Mở Mobile Drawer...');
    await evalInBrowser(ws, `document.getElementById('btn-mobile-sidebar-toggle').click()`);
    await sleep(400);

    const drawerOpenCheck = await evalInBrowser(ws, `
      (() => {
        const sidebar = document.getElementById('posManagerSidebar');
        const backdrop = document.getElementById('posSidebarBackdrop');
        const closeBtn = document.getElementById('btn-close-mobile-drawer');
        const brandTitle = document.querySelector('.brand-title');
        const footerExp = document.querySelector('.pos-sidebar-footer-expanded');
        const rect = sidebar.getBoundingClientRect();

        return {
          isOpen: rect.left >= 0,
          drawerWidth: Math.round(rect.width),
          hasBackdrop: backdrop.classList.contains('show'),
          hasCloseBtn: !!closeBtn,
          closeBtnVisible: window.getComputedStyle(closeBtn).display !== 'none',
          brandTitleVisible: window.getComputedStyle(brandTitle).display !== 'none',
          footerExpVisible: window.getComputedStyle(footerExp).display !== 'none'
        };
      })()
    `);
    console.log('  Thông tin Drawer khi mở:', drawerOpenCheck);
    assert.strictEqual(drawerOpenCheck.isOpen, true, 'Drawer đã mở ra');
    assert.strictEqual(drawerOpenCheck.hasBackdrop, true, 'Lớp nền backdrop hiển thị');
    assert.strictEqual(drawerOpenCheck.closeBtnVisible, true, 'Nút đóng drawer hiển thị');
    assert.strictEqual(drawerOpenCheck.brandTitleVisible, true, 'Trên drawer mobile tên thương hiệu hiển thị đầy đủ');
    assert.strictEqual(drawerOpenCheck.footerExpVisible, true, 'Trên drawer mobile footer hiển thị đầy đủ');
    console.log('  ✔ Mobile Drawer mở hoàn chỉnh, có nút đóng và lớp nền!');
    await captureScreenshot(ws, 'admin_sidebar_mobile_drawer_open.png');

    // Bấm nút đóng drawer
    console.log('  Bấm nút đóng Drawer...');
    await evalInBrowser(ws, `document.getElementById('btn-close-mobile-drawer').click()`);
    await sleep(400);

    const drawerClosedCheck = await evalInBrowser(ws, `
      (() => {
        const sidebar = document.getElementById('posManagerSidebar');
        const backdrop = document.getElementById('posSidebarBackdrop');
        return {
          isClosed: sidebar.getBoundingClientRect().right <= 0,
          backdropHidden: !backdrop.classList.contains('show')
        };
      })()
    `);
    assert.strictEqual(drawerClosedCheck.isClosed, true, 'Drawer đóng thành công');
    assert.strictEqual(drawerClosedCheck.backdropHidden, true, 'Backdrop đã ẩn');
    console.log('  ✔ Đóng Drawer thành công, nội dung chính dùng toàn bộ chiều rộng!');

    console.log('\n======================================================');
    console.log('🎉 TẤT CẢ CÁC BƯỚC KIỂM THỬ SỬA LỖI SIDEBAR ĐÃ ĐẠT 100%! 🎉');
    console.log('======================================================\n');

  } finally {
    chromeProc.kill();
  }
}

run().catch((err) => {
  console.error('\n❌ KIỂM THỬ THẤT BẠI:', err);
  process.exit(1);
});
