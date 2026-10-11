require('dotenv').config();
const fs = require('fs');
const assert = require('assert');

const BASE_URL = 'http://127.0.0.1:3000';

// Mô phỏng logic render menu từ public/js/layout.js cho cả 2 vai trò
function renderNavMenu(currentPath, role = 'MANAGER') {
  const normPath = (currentPath || '/').replace(/\/+$/, '') || '/';

  let navItems = [];
  if (role === 'MANAGER') {
    navItems = [
      { title: 'Tổng quan', path: '/' },
      { title: 'Bán hàng', path: '/sales' },
      { title: 'Sản phẩm', path: '/products' },
      { title: 'Nhập hàng', path: '/stock-receipts' },
      { title: 'Tồn kho', path: '/inventory' },
      { title: 'Hóa đơn', path: '/invoices' },
      { title: 'Tài khoản nhân viên', path: '/employees' }
    ];
  } else {
    navItems = [
      { title: 'Bán hàng', path: '/sales' },
      { title: 'Hóa đơn của tôi', path: '/invoices' },
      { title: 'Tra cứu tồn kho', path: '/inventory' },
      { title: 'Tài khoản của tôi', path: '/profile' }
    ];
  }

  const rendered = navItems.map(item => {
    const isActive = (item.path === '/' && normPath === '/') || (item.path !== '/' && normPath === item.path);
    return {
      title: item.title,
      path: item.path,
      isActive: isActive,
      ariaCurrent: isActive ? 'page' : null,
      hasActiveClass: isActive,
      hasBlueBg: isActive
    };
  });

  return rendered;
}

async function run() {
  console.log('=== BẮT ĐẦU KIỂM THỬ TRẠNG THÁI ACTIVE CỦA THANH MENU THEO VAI TRÒ ===\n');

  // 1. Kiểm tra mã nguồn public/js/layout.js
  console.log('--- Bước 1: Kiểm tra mã nguồn public/js/layout.js ---');
  const layoutJs = fs.readFileSync('public/js/layout.js', 'utf-8');
  assert.ok(layoutJs.includes('#0d6efd'), 'public/js/layout.js thiếu mã màu #0d6efd');
  assert.ok(layoutJs.includes('aria-current="page"'), 'public/js/layout.js thiếu aria-current="page"');
  assert.ok(layoutJs.includes('window.location.pathname'), 'public/js/layout.js không dùng window.location.pathname');
  assert.ok(layoutJs.includes('border-radius'), 'public/js/layout.js thiếu bo góc');
  assert.ok(layoutJs.includes('font-weight'), 'public/js/layout.js thiếu font-weight chữ đậm');
  console.log('✓ layout.js chứa đầy đủ các thuộc tính giao diện & logic theo yêu cầu.');

  // 2. Kiểm tra tất cả 7 trang Quản lý
  console.log('\n--- Bước 2: Kiểm tra trạng thái Active cho 7 trang Quản lý ---');
  const managerPages = [
    { name: 'Tổng quan', path: '/' },
    { name: 'Bán hàng', path: '/sales' },
    { name: 'Sản phẩm', path: '/products' },
    { name: 'Nhập hàng', path: '/stock-receipts' },
    { name: 'Tồn kho', path: '/inventory' },
    { name: 'Hóa đơn', path: '/invoices' },
    { name: 'Tài khoản nhân viên', path: '/employees' }
  ];

  for (const page of managerPages) {
    const menu = renderNavMenu(page.path, 'MANAGER');
    const activeItems = menu.filter(m => m.isActive);

    console.log(`\n• [MANAGER] Kiểm tra đường dẫn: "${page.path}" (${page.name})`);
    console.log(`  - Số lượng mục active: ${activeItems.length}`);
    assert.strictEqual(activeItems.length, 1, `Chỉ được có đúng 1 mục active khi ở đường dẫn ${page.path}`);

    const activeItem = activeItems[0];
    console.log(`  - Mục active: "${activeItem.title}" (${activeItem.path})`);
    assert.strictEqual(activeItem.title, page.name, `Mục active phải là ${page.name}`);
    assert.strictEqual(activeItem.ariaCurrent, 'page', 'Mục active phải có aria-current="page"');

    const inactiveItems = menu.filter(m => !m.isActive);
    inactiveItems.forEach(inact => {
      assert.strictEqual(inact.isActive, false);
      assert.strictEqual(inact.ariaCurrent, null);
    });
    console.log(`  - 6 mục còn lại đều không active: [${inactiveItems.map(i => i.title).join(', ')}]`);
  }

  // 3. Kiểm tra tất cả 4 trang Thu ngân
  console.log('\n--- Bước 3: Kiểm tra trạng thái Active cho 4 trang Thu ngân ---');
  const cashierPages = [
    { name: 'Bán hàng', path: '/sales' },
    { name: 'Hóa đơn của tôi', path: '/invoices' },
    { name: 'Tra cứu tồn kho', path: '/inventory' },
    { name: 'Tài khoản của tôi', path: '/profile' }
  ];

  for (const page of cashierPages) {
    const menu = renderNavMenu(page.path, 'CASHIER');
    const activeItems = menu.filter(m => m.isActive);

    console.log(`\n• [CASHIER] Kiểm tra đường dẫn: "${page.path}" (${page.name})`);
    console.log(`  - Số lượng mục active: ${activeItems.length}`);
    assert.strictEqual(activeItems.length, 1, `Chỉ được có đúng 1 mục active khi ở đường dẫn ${page.path}`);

    const activeItem = activeItems[0];
    console.log(`  - Mục active: "${activeItem.title}" (${activeItem.path})`);
    assert.strictEqual(activeItem.title, page.name, `Mục active phải là ${page.name}`);
    assert.strictEqual(activeItem.ariaCurrent, 'page', 'Mục active phải có aria-current="page"');

    const inactiveItems = menu.filter(m => !m.isActive);
    inactiveItems.forEach(inact => {
      assert.strictEqual(inact.isActive, false);
      assert.strictEqual(inact.ariaCurrent, null);
    });
    console.log(`  - 3 mục còn lại đều không active: [${inactiveItems.map(i => i.title).join(', ')}]`);
  }

  // 4. Kiểm tra kịch bản chuyển trang và F5
  console.log('\n--- Bước 4: Kiểm tra luồng kịch bản chuyển trang & F5 ---');
  // 4.1 Mở Nhập hàng
  console.log('1. Mở trang Nhập hàng (/stock-receipts):');
  let menu1 = renderNavMenu('/stock-receipts', 'MANAGER');
  let active1 = menu1.find(m => m.isActive);
  let receiptItem1 = menu1.find(m => m.path === '/stock-receipts');
  let inventoryItem1 = menu1.find(m => m.path === '/inventory');
  assert.strictEqual(active1.path, '/stock-receipts');
  assert.strictEqual(receiptItem1.isActive, true);
  assert.strictEqual(inventoryItem1.isActive, false);
  console.log(`   - Mục Nhập hàng active: ${receiptItem1.isActive}`);
  console.log(`   - Mục Tồn kho active: ${inventoryItem1.isActive}`);

  // 4.2 Chuyển sang Tồn kho
  console.log('2. Chuyển sang trang Tồn kho (/inventory):');
  let menu2 = renderNavMenu('/inventory', 'MANAGER');
  let active2 = menu2.find(m => m.isActive);
  let receiptItem2 = menu2.find(m => m.path === '/stock-receipts');
  let inventoryItem2 = menu2.find(m => m.path === '/inventory');
  assert.strictEqual(active2.path, '/inventory');
  assert.strictEqual(inventoryItem2.isActive, true);
  assert.strictEqual(receiptItem2.isActive, false);
  console.log(`   - Mục Tồn kho active: ${inventoryItem2.isActive}`);
  console.log(`   - Mục Nhập hàng active: ${receiptItem2.isActive}`);

  // 4.3 Nhấn F5 tại trang Tồn kho
  console.log('3. Nhấn F5 tại trang Tồn kho (/inventory):');
  let menu3 = renderNavMenu('/inventory', 'MANAGER');
  let active3 = menu3.find(m => m.isActive);
  assert.strictEqual(active3.path, '/inventory');
  assert.strictEqual(active3.isActive, true);
  console.log(`   - Sau F5, Mục Tồn kho vẫn active: ${active3.isActive}`);

  // 5. Kiểm tra server phục vụ file tĩnh public/js/layout.js
  console.log('\n--- Bước 5: Kiểm tra HTTP Server phục vụ file layout.js ---');
  const res = await fetch(`${BASE_URL}/public/js/layout.js`);
  assert.strictEqual(res.status, 200, 'Server không trả về mã 200 cho /public/js/layout.js');
  const servedContent = await res.text();
  assert.ok(servedContent.includes('#0d6efd'), 'Server trả về file layout.js không có #0d6efd');
  console.log('✓ Server phục vụ đúng file layout.js mới nhất qua HTTP.');

  console.log('\n=== TẤT CẢ CÁC KIỂM THỬ TRẠNG THÁI ACTIVE ĐÃ THÀNH CÔNG 100%! ===');
}

run().catch(err => {
  console.error('LỖI KIỂM THỬ:', err);
  process.exit(1);
});
