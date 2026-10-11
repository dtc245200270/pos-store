require('dotenv').config();

const BASE_URL = 'http://127.0.0.1:3000';

async function req(method, path, body = null, cookie = '', csrf = '') {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;

  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`${BASE_URL}${path}`, options);

  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  let newCookie = cookie;
  if (setCookies && setCookies.length > 0) {
    newCookie = setCookies.map(c => c.split(';')[0]).join('; ');
  }

  let data;
  const text = await res.text();
  try { data = JSON.parse(text); } catch { data = text; }

  return { status: res.status, data, cookie: newCookie };
}

async function run() {
  console.log('=== BẮT ĐẦU KIỂM THỬ THỰC TẾ LẬP PHIẾU NHẬP ===\n');

  // 1. Lấy CSRF token ban đầu
  console.log('--- Bước 1: Lấy CSRF Token & Đăng nhập Manager ---');
  let csrfRes = await req('GET', '/api/auth/csrf');
  if (csrfRes.status !== 200) throw new Error('Không lấy được CSRF token: ' + JSON.stringify(csrfRes.data));
  let initialCsrf = csrfRes.data.csrfToken;
  let initialCookie = csrfRes.cookie;
  console.log('✓ Initial CSRF Token:', initialCsrf);

  // Đăng nhập
  let loginRes = await req('POST', '/api/auth/login', {
    username: 'manager',
    password: process.env.MANAGER_INITIAL_PASSWORD || 'VeryStrongPass123!@#'
  }, initialCookie, initialCsrf);

  if (loginRes.status !== 200) {
    throw new Error('Đăng nhập thất bại: ' + JSON.stringify(loginRes.data));
  }
  const managerCookie = loginRes.cookie;
  console.log('✓ Đăng nhập thành công với vai trò:', loginRes.data.role);

  // Lấy CSRF token sau đăng nhập
  let csrfAfterLogin = await req('GET', '/api/auth/csrf', null, managerCookie);
  const managerCsrf = csrfAfterLogin.data.csrfToken;
  console.log('✓ Manager CSRF Token sau đăng nhập:', managerCsrf);

  // 2. Kiểm tra tồn kho trước khi nhập (Sản phẩm ID 8 / BUTBI01)
  console.log('\n--- Bước 2: Kiểm tra sản phẩm và tồn kho trước khi nhập ---');
  const productsBefore = await req('GET', '/api/products', null, managerCookie);
  const targetProduct = productsBefore.data.find(p => p.id === 8 || p.sku === 'BUTBI01');
  if (!targetProduct) {
    throw new Error('Không tìm thấy sản phẩm BUTBI01');
  }
  const initialStock = Number(targetProduct.stock_quantity);
  console.log(`✓ Sản phẩm ID ${targetProduct.id}: "${targetProduct.name}" (SKU: ${targetProduct.sku})`);
  console.log(`✓ Tồn kho ban đầu = ${initialStock}`);

  // 3. Kiểm tra trường hợp lưu thất bại: Giữ nguyên phiếu và hiển thị lỗi
  console.log('\n--- Bước 3: Kiểm tra khi Lưu thất bại (Dữ liệu không hợp lệ) ---');
  const failRes = await req('POST', '/api/stock-receipts', {
    receipt_no: 'PN_TEST_FAIL',
    request_key: 'req-fail-' + Date.now(),
    items: [{ product_id: targetProduct.id, quantity: -5, unit_cost: 15000 }]
  }, managerCookie, managerCsrf);

  console.log(`✓ Kết quả khi gửi dữ liệu lỗi: HTTP ${failRes.status} - Lỗi: "${failRes.data.error}"`);
  if (failRes.status !== 400) {
    throw new Error('Mong muốn HTTP 400 nhưng nhận được: ' + failRes.status);
  }

  // Tồn kho phải giữ nguyên không đổi
  const productsAfterFail = await req('GET', '/api/products', null, managerCookie);
  const pAfterFail = productsAfterFail.data.find(p => p.id === targetProduct.id);
  console.log(`✓ Tồn kho sau khi lưu thất bại vẫn giữ nguyên: ${pAfterFail.stock_quantity}`);
  if (pAfterFail.stock_quantity !== initialStock) {
    throw new Error('Tồn kho bị thay đổi sai quy định khi lưu thất bại!');
  }

  // 4. Lưu phiếu nhập hàng hợp lệ (Sản phẩm: BUTBI01, Số lượng: 10, Giá nhập: 15.000, Tổng: 150.000)
  console.log('\n--- Bước 4: Lưu phiếu nhập hợp lệ (SL: 10, Giá: 15.000đ, Tổng: 150.000đ) ---');
  const receiptNo = 'PN_' + Date.now().toString().slice(-6);
  const reqKey = 'req-success-' + Date.now();
  const saveRes = await req('POST', '/api/stock-receipts', {
    receipt_no: receiptNo,
    request_key: reqKey,
    items: [{
      product_id: targetProduct.id,
      quantity: 10,
      unit_cost: 15000
    }]
  }, managerCookie, managerCsrf);

  console.log(`✓ Kết quả lưu phiếu: HTTP ${saveRes.status} - ${JSON.stringify(saveRes.data)}`);
  if (saveRes.status !== 201) {
    throw new Error('Lưu phiếu thất bại: ' + JSON.stringify(saveRes.data));
  }
  const createdReceiptId = saveRes.data.id;

  // 5. Kiểm tra Lịch sử nhập hàng (/api/stock-receipts)
  console.log('\n--- Bước 5: Kiểm tra Lịch sử nhập hàng ---');
  const historyRes = await req('GET', '/api/stock-receipts', null, managerCookie);
  const foundReceipt = historyRes.data.find(r => r.id === createdReceiptId || r.receipt_no === receiptNo);
  if (!foundReceipt) {
    throw new Error('Không tìm thấy phiếu nhập trong lịch sử');
  }
  console.log(`✓ Đã tìm thấy trong lịch sử: Mã = ${foundReceipt.receipt_no}, Tổng tiền = ${Number(foundReceipt.total_amount).toLocaleString('vi-VN')} đ, Người tạo = ${foundReceipt.created_by_name}`);

  // Chi tiết phiếu nhập
  const detailRes = await req('GET', '/api/stock-receipts/' + createdReceiptId, null, managerCookie);
  console.log(`✓ Chi tiết phiếu nhập: ${detailRes.data.items.length} mặt hàng`);
  detailRes.data.items.forEach(it => {
    console.log(`   - Tên snapshot: "${it.product_name_snapshot}" | Đơn vị: "${it.unit_snapshot}" | SL: ${it.quantity} | Đơn giá: ${Number(it.unit_cost).toLocaleString('vi-VN')} đ | Tổng: ${Number(it.quantity * it.unit_cost).toLocaleString('vi-VN')} đ`);
  });

  // 6. Kiểm tra Tồn kho (/api/products & /api/inventory)
  console.log('\n--- Bước 6: Kiểm tra Tồn kho & Biến động kho ---');
  const inventoryRes = await req('GET', '/api/inventory', null, managerCookie);
  const pInventory = inventoryRes.data.find(p => p.id === targetProduct.id);
  const expectedStock = initialStock + 10;
  console.log(`✓ Tồn kho trên trang Inventory của "${pInventory.name}": ${pInventory.stock_quantity} (Kỳ vọng: ${expectedStock})`);
  if (pInventory.stock_quantity !== expectedStock) {
    throw new Error(`Tồn kho không chính xác! Kỳ vọng ${expectedStock}, thực tế ${pInventory.stock_quantity}`);
  }

  // Biến động kho
  const movementsRes = await req('GET', `/api/inventory/${targetProduct.id}/movements`, null, managerCookie);
  const latestMovement = movementsRes.data[0];
  console.log(`✓ Biến động kho mới nhất: Loại: Nhập, Thay đổi: +${latestMovement.quantity_delta}, Tồn sau biến động: ${latestMovement.balance_after}, Số chứng từ: ${latestMovement.receipt_no}`);

  console.log('\n=== TẤT CẢ CÁC BƯỚC KIỂM THỬ ĐÃ HOÀN TẤT VÀ THÀNH CÔNG 100%! ===');
}

run().catch(err => {
  console.error('LỖI KIỂM THỬ:', err);
  process.exit(1);
});
