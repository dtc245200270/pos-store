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
  console.log('=== BẮT ĐẦU KIỂM THỬ XEM CHI TIẾT PHIẾU NHẬP PN_167345 ===\n');

  // 1. Đăng nhập Manager
  console.log('--- Bước 1: Đăng nhập Manager ---');
  let csrfRes = await req('GET', '/api/auth/csrf');
  let loginRes = await req('POST', '/api/auth/login', {
    username: 'manager',
    password: process.env.MANAGER_INITIAL_PASSWORD || 'VeryStrongPass123!@#'
  }, csrfRes.cookie, csrfRes.data.csrfToken);

  if (loginRes.status !== 200) {
    throw new Error('Đăng nhập thất bại: ' + JSON.stringify(loginRes.data));
  }
  const cookie = loginRes.cookie;
  console.log('✓ Đăng nhập thành công với vai trò: MANAGER');

  // 2. Tìm phiếu PN_167345 trong danh sách lịch sử
  console.log('\n--- Bước 2: Kiểm tra phiếu PN_167345 trong danh sách lịch sử ---');
  const historyRes = await req('GET', '/api/stock-receipts', null, cookie);
  if (historyRes.status !== 200) {
    throw new Error('Lỗi tải danh sách phiếu nhập: ' + JSON.stringify(historyRes.data));
  }

  const receipt = historyRes.data.find(r => r.receipt_no === 'PN_167345');
  if (!receipt) {
    throw new Error('Không tìm thấy phiếu PN_167345 trong cơ sở dữ liệu!');
  }
  console.log(`✓ Tìm thấy phiếu PN_167345: ID = ${receipt.id}, Tổng tiền = ${Number(receipt.total_amount).toLocaleString('vi-VN')} đ, Người tạo = ${receipt.created_by_name}`);

  // 3. Gọi API GET /api/stock-receipts/:id
  console.log('\n--- Bước 3: Kiểm tra API GET /api/stock-receipts/' + receipt.id + ' ---');
  const detailRes = await req('GET', `/api/stock-receipts/${receipt.id}`, null, cookie);
  console.log(`✓ Kết quả API: HTTP ${detailRes.status}`);
  if (detailRes.status !== 200) {
    throw new Error('API GET chi tiết thất bại: ' + JSON.stringify(detailRes.data));
  }

  const r = detailRes.data.receipt;
  const items = detailRes.data.items;

  console.log('\n--- Bước 4: Đối chiếu cấu trúc JSON Backend với yêu cầu Modal ---');
  console.log('1. Thông tin chung phiếu nhập:');
  console.log(`   - Mã phiếu: ${r.receipt_no}`);
  console.log(`   - Ngày lập: ${new Date(r.created_at).toLocaleString('vi-VN')}`);
  console.log(`   - Người lập: ${r.created_by_name}`);
  console.log(`   - Tổng tiền: ${Number(r.total_amount).toLocaleString('vi-VN')} đ`);

  if (!r.receipt_no || !r.created_at || !r.created_by_name || Number(r.total_amount) !== 150000) {
    throw new Error('Thông tin phiếu nhập không đầy đủ hoặc sai số tiền!');
  }

  console.log('2. Chi tiết các sản phẩm trong phiếu:');
  if (!items || items.length === 0) {
    throw new Error('Phiếu nhập không có mặt hàng nào!');
  }

  items.forEach((it, idx) => {
    const lineTotal = Number(it.quantity) * Number(it.unit_cost);
    console.log(`   [Mặt hàng ${idx + 1}]`);
    console.log(`     - SKU: ${it.sku}`);
    console.log(`     - Tên sản phẩm: ${it.product_name_snapshot}`);
    console.log(`     - Đơn vị tính: ${it.unit_snapshot}`);
    console.log(`     - Số lượng: ${it.quantity}`);
    console.log(`     - Giá nhập: ${Number(it.unit_cost).toLocaleString('vi-VN')} đ`);
    console.log(`     - Thành tiền: ${Number(lineTotal).toLocaleString('vi-VN')} đ`);

    if (!it.sku || it.sku !== 'BUTBI01') {
      throw new Error('Thiếu hoặc sai trường SKU trong chi tiết mặt hàng: ' + it.sku);
    }
    if (it.product_name_snapshot !== 'Bút bi Thiên Long') {
      throw new Error('Sai tên sản phẩm: ' + it.product_name_snapshot);
    }
    if (it.quantity !== 10 || Number(it.unit_cost) !== 15000 || lineTotal !== 150000) {
      throw new Error('Sai số lượng, đơn giá hoặc thành tiền!');
    }
  });

  // 4. Kiểm tra trường hợp tải thất bại (ID không tồn tại)
  console.log('\n--- Bước 5: Kiểm tra khi tải thất bại (ID = 999999) ---');
  const notFoundRes = await req('GET', '/api/stock-receipts/999999', null, cookie);
  console.log(`✓ Kết quả ID không tồn tại: HTTP ${notFoundRes.status} - Lỗi: "${notFoundRes.data.error}"`);
  if (notFoundRes.status !== 404 || notFoundRes.data.error !== 'Không tìm thấy phiếu nhập') {
    throw new Error('Kỳ vọng lỗi 404 "Không tìm thấy phiếu nhập" nhưng nhận được: ' + JSON.stringify(notFoundRes.data));
  }

  // 5. Kiểm tra file HTML & JS: Đảm bảo có Bootstrap JS, modal và các hàm xử lý
  console.log('\n--- Bước 6: Kiểm tra tài nguyên Frontend (Bootstrap JS & Modal) ---');
  const htmlContent = require('fs').readFileSync('views/stock-receipts.html', 'utf-8');
  if (!htmlContent.includes('bootstrap.bundle.min.js')) {
    throw new Error('views/stock-receipts.html chưa nhúng bootstrap.bundle.min.js');
  }
  if (!htmlContent.includes('id="receipt-detail-modal"')) {
    throw new Error('views/stock-receipts.html thiếu modal #receipt-detail-modal');
  }
  console.log('✓ views/stock-receipts.html đã nhúng Bootstrap JS và cấu hình modal đầy đủ.');

  const jsContent = require('fs').readFileSync('public/js/stock-receipts.js', 'utf-8');
  if (!jsContent.includes('openReceiptModal') || !jsContent.includes('closeReceiptModal') || !jsContent.includes('viewReceiptDetails')) {
    throw new Error('public/js/stock-receipts.js thiếu các hàm mở/đóng và xem chi tiết modal');
  }
  console.log('✓ public/js/stock-receipts.js có đầy đủ hàm viewReceiptDetails, openReceiptModal, closeReceiptModal.');

  console.log('\n=== TẤT CẢ KIỂM THỬ TRÊN PHIẾU PN_167345 ĐÃ THÀNH CÔNG RỰC RỠ 100%! ===');
}

run().catch(err => {
  console.error('LỖI KIỂM THỬ:', err);
  process.exit(1);
});
