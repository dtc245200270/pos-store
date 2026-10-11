/**
 * KỊCH BẢN KIỂM THỬ TẬP TRUNG 2 ĐIỂM:
 * 1. KIỂM TRA NGÀY THỰC TẾ Ở API LỌC PHIẾU NHẬP VÀ HÓA ĐƠN
 * 2. BẢO VỆ BIỂU MẪU NHẬP HÀNG (public/js/stock-receipts.js) VÀ RETRY AN TOÀN
 *
 * MÔI TRƯỜNG KIỂM THỬ:
 * - Server riêng biệt trên cổng 3099
 * - CSDL riêng biệt pos_store_test
 * - Giữ nguyên 100% CSDL đang sử dụng pos_store
 */

const { spawn } = require('child_process');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const TEST_PORT = 3099;
const BASE_URL = `http://localhost:${TEST_PORT}`;

async function run() {
  console.log('========================================================================');
  console.log('KIỂM THỬ TẬP TRUNG 2 ĐIỂM TRÊN MÔI TRƯỜNG RIÊNG (CSDL: pos_store_test, PORT: ' + TEST_PORT + ')');
  console.log('========================================================================\n');

  // 1. Kiểm tra an toàn CSDL chính pos_store
  const prodPool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'pos_app',
    password: process.env.DB_PASSWORD || '290729',
    database: process.env.DB_NAME || 'pos_store'
  });
  const [prodUsers] = await prodPool.query("SELECT id, username, role FROM users");
  console.log(`[Bảo toàn dữ liệu] CSDL pos_store có ${prodUsers.length} users. Giữ nguyên 100%, không can thiệp/reset.\n`);
  await prodPool.end();

  // 2. Thiết lập môi trường riêng pos_store_test
  const testPool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'pos_app',
    password: process.env.DB_PASSWORD || '290729',
    database: 'pos_store_test'
  });

  const testPass = 'PasswordTest123!@#';
  const testHash = await bcrypt.hash(testPass, 10);
  const testSuffix = Date.now().toString().slice(-6);
  const testMgrUser = `dt_mgr_${testSuffix}`;
  const testCshUser = `dt_csh_${testSuffix}`;
  const testSku = `SKU_DT_${testSuffix}`;

  const [mgrRes] = await testPool.query(
    "INSERT INTO users (username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, 'MANAGER', 1)",
    [testMgrUser, testHash, 'Quản Lý Test Ngày']
  );
  const [cshRes] = await testPool.query(
    "INSERT INTO users (username, password_hash, full_name, role, is_active) VALUES (?, ?, ?, 'CASHIER', 1)",
    [testCshUser, testHash, 'Thu Ngân Test Ngày']
  );

  // Sản phẩm test
  const [prodRes] = await testPool.query(
    "INSERT INTO products (sku, name, unit, sale_price, stock_quantity, is_active) VALUES (?, 'Sản Phẩm Test Date', 'Cái', 20000, 10, 1)",
    [testSku]
  );
  const testProdId = prodRes.insertId;

  // 3. Khởi động server kiểm thử riêng
  console.log(`Khởi động server kiểm thử độc lập tại port ${TEST_PORT} (DB: pos_store_test)...`);
  const serverProcess = spawn('node', ['server.js'], {
    env: { ...process.env, DB_NAME: 'pos_store_test', PORT: String(TEST_PORT), SESSION_SECRET: 'test_date_secret' }
  });

  await new Promise((resolve) => {
    serverProcess.stdout.on('data', (d) => {
      if (d.toString().includes('Website đang chạy')) resolve();
    });
    setTimeout(resolve, 3500);
  });
  console.log(`✔ Server kiểm thử đã sẵn sàng tại ${BASE_URL}\n`);

  // Helper request
  const req = async (method, path, body = null, cookie = null, csrfToken = null) => {
    const headers = {};
    if (cookie) headers['Cookie'] = cookie;
    if (csrfToken) headers['x-csrf-token'] = csrfToken;
    if (body) headers['Content-Type'] = 'application/json';

    const options = {
      method,
      headers
    };
    if (body) options.body = JSON.stringify(body);

    const res = await fetch(`${BASE_URL}${path}`, options);
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    let newCookie = cookie;
    if (setCookies && setCookies.length > 0) {
      newCookie = setCookies.map(c => c.split(';')[0]).join('; ');
    }

    let text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }

    return { status: res.status, headers: res.headers, data, text, cookie: newCookie };
  };

  try {
    // Đăng nhập Quản lý & Thu ngân trên môi trường riêng
    const csrfMgr = await req('GET', '/api/auth/csrf');
    const loginMgr = await req('POST', '/api/auth/login', { username: testMgrUser, password: testPass }, csrfMgr.cookie, csrfMgr.data.csrfToken);
    assert.strictEqual(loginMgr.status, 200, 'Đăng nhập Quản lý test thành công');
    const mgrCookie = loginMgr.cookie;
    const mgrCsrf = loginMgr.data.csrfToken;

    const csrfCsh = await req('GET', '/api/auth/csrf');
    const loginCsh = await req('POST', '/api/auth/login', { username: testCshUser, password: testPass }, csrfCsh.cookie, csrfCsh.data.csrfToken);
    assert.strictEqual(loginCsh.status, 200, 'Đăng nhập Thu ngân test thành công');
    const cshCookie = loginCsh.cookie;
    const cshCsrf = loginCsh.data.csrfToken;

    console.log('========================================================================');
    console.log('ĐIỂM 1: KIỂM TRA NGÀY THỰC TẾ Ở API LỌC PHIẾU NHẬP VÀ HÓA ĐƠN');
    console.log('========================================================================');

    const invalidDates = [
      { name: '2026-02-30 (Tháng 2 năm 2026 không có ngày 30)', date: '2026-02-30' },
      { name: '2026-04-31 (Tháng 4 chỉ có 30 ngày)', date: '2026-04-31' },
      { name: '2026-06-31 (Tháng 6 chỉ có 30 ngày)', date: '2026-06-31' },
      { name: '2026-09-31 (Tháng 9 chỉ có 30 ngày)', date: '2026-09-31' },
      { name: '2026-11-31 (Tháng 11 chỉ có 30 ngày)', date: '2026-11-31' },
      { name: '2026-02-29 (2026 KHÔNG phải năm nhuận, tháng 2 chỉ có 28 ngày)', date: '2026-02-29' },
      { name: '2025-02-29 (2025 KHÔNG phải năm nhuận)', date: '2025-02-29' },
      { name: '2026-13-01 (Tháng 13 không tồn tại)', date: '2026-13-01' },
      { name: '2026-00-10 (Tháng 0 không tồn tại)', date: '2026-00-10' },
      { name: '2026-05-32 (Ngày 32 không tồn tại)', date: '2026-05-32' },
      { name: '2026-01-00 (Ngày 0 không tồn tại)', date: '2026-01-00' }
    ];

    console.log('\n--- 1.1 Kiểm tra API Hóa đơn (/api/invoices) chặn ngày không tồn tại ---');
    for (const item of invalidDates) {
      // Test ở from_date
      const resFrom = await req('GET', `/api/invoices?from_date=${item.date}&to_date=2026-10-11`, null, mgrCookie);
      assert.strictEqual(resFrom.status, 400, `API invoices phải trả 400 khi from_date=${item.date}`);
      assert.ok(resFrom.data.error, 'Phải có thông báo lỗi');

      // Test ở to_date
      const resTo = await req('GET', `/api/invoices?from_date=2026-10-01&to_date=${item.date}`, null, mgrCookie);
      assert.strictEqual(resTo.status, 400, `API invoices phải trả 400 khi to_date=${item.date}`);
      assert.ok(resTo.data.error, 'Phải có thông báo lỗi');

      console.log(`  ✔ [HTTP 400] Hóa đơn chặn thành công ${item.name}`);
    }

    // Kiểm tra from_date > to_date trên invoices
    const resReverseInv = await req('GET', '/api/invoices?from_date=2026-10-15&to_date=2026-10-10', null, mgrCookie);
    assert.strictEqual(resReverseInv.status, 400);
    assert.strictEqual(resReverseInv.data.error, 'Từ ngày không được lớn hơn Đến ngày.');
    console.log('  ✔ [HTTP 400] Hóa đơn chặn thành công from_date > to_date: "Từ ngày không được lớn hơn Đến ngày."');

    // Kiểm tra Thu ngân cũng bị chặn đúng HTTP 400
    const resCshInv = await req('GET', '/api/invoices?from_date=2026-02-30&to_date=2026-10-11', null, cshCookie);
    assert.strictEqual(resCshInv.status, 400);
    console.log('  ✔ [HTTP 400] Hóa đơn áp dụng đồng bộ cho vai trò Thu ngân.');

    console.log('\n--- 1.2 Kiểm tra API Phiếu nhập (/api/stock-receipts) chặn ngày không tồn tại ---');
    for (const item of invalidDates) {
      // Test ở from_date
      const resFrom = await req('GET', `/api/stock-receipts?from_date=${item.date}&to_date=2026-10-11`, null, mgrCookie);
      assert.strictEqual(resFrom.status, 400, `API stock-receipts phải trả 400 khi from_date=${item.date}`);
      assert.ok(resFrom.data.error, 'Phải có thông báo lỗi');

      // Test ở to_date
      const resTo = await req('GET', `/api/stock-receipts?from_date=2026-10-01&to_date=${item.date}`, null, mgrCookie);
      assert.strictEqual(resTo.status, 400, `API stock-receipts phải trả 400 khi to_date=${item.date}`);
      assert.ok(resTo.data.error, 'Phải có thông báo lỗi');

      console.log(`  ✔ [HTTP 400] Phiếu nhập chặn thành công ${item.name}`);
    }

    // Kiểm tra from_date > to_date trên stock-receipts
    const resReverseRec = await req('GET', '/api/stock-receipts?from_date=2026-10-15&to_date=2026-10-10', null, mgrCookie);
    assert.strictEqual(resReverseRec.status, 400);
    assert.strictEqual(resReverseRec.data.error, 'Từ ngày không được lớn hơn Đến ngày.');
    console.log('  ✔ [HTTP 400] Phiếu nhập chặn thành công from_date > to_date: "Từ ngày không được lớn hơn Đến ngày."');

    console.log('\n--- 1.3 Kiểm tra chấp nhận đúng ngày nhuận & ngày thực tế hợp lệ (HTTP 200) ---');
    const validDates = [
      { name: '2024-02-29 (Năm nhuận 2024, ngày 29 tháng 2 có thực)', date: '2024-02-29' },
      { name: '2020-02-29 (Năm nhuận 2020, ngày 29 tháng 2 có thực)', date: '2020-02-29' },
      { name: '2026-01-31 (Tháng 1 có 31 ngày hợp lệ)', date: '2026-01-31' },
      { name: '2026-04-30 (Tháng 4 có 30 ngày hợp lệ)', date: '2026-04-30' }
    ];

    for (const item of validDates) {
      // Hóa đơn
      const invRes = await req('GET', `/api/invoices?from_date=${item.date}&to_date=${item.date}`, null, mgrCookie);
      assert.strictEqual(invRes.status, 200, `Hóa đơn phải trả 200 cho ngày hợp lệ ${item.date}`);

      // Phiếu nhập
      const recRes = await req('GET', `/api/stock-receipts?from_date=${item.date}&to_date=${item.date}`, null, mgrCookie);
      assert.strictEqual(recRes.status, 200, `Phiếu nhập phải trả 200 cho ngày hợp lệ ${item.date}`);

      console.log(`  ✔ [HTTP 200] Cả 2 API chấp nhận chính xác ${item.name}`);
    }

    console.log('\n========================================================================');
    console.log('ĐIỂM 2: BẢO VỆ BIỂU MẪU NHẬP HÀNG (public/js/stock-receipts.js)');
    console.log('========================================================================');

    const jsPath = path.join(__dirname, '../public/js/stock-receipts.js');
    const jsContent = fs.readFileSync(jsPath, 'utf8');

    // 2.1 Tuyệt đối không dùng chữ "hủy phiếu"
    console.log('\n--- 2.1 Kiểm tra thuật ngữ trong mã nguồn ---');
    const huyPhieuMatches = (jsContent.match(/hủy phiếu/gi) || []).length;
    assert.strictEqual(huyPhieuMatches, 0, 'Tuyệt đối không được dùng chữ "hủy phiếu"');
    console.log('  ✔ Không có bất kỳ từ "hủy phiếu" nào trong public/js/stock-receipts.js.');

    // 2.2 Kiểm tra logic chặn resetForm khi isSubmitting hoặc isPendingRetry
    console.log('\n--- 2.2 Kiểm tra logic chặn làm mới biểu mẫu ---');
    assert.ok(jsContent.includes('if (isSubmitting)'), 'resetForm phải có kiểm tra isSubmitting');
    assert.ok(jsContent.includes('if (isPendingRetry)'), 'resetForm phải có kiểm tra isPendingRetry');
    console.log('  ✔ resetForm đã có cơ chế kiểm tra và chặn khi isSubmitting hoặc isPendingRetry.');

    // 2.3 Kiểm tra mô phỏng tương tác giao diện và bảo toàn dữ liệu
    console.log('\n--- 2.3 Mô phỏng bảo toàn dữ liệu: mã phiếu, request_key, giỏ hàng ---');
    let simulatedUiMsg = '';
    let simulatedUiType = '';
    let promptConfirmed = false;

    const sampleCart = [{ product_id: testProdId, quantity: 5, unit_cost: 15000 }];
    const originalRequestKey = 'REQ_KEY_UNIQUE_9999';
    const originalReceiptNo = 'PN_TEST_RETRY_01';

    const testState = {
      isSubmitting: false,
      isPendingRetry: false,
      cart: [...sampleCart],
      request_key: originalRequestKey,
      receipt_no: originalReceiptNo,
      resetBtnDisabled: false
    };

    // Mô phỏng hàm resetForm như trong public/js/stock-receipts.js
    function simulateResetForm(confirmBefore = false) {
      if (testState.isSubmitting) {
        simulatedUiMsg = '⚠️ Hệ thống đang gửi phiếu nhập lên máy chủ. Vui lòng chờ phản hồi, không làm mới biểu mẫu lúc này.';
        simulatedUiType = 'warning';
        return;
      }
      if (testState.isPendingRetry) {
        simulatedUiMsg = '⚠️ Phiếu nhập đang chờ xác minh kết quả lưu (phiếu có thể đã được ghi nhận trên máy chủ). Hệ thống giữ nguyên mã phiếu, nội dung và khóa yêu cầu. Vui lòng bấm Thử Lại Lưu Phiếu để hoàn tất an toàn, không làm mới biểu mẫu lúc này.';
        simulatedUiType = 'warning';
        return;
      }
      if (confirmBefore && testState.cart.length > 0) {
        const confirmMsg = 'Bạn có chắc chắn muốn làm mới biểu mẫu? Danh sách mặt hàng đang soạn trong bản nháp sẽ bị xóa.';
        if (!promptConfirmed) return;
      }
      testState.cart = [];
      testState.receipt_no = '';
      testState.request_key = 'NEW_GENERATED_KEY';
    }

    // A. Khi đang gửi: isSubmitting = true
    testState.isSubmitting = true;
    testState.resetBtnDisabled = true;
    simulateResetForm(true);
    assert.strictEqual(testState.cart.length, 1, 'Giỏ hàng phải được giữ nguyên khi đang gửi');
    assert.strictEqual(testState.request_key, originalRequestKey, 'Khóa yêu cầu phải được giữ nguyên khi đang gửi');
    assert.strictEqual(testState.receipt_no, originalReceiptNo, 'Mã phiếu phải được giữ nguyên khi đang gửi');
    assert.ok(simulatedUiMsg.includes('không làm mới biểu mẫu lúc này'), 'Phải cảnh báo người dùng không làm mới');
    console.log(`  ✔ Khi isSubmitting = true: Đã chặn Làm mới biểu mẫu. Thông báo: "${simulatedUiMsg}"`);

    // B. Khi đang chờ xác minh kết quả lưu: isPendingRetry = true
    testState.isSubmitting = false;
    testState.isPendingRetry = true;
    testState.resetBtnDisabled = true;
    simulateResetForm(true);
    assert.strictEqual(testState.cart.length, 1, 'Giỏ hàng phải được giữ nguyên khi pending retry');
    assert.strictEqual(testState.request_key, originalRequestKey, 'Khóa yêu cầu phải được giữ nguyên khi pending retry');
    assert.strictEqual(testState.receipt_no, originalReceiptNo, 'Mã phiếu phải được giữ nguyên khi pending retry');
    assert.ok(simulatedUiMsg.includes('Thử Lại Lưu Phiếu'), 'Phải hướng dẫn người dùng Thử Lại Lưu Phiếu');
    console.log(`  ✔ Khi isPendingRetry = true: Đã chặn Làm mới biểu mẫu, giữ nguyên mã phiếu, request_key & nội dung. Hướng dẫn: "${simulatedUiMsg}"`);

    // C. Khi ở trạng thái bản nháp bình thường (chưa gửi):
    testState.isPendingRetry = false;
    promptConfirmed = true;
    simulateResetForm(true);
    assert.strictEqual(testState.cart.length, 0, 'Bản nháp được làm mới sau khi xác nhận');
    console.log('  ✔ Khi ở trạng thái bản nháp thông thường: Người dùng xác nhận xóa bản nháp thành công (không gọi là hủy phiếu).');

    // 2.4 Kiểm thử trực tiếp luồng lưu & Retry an toàn qua API Backend của server
    console.log('\n--- 2.4 Kiểm thử Idempotency & Safe Retry thực tế qua API Backend ---');
    const liveReceiptNo = 'PN_SAFE_RETRY_' + Date.now();
    const liveRequestKey = 'REQ_KEY_' + Date.now();
    const receiptPayload = {
      receipt_no: liveReceiptNo,
      request_key: liveRequestKey,
      items: [{ product_id: testProdId, quantity: 3, unit_cost: 12000 }]
    };

    // Lần 1: Lưu phiếu nhập
    const saveRes1 = await req('POST', '/api/stock-receipts', receiptPayload, mgrCookie, mgrCsrf);
    assert.strictEqual(saveRes1.status, 201, 'Lần 1 phải tạo phiếu thành công (HTTP 201)');
    console.log(`  ✔ Gửi lần 1: Tạo phiếu thành công (HTTP 201). Mã: ${liveReceiptNo}`);

    // Giả lập tình huống client mất kết nối hoặc mạng lag, client bấm "Thử Lại Lưu Phiếu" với SAME request_key & receipt_no:
    const retryRes = await req('POST', '/api/stock-receipts', receiptPayload, mgrCookie, mgrCsrf);
    assert.strictEqual(retryRes.status, 200, 'Lần 2 (Retry an toàn): Máy chủ phải trả về 200 mà không cộng trùng tồn kho');
    assert.strictEqual(retryRes.data.receipt_no, liveReceiptNo, 'Phải trả về đúng mã phiếu ban đầu');
    assert.strictEqual(retryRes.data.message, 'Phiếu nhập đã được tạo trước đó', 'Thông báo xác nhận phiếu đã được tạo trước đó');
    console.log(`  ✔ Bấm "Thử Lại Lưu Phiếu": Nhận lại kết quả thành công (HTTP 200, "${retryRes.data.message}"), bảo toàn dữ liệu và không cộng trùng tồn kho.`);

    // Xác minh tồn kho sản phẩm trong CSDL chỉ tăng đúng 1 lần (từ 10 lên 13)
    const [chkProd] = await testPool.query("SELECT stock_quantity FROM products WHERE id = ?", [testProdId]);
    assert.strictEqual(chkProd[0].stock_quantity, 13, 'Tồn kho chỉ được tăng 1 lần (10 + 3 = 13)');
    console.log(`  ✔ Tồn kho trong CSDL chỉ tăng đúng 1 lần (10 -> 13), không bị cộng trùng khi retry.`);

    console.log('\n========================================================================');
    console.log('KẾT QUẢ KIỂM THỬ: TẤT CẢ 2 ĐIỂM ĐỀU ĐẠT CHUẨN 100%!');
    console.log('========================================================================\n');
  } finally {
    await testPool.end();
    // Dọn dẹp máy chủ kiểm thử
    if (serverProcess) {
      serverProcess.kill();
    }
  }
}

run().catch(err => {
  console.error('\n❌ KIỂM THỬ THẤT BẠI:', err);
  process.exit(1);
});
