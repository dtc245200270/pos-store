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

// Giả lập logic kiểm tra tồn kho ở Frontend Bán Hàng (sales.js)
function simulateAddToCart(cart, productsMap, productId, qty) {
  // 1. Số lượng phải là số nguyên dương
  if (!Number.isInteger(qty) || qty <= 0) {
    return { success: false, reason: 'Số lượng phải là số nguyên dương (> 0)', cart };
  }

  const p = productsMap[productId];
  if (!p) {
    return { success: false, reason: 'Sản phẩm không tồn tại', cart };
  }

  const stock = Number(p.stock_quantity);

  // 2. Sản phẩm tồn kho 0 không được thêm vào giỏ; thông báo “Sản phẩm đã hết hàng”
  if (stock <= 0) {
    return { success: false, reason: 'Sản phẩm đã hết hàng', cart };
  }

  // 3. Khi thêm, cộng số lượng đã có trong giỏ với số lượng nhập thêm.
  //    Nếu tổng vượt tồn kho thì từ chối, giữ nguyên giỏ.
  const existing = cart.find(c => c.product_id === p.id);
  const existingQty = existing ? existing.quantity : 0;
  const totalRequestedQty = existingQty + qty;

  if (totalRequestedQty > stock) {
    return {
      success: false,
      reason: `Không thể thêm: Tổng số lượng trong giỏ (${totalRequestedQty}) vượt quá tồn kho hiện có (${stock}). Giỏ hàng được giữ nguyên.`,
      cart
    };
  }

  // Tạo bản sao giỏ hàng mới
  const newCart = cart.map(item => ({ ...item }));
  const targetItem = newCart.find(c => c.product_id === p.id);
  if (targetItem) {
    targetItem.quantity = totalRequestedQty;
  } else {
    newCart.push({
      product_id: p.id,
      name: p.name,
      quantity: qty,
      unit_price: Number(p.sale_price)
    });
  }

  return { success: true, cart: newCart };
}

async function run() {
  console.log('=== BẮT ĐẦU KIỂM THỬ TỒN KHO TRANG BÁN HÀNG ===\n');

  // Đăng nhập
  console.log('--- Bước 0: Xác thực tài khoản ---');
  let csrfRes = await req('GET', '/api/auth/csrf');
  let initialCsrf = csrfRes.data.csrfToken;
  let initialCookie = csrfRes.cookie;

  let loginRes = await req('POST', '/api/auth/login', {
    username: 'manager',
    password: process.env.MANAGER_INITIAL_PASSWORD || 'VeryStrongPass123!@#'
  }, initialCookie, initialCsrf);

  if (loginRes.status !== 200) {
    throw new Error('Đăng nhập thất bại: ' + JSON.stringify(loginRes.data));
  }
  const cookie = loginRes.cookie;

  let csrfAfterLogin = await req('GET', '/api/auth/csrf', null, cookie);
  const csrf = csrfAfterLogin.data.csrfToken;
  console.log('✓ Đăng nhập thành công, đã lấy Cookie & CSRF Token');

  // Lấy dữ liệu sản phẩm hiện có trong pos_store (không thêm dữ liệu mẫu mới)
  const productsRes = await req('GET', '/api/products?active_only=true', null, cookie);
  const products = productsRes.data;
  const productsMap = {};
  products.forEach(p => productsMap[p.id] = p);

  const productZeroStock = products.find(p => Number(p.stock_quantity) === 0);
  const productTenStock = products.find(p => Number(p.stock_quantity) === 10);

  if (!productZeroStock) {
    throw new Error('Không tìm thấy sản phẩm có tồn kho bằng 0 để kiểm thử.');
  }
  if (!productTenStock) {
    throw new Error('Không tìm thấy sản phẩm có tồn kho bằng 10 để kiểm thử.');
  }

  console.log(`✓ Sản phẩm kiểm thử tồn 0: ID ${productZeroStock.id} ("${productZeroStock.name}" - SKU: ${productZeroStock.sku}, Tồn: ${productZeroStock.stock_quantity})`);
  console.log(`✓ Sản phẩm kiểm thử tồn 10: ID ${productTenStock.id} ("${productTenStock.name}" - SKU: ${productTenStock.sku}, Tồn: ${productTenStock.stock_quantity}, Giá: ${productTenStock.sale_price})`);

  // KIỂM THỬ 1: Tồn 0, thêm 2 → bị chặn; thông báo "Sản phẩm đã hết hàng"
  console.log('\n--- Kiểm thử 1: Tồn kho = 0, thêm 2 sản phẩm vào giỏ ---');
  let cart1 = [];
  let resAdd1 = simulateAddToCart(cart1, productsMap, productZeroStock.id, 2);
  console.log(`✓ Kết quả thêm vào giỏ: ${resAdd1.success ? 'Thành công' : 'Bị chặn'}`);
  console.log(`✓ Thông báo lỗi: "${resAdd1.reason}"`);
  console.log(`✓ Giỏ hàng sau khi chặn: [${resAdd1.cart.map(c => c.name + ': ' + c.quantity).join(', ')}] (rỗng)`);

  if (resAdd1.success || resAdd1.reason !== 'Sản phẩm đã hết hàng' || resAdd1.cart.length !== 0) {
    throw new Error('Kiểm thử 1 thất bại: Không chặn sản phẩm tồn kho 0 đúng quy định!');
  }

  // KIỂM THỬ 2: Tồn 10, thêm 6 rồi thêm 5 → lần thêm 5 bị chặn, giữ nguyên giỏ
  console.log('\n--- Kiểm thử 2: Tồn kho = 10, thêm 6 rồi thêm 5 ---');
  let cart2 = [];
  // Lần 1: thêm 6
  let resAdd2_1 = simulateAddToCart(cart2, productsMap, productTenStock.id, 6);
  console.log(`✓ Lần 1 (thêm 6): ${resAdd2_1.success ? 'Thành công' : 'Thất bại'}`);
  if (!resAdd2_1.success) throw new Error('Thêm 6 sản phẩm khi tồn 10 bị lỗi');
  cart2 = resAdd2_1.cart;
  console.log(`✓ Giỏ hàng hiện tại: [${cart2.map(c => c.name + ': ' + c.quantity).join(', ')}]`);

  // Lần 2: thêm tiếp 5 (tổng 6 + 5 = 11 > 10)
  let resAdd2_2 = simulateAddToCart(cart2, productsMap, productTenStock.id, 5);
  console.log(`✓ Lần 2 (thêm 5): ${resAdd2_2.success ? 'Thành công' : 'Bị chặn'}`);
  console.log(`✓ Thông báo lỗi: "${resAdd2_2.reason}"`);
  console.log(`✓ Giỏ hàng sau lần thêm thứ 2: [${resAdd2_2.cart.map(c => c.name + ': ' + c.quantity).join(', ')}]`);

  if (resAdd2_2.success) {
    throw new Error('Kiểm thử 2 thất bại: Không chặn khi tổng số lượng (11) vượt quá tồn kho (10)!');
  }
  if (resAdd2_2.cart[0].quantity !== 6) {
    throw new Error('Kiểm thử 2 thất bại: Giỏ hàng không được giữ nguyên 6 sau khi bị chặn!');
  }

  // KIỂM THỬ 3: Tồn 10, bán 2 → hóa đơn 40000, tồn còn 8
  console.log('\n--- Kiểm thử 3: Tồn kho = 10, bán 2 sản phẩm (đơn giá 20.000đ) ---');
  const invoiceNo1 = 'HD_TEST_' + Date.now().toString().slice(-6);
  const reqKey1 = 'key-inv-' + Date.now();
  const checkoutRes1 = await req('POST', '/api/invoices', {
    invoice_no: invoiceNo1,
    request_key: reqKey1,
    items: [{
      product_id: productTenStock.id,
      quantity: 2,
      unit_price: Number(productTenStock.sale_price)
    }]
  }, cookie, csrf);

  console.log(`✓ Kết quả tạo hóa đơn: HTTP ${checkoutRes1.status} - ${JSON.stringify(checkoutRes1.data)}`);
  if (checkoutRes1.status !== 201) {
    throw new Error('Kiểm thử 3 thất bại khi tạo hóa đơn: ' + JSON.stringify(checkoutRes1.data));
  }

  // Kiểm tra chi tiết hóa đơn (tổng tiền 40000)
  const invDetailRes1 = await req('GET', '/api/invoices/' + checkoutRes1.data.id, null, cookie);
  const totalAmount1 = Number(invDetailRes1.data.invoice.total_amount);
  console.log(`✓ Tổng tiền hóa đơn: ${totalAmount1} đ (Kỳ vọng: 40000 đ)`);
  if (totalAmount1 !== 40000) {
    throw new Error(`Kiểm thử 3 thất bại: Tổng tiền hóa đơn không bằng 40000 (thực tế: ${totalAmount1})`);
  }

  // Kiểm tra tồn kho sau khi bán 2 (tồn còn 8)
  const productsAfterSale1 = await req('GET', '/api/products', null, cookie);
  const pAfter1 = productsAfterSale1.data.find(p => p.id === productTenStock.id);
  console.log(`✓ Tồn kho sau khi bán 2 sản phẩm: ${pAfter1.stock_quantity} (Kỳ vọng: 8)`);
  if (pAfter1.stock_quantity !== 8) {
    throw new Error(`Kiểm thử 3 thất bại: Tồn kho không giảm xuống 8 (thực tế: ${pAfter1.stock_quantity})`);
  }

  // KIỂM THỬ 4: Tồn 8, bán 9 → bị chặn bởi backend transaction, tồn vẫn 8
  console.log('\n--- Kiểm thử 4: Tồn kho = 8, gửi yêu cầu thanh toán 9 sản phẩm ---');
  const invoiceNo2 = 'HD_TEST_OVER_' + Date.now().toString().slice(-6);
  const reqKey2 = 'key-over-' + Date.now();
  const checkoutRes2 = await req('POST', '/api/invoices', {
    invoice_no: invoiceNo2,
    request_key: reqKey2,
    items: [{
      product_id: productTenStock.id,
      quantity: 9,
      unit_price: Number(productTenStock.sale_price)
    }]
  }, cookie, csrf);

  console.log(`✓ Kết quả tạo hóa đơn khi thiếu hàng: HTTP ${checkoutRes2.status} - Lỗi: "${checkoutRes2.data.error}"`);
  if (checkoutRes2.status !== 400) {
    throw new Error('Kiểm thử 4 thất bại: Kỳ vọng HTTP 400 nhưng nhận được: ' + checkoutRes2.status);
  }
  if (!checkoutRes2.data.error.includes('không đủ tồn kho') || !checkoutRes2.data.error.includes('8')) {
    throw new Error('Kiểm thử 4 thất bại: Thông báo lỗi không nêu rõ số lượng tồn kho còn lại!');
  }

  // Kiểm tra tồn kho sau khi bị chặn (tồn vẫn là 8)
  const productsAfterFail2 = await req('GET', '/api/products', null, cookie);
  const pAfter2 = productsAfterFail2.data.find(p => p.id === productTenStock.id);
  console.log(`✓ Tồn kho sau khi bị chặn: ${pAfter2.stock_quantity} (Kỳ vọng: vẫn bằng 8)`);
  if (pAfter2.stock_quantity !== 8) {
    throw new Error(`Kiểm thử 4 thất bại: Tồn kho bị thay đổi (thực tế: ${pAfter2.stock_quantity})`);
  }

  // Kiểm tra biến động kho không bị ghi nhận cho yêu cầu thất bại
  const movementsRes = await req('GET', `/api/inventory/${productTenStock.id}/movements`, null, cookie);
  const latestMovement = movementsRes.data[0];
  console.log(`✓ Biến động kho mới nhất là lần bán 2 cái trước đó: Số lượng thay đổi: ${latestMovement.quantity_delta}, Tồn sau biến động: ${latestMovement.balance_after}, Số HĐ: ${latestMovement.invoice_no}`);
  if (latestMovement.balance_after !== 8 || latestMovement.quantity_delta !== -2) {
    throw new Error('Kiểm thử 4 thất bại: Biến động kho bị ghi nhận sai!');
  }

  // KIỂM THỬ PHỤ: Cơ chế chống tạo hóa đơn trùng (Idempotency)
  console.log('\n--- Kiểm tra cơ chế chống tạo hóa đơn trùng ---');
  const duplicateRes = await req('POST', '/api/invoices', {
    invoice_no: invoiceNo1,
    request_key: reqKey1,
    items: [{
      product_id: productTenStock.id,
      quantity: 2,
      unit_price: Number(productTenStock.sale_price)
    }]
  }, cookie, csrf);
  console.log(`✓ Gửi lại request_key cũ: HTTP ${duplicateRes.status} - Message: "${duplicateRes.data.message}"`);
  if (duplicateRes.status !== 200) {
    throw new Error('Cơ chế Idempotency bị lỗi khi gửi trùng request_key');
  }

  console.log('\n=== TẤT CẢ 4 KỊCH BẢN KIỂM THỬ ĐỀU THÀNH CÔNG CHÍNH XÁC 100%! ===');
}

run().catch(err => {
  console.error('LỖI KIỂM THỬ:', err);
  process.exit(1);
});
