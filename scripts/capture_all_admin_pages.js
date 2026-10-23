require('dotenv').config();
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

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
  await sleep(400);
}

async function captureScreenshot(ws, filename) {
  const filepath = path.join(ARTIFACTS_DIR, filename);
  const result = await sendCdp(ws, 'Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(filepath, Buffer.from(result.data, 'base64'));
  console.log(`  ✓ Đã lưu ảnh chụp: ${filename}`);
  return filepath;
}

async function run() {
  console.log('=== BẮT ĐẦU KIỂM THỬ TRỰC TIẾP GIAO DIỆN ADMIN TRÊN CHROME HEADLESS ===\n');

  if (!fs.existsSync(USER_DATA_DIR)) {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  }

  const CHROME_DEBUG_PORT = 9245;
  const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

  const chromeProcess = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${CHROME_DEBUG_PORT}`,
    `--user-data-dir=${USER_DATA_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1440,950'
  ]);

  try {
    const wsUrl = await getWebSocketDebuggerUrl(CHROME_DEBUG_PORT);
    const ws = new WebSocket(wsUrl);
    await new Promise(r => ws.addEventListener('open', r));

    await sendCdp(ws, 'Page.enable');
    await sendCdp(ws, 'Runtime.enable');
    await sendCdp(ws, 'Network.enable');

    // 1. Đăng nhập với tài khoản Quản lý
    console.log('1. Đăng nhập tài khoản Quản lý...');
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/login` });
    await sleep(1000);

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
    assert.ok(loginRes && loginRes.ok, 'Đăng nhập Quản lý thất bại');

    // 2. Kiểm tra Trang 1: Tổng quan (/)
    console.log('\n2. Kiểm tra Trang Tổng quan (/)...');
    await setViewport(ws, 1440, 950);
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/` });
    await sleep(1500);

    const dashInfo = await evalInBrowser(ws, `
      (() => {
        return {
          title: document.title,
          sidebarBrand: document.querySelector('.pos-sidebar-brand')?.innerText,
          activeLink: document.querySelector('.pos-manager-sidebar .nav-link.active')?.innerText.trim(),
          statRevenue: document.getElementById('stat-today-revenue')?.innerText,
          statInvoices: document.getElementById('stat-today-invoices')?.innerText,
          statProducts: document.getElementById('stat-active-products')?.innerText,
          statLowStock: document.getElementById('stat-low-stock-count')?.innerText,
          topbarTitle: document.getElementById('pos-page-title')?.innerText
        };
      })()
    `);
    console.log('  Thông tin Tổng quan:', dashInfo);
    assert.strictEqual(dashInfo.activeLink, 'Tổng quan', 'Mục active phải là Tổng quan');
    await captureScreenshot(ws, 'admin_dashboard_1440px.png');

    // Test Thu gọn Sidebar trên Desktop
    console.log('  Thử nghiệm thu gọn sidebar trên Desktop...');
    await evalInBrowser(ws, `document.getElementById('btn-desktop-sidebar-collapse')?.click()`);
    await sleep(500);
    const isCollapsed = await evalInBrowser(ws, `document.body.classList.contains('sidebar-collapsed')`);
    console.log('  Sidebar đã thu gọn:', isCollapsed);
    assert.ok(isCollapsed, 'Sidebar phải có class sidebar-collapsed sau khi click');
    await captureScreenshot(ws, 'admin_dashboard_collapsed.png');

    // Mở rộng lại
    await evalInBrowser(ws, `document.getElementById('btn-desktop-sidebar-collapse')?.click()`);
    await sleep(300);

    // 3. Kiểm tra Trang 2: Sản phẩm (/products)
    console.log('\n3. Kiểm tra Trang Sản phẩm (/products)...');
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/products` });
    await sleep(1500);

    const prodInfo = await evalInBrowser(ws, `
      (() => {
        const rows = document.querySelectorAll('#products-tbody tr');
        const firstAction = document.querySelector('#products-tbody tr:first-child .dropdown-menu');
        return {
          title: document.title,
          activeLink: document.querySelector('.pos-manager-sidebar .nav-link.active')?.innerText.trim(),
          rowCount: rows.length,
          hasActionDropdown: !!firstAction,
          btnAddProduct: document.getElementById('btn-add-product')?.innerText.trim()
        };
      })()
    `);
    console.log('  Thông tin Sản phẩm:', prodInfo);
    assert.strictEqual(prodInfo.activeLink, 'Sản phẩm');
    await captureScreenshot(ws, 'admin_products_1440px.png');

    // 4. Kiểm tra Trang 3: Tồn kho (/inventory)
    console.log('\n4. Kiểm tra Trang Tồn kho (/inventory)...');
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/inventory` });
    await sleep(1500);

    const invInfo = await evalInBrowser(ws, `
      (() => {
        return {
          title: document.title,
          activeLink: document.querySelector('.pos-manager-sidebar .nav-link.active')?.innerText.trim(),
          statTotal: document.getElementById('stat-total')?.innerText,
          statSafe: document.getElementById('stat-safe')?.innerText,
          statLow: document.getElementById('stat-low')?.innerText,
          statOut: document.getElementById('stat-out')?.innerText,
          thresholdBanner: document.getElementById('threshold-banner')?.innerText
        };
      })()
    `);
    console.log('  Thông tin Tồn kho:', invInfo);
    assert.strictEqual(invInfo.activeLink, 'Tồn kho');
    await captureScreenshot(ws, 'admin_inventory_1440px.png');

    // 5. Kiểm tra Trang 4: Hóa đơn (/invoices)
    console.log('\n5. Kiểm tra Trang Hóa đơn (/invoices)...');
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/invoices` });
    await sleep(1500);

    const invoiceInfo = await evalInBrowser(ws, `
      (() => {
        const table = document.getElementById('invoices-table');
        const thead = table?.querySelector('thead');
        return {
          title: document.title,
          activeLink: document.querySelector('.pos-manager-sidebar .nav-link.active')?.innerText.trim(),
          theadClasses: thead?.className,
          isNotTableDark: !thead?.classList.contains('table-dark'),
          hasSellerFilter: document.getElementById('seller-filter-container')?.style.display !== 'none'
        };
      })()
    `);
    console.log('  Thông tin Hóa đơn:', invoiceInfo);
    assert.strictEqual(invoiceInfo.activeLink, 'Hóa đơn');
    assert.ok(invoiceInfo.isNotTableDark, 'Bảng hóa đơn không dùng table-dark');
    await captureScreenshot(ws, 'admin_invoices_1440px.png');

    // 6. Kiểm tra Trang 5: Tài khoản nhân viên (/employees)
    console.log('\n6. Kiểm tra Trang Tài khoản nhân viên (/employees)...');
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/employees` });
    await sleep(1500);

    const empInfo = await evalInBrowser(ws, `
      (() => {
        const rows = document.querySelectorAll('#employees-table tbody tr');
        return {
          title: document.title,
          activeLink: document.querySelector('.pos-manager-sidebar .nav-link.active')?.innerText.trim(),
          rowCount: rows.length,
          hasActionDropdown: !!document.querySelector('#employees-table tbody tr .dropdown')
        };
      })()
    `);
    console.log('  Thông tin Nhân viên:', empInfo);
    assert.strictEqual(empInfo.activeLink, 'Tài khoản nhân viên');
    await captureScreenshot(ws, 'admin_employees_1440px.png');

    // 7. Kiểm tra Trang 6: Nhập hàng (/stock-receipts)
    console.log('\n7. Kiểm tra Trang Nhập hàng (/stock-receipts)...');
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/stock-receipts` });
    await sleep(1500);

    const receiptInfo = await evalInBrowser(ws, `
      (() => {
        return {
          title: document.title,
          activeLink: document.querySelector('.pos-manager-sidebar .nav-link.active')?.innerText.trim(),
          btnResetFormText: document.getElementById('btn-reset-form')?.innerText.trim(),
          btnAddItemText: document.getElementById('btn-add-item')?.innerText.trim()
        };
      })()
    `);
    console.log('  Thông tin Nhập hàng:', receiptInfo);
    assert.strictEqual(receiptInfo.activeLink, 'Nhập hàng');
    await captureScreenshot(ws, 'admin_stock_receipts_1440px.png');

    // 8. Kiểm tra Trang 7: Bán hàng (/sales)
    console.log('\n8. Kiểm tra Trang Bán hàng (/sales)...');
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/sales` });
    await sleep(1500);

    const salesInfo = await evalInBrowser(ws, `
      (() => {
        const qtyEl = document.getElementById('s-qty');
        const checkoutBtn = document.getElementById('btn-checkout');
        const totalEl = document.getElementById('s-total');
        const pmCash = document.getElementById('pm-cash');
        const pmQr = document.getElementById('pm-qr');
        return {
          title: document.title,
          activeLink: document.querySelector('.pos-manager-sidebar .nav-link.active')?.innerText.trim(),
          qtyPlaceholder: qtyEl?.placeholder,
          qtyValue: qtyEl?.value,
          totalText: totalEl?.innerText,
          checkoutBtnDisabled: checkoutBtn?.disabled,
          checkoutBtnText: checkoutBtn?.innerText.trim(),
          cashChecked: pmCash?.checked,
          qrChecked: pmQr?.checked
        };
      })()
    `);
    console.log('  Thông tin Bán hàng:', salesInfo);
    assert.strictEqual(salesInfo.activeLink, 'Bán hàng');
    assert.strictEqual(salesInfo.qtyValue, '', 'Ô số lượng phải để trống ban đầu');
    assert.strictEqual(salesInfo.qtyPlaceholder, 'Nhập số lượng');
    await captureScreenshot(ws, 'admin_sales_1440px.png');

    // Thử đổi sang QR và xem nút đổi nhãn
    console.log('  Thử đổi phương thức sang Chuyển khoản QR...');
    await evalInBrowser(ws, `
      (() => {
        const qrRadio = document.getElementById('pm-qr');
        if (qrRadio) {
          qrRadio.checked = true;
          onPaymentMethodChange();
        }
      })()
    `);
    await sleep(400);

    const qrBtnText = await evalInBrowser(ws, `document.getElementById('btn-checkout')?.innerText.trim()`);
    console.log('  Nhãn nút sau khi chọn QR:', qrBtnText);
    assert.ok(qrBtnText.includes('QR'), 'Nút phải đổi sang nhãn liên quan đến QR');

    // Đổi lại Tiền mặt
    await evalInBrowser(ws, `
      (() => {
        const cashRadio = document.getElementById('pm-cash');
        if (cashRadio) {
          cashRadio.checked = true;
          onPaymentMethodChange();
        }
      })()
    `);
    await sleep(400);

    // 9. Kiểm tra Responsive 4 độ phân giải: 1440px, 1024px, 768px, 390px
    console.log('\n9. Kiểm tra hiển thị đa kích thước màn hình...');
    
    // 1024px
    console.log('  • 1024px (Tablet ngang)...');
    await setViewport(ws, 1024, 800);
    await captureScreenshot(ws, 'responsive_1024px_dashboard.png');

    // 768px
    console.log('  • 768px (Tablet dọc)...');
    await setViewport(ws, 768, 1024);
    await captureScreenshot(ws, 'responsive_768px_dashboard.png');

    // 390px
    console.log('  • 390px (Mobile)...');
    await setViewport(ws, 390, 844);
    
    // Kiểm tra mobile drawer
    const mobileMenuState = await evalInBrowser(ws, `
      (() => {
        const sidebar = document.getElementById('posManagerSidebar');
        const toggleBtn = document.getElementById('btn-mobile-sidebar-toggle');
        const isSidebarVisibleBefore = window.getComputedStyle(sidebar).transform !== 'none';
        return {
          hasToggleBtn: !!toggleBtn,
          toggleBtnVisible: window.getComputedStyle(toggleBtn).display !== 'none'
        };
      })()
    `);
    console.log('  Trạng thái nút toggle mobile trên 390px:', mobileMenuState);
    assert.ok(mobileMenuState.hasToggleBtn, 'Phải có nút toggle mobile');
    assert.ok(mobileMenuState.toggleBtnVisible, 'Nút toggle mobile phải hiển thị trên màn hình nhỏ');

    await captureScreenshot(ws, 'responsive_390px_mobile.png');

    // Bấm mở menu drawer trên mobile
    console.log('  Mở drawer menu trên mobile 390px...');
    await evalInBrowser(ws, `document.getElementById('btn-mobile-sidebar-toggle')?.click()`);
    await sleep(500);

    const isDrawerOpen = await evalInBrowser(ws, `document.getElementById('posManagerSidebar')?.classList.contains('show')`);
    console.log('  Drawer menu mobile đã mở:', isDrawerOpen);
    assert.ok(isDrawerOpen, 'Sidebar phải có class show khi bấm nút toggle trên mobile');
    await captureScreenshot(ws, 'responsive_390px_mobile_drawer_open.png');

    // Đóng drawer
    await evalInBrowser(ws, `document.getElementById('posSidebarBackdrop')?.click()`);
    await sleep(300);

    console.log('\n=== TẤT CẢ KIỂM THỬ TRÌNH DUYỆT ĐỀU THÀNH CÔNG VÀ LƯU ẢNH CHỤP ĐẦY ĐỦ! ===');
  } finally {
    chromeProcess.kill();
  }
}

run().catch(err => {
  console.error('LỖI KIỂM THỬ:', err);
  process.exit(1);
});
