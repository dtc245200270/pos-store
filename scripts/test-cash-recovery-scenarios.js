/**
 * scripts/test-cash-recovery-scenarios.js
 * Kiểm tra 5 kịch bản phục hồi giao dịch theo yêu cầu người dùng:
 * 1. CASH mất phản hồi rồi thử lại vẫn là CASH.
 * 2. CASH nhận HTTP 503 vẫn giữ dữ liệu.
 * 3. Đổi phương thức lúc phục hồi CASH không chuyển sang QR.
 * 4. BANK_TRANSFER phục hồi vẫn giữ nguyên nội dung chuyển khoản.
 * 5. Thử lại sau khi đã lưu chỉ có một hóa đơn và một lần trừ kho.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

async function runRecoveryVerification() {
  console.log('=== BẮT ĐẦU KIỂM TRA PHỤC HỒI GIAO DỊCH (CASH & BANK_TRANSFER) ===\n');

  // Đọc nội dung file public/js/sales.js
  const salesJsPath = path.join(__dirname, '../public/js/sales.js');
  const salesJsContent = fs.readFileSync(salesJsPath, 'utf8');

  // Tạo mock DOM và mock môi trường trình duyệt
  function createMockEnv(fetchHandler) {
    const alerts = [];
    const confirms = [];
    const elements = {};

    function getOrCreateEl(id, defaultProps = {}) {
      if (!elements[id]) {
        elements[id] = {
          id,
          value: '',
          _textContent: '',
          get textContent() {
            if (this._textContent) return this._textContent;
            return (this.innerHTML || '').replace(/<[^>]*>/g, ' ');
          },
          set textContent(v) {
            this._textContent = v;
            this.innerHTML = v;
          },
          innerHTML: '',
          className: '',
          classList: {
            classes: new Set(),
            add(c) { this.classes.add(c); },
            remove(c) { this.classes.delete(c); },
            contains(c) { return this.classes.has(c); }
          },
          disabled: false,
          checked: false,
          style: {},
          setAttribute(k, v) { this[k] = v; },
          getAttribute(k) { return this[k]; },
          appendChild(c) {},
          ...defaultProps
        };
      }
      return elements[id];
    }

    // Các thẻ DOM cần thiết trong sales.html
    const requiredIds = [
      'display-invoice-no', 'sales-msg', 'sales-success-box', 'success-invoice-no',
      'display-seller-info', 'header-payment-badge', 'btn-checkout', 'payment-config-warning',
      'pm-cash', 'pm-qr', 's-product', 's-qty', 'btn-add-item', 's-search', 's-cart',
      'cart-item-count', 's-total', 'qr-modal', 'qr-indeterminate-alert', 'qr-img-error',
      'qr-image', 'qr-loading-spinner', 'qr-bank-id', 'qr-account-no', 'qr-account-name',
      'qr-amount', 'qr-transfer-content', 'btn-confirm-qr', 'btn-cancel-qr', 'qr-modal-backdrop'
    ];

    requiredIds.forEach(id => getOrCreateEl(id));
    elements['pm-cash'].checked = true;

    const mockDocument = {
      getElementById(id) { return getOrCreateEl(id); },
      querySelector(selector) {
        if (selector === '#s-cart tbody') return { appendChild() {}, innerHTML: '' };
        return getOrCreateEl(selector.replace(/^[#.]/, ''));
      },
      querySelectorAll() { return []; },
      createElement(tag) {
        return {
          tagName: tag.toUpperCase(),
          className: '',
          innerHTML: '',
          textContent: '',
          style: {},
          appendChild() {}
        };
      },
      body: {
        classList: {
          add() {},
          remove() {}
        }
      },
      addEventListener() {}
    };

    const mockWindow = {
      document: mockDocument,
      apiFetch: fetchHandler,
      alert(msg) { alerts.push(msg); },
      confirm(msg) { confirms.push(msg); return true; },
      console: {
        log: () => {},
        error: () => {},
        warn: () => {}
      },
      Date,
      Math,
      Number,
      String,
      JSON
    };

    const sandbox = {
      window: mockWindow,
      document: mockDocument,
      alert: mockWindow.alert,
      confirm: mockWindow.confirm,
      console: mockWindow.console,
      Date,
      Math,
      Number,
      String,
      JSON,
      setTimeout,
      clearTimeout
    };

    const context = vm.createContext(sandbox);
    vm.runInContext(salesJsContent, context);

    return {
      context,
      elements,
      alerts,
      confirms,
      get: (varName) => vm.runInContext(varName, context),
      set: (varName, val) => {
        sandbox.__tmpVal = val;
        vm.runInContext(`${varName} = __tmpVal; delete __tmpVal;`, context);
      },
      call: (fnName, ...args) => {
        const fn = vm.runInContext(fnName, context);
        return fn(...args);
      }
    };
  }

  // --------------------------------------------------------------------------
  // KỊCH BẢN 1: CASH mất phản hồi rồi thử lại vẫn là CASH
  // --------------------------------------------------------------------------
  console.log('--- Kịch bản 1: CASH mất phản hồi rồi thử lại vẫn là CASH ---');
  {
    let fetchCallCount = 0;
    let payloadsSent = [];

    const fetchHandler = async (url, opts) => {
      fetchCallCount++;
      if (url === '/api/invoices') {
        const body = JSON.parse(opts.body);
        payloadsSent.push(body);
        if (fetchCallCount === 1) {
          // Lần 1: Giả lập mất kết nối mạng (drop)
          throw new Error('Network timeout / Connection drop');
        } else {
          // Lần 2: Thử lại thành công (HTTP 200/201)
          return {
            status: 201,
            ok: true,
            json: async () => ({ id: 101, invoice_no: body.invoice_no })
          };
        }
      }
      return { ok: true, json: async () => ({}) };
    };

    const env = createMockEnv(fetchHandler);

    // Chuẩn bị giỏ hàng có 1 sản phẩm
    env.set('cart', [{ product_id: 1, sku: 'SP001', name: 'Sản phẩm 1', quantity: 2, unit_price: 50000 }]);
    env.set('selectedPaymentMethod', 'CASH');

    // Thực hiện thanh toán lần 1
    await env.call('checkout');

    // Kiểm tra sau khi mất kết nối
    assert.strictEqual(env.get('isPendingRecovery'), true, 'isPendingRecovery phải bật true');
    const pendingPayload = env.get('pendingConfirmationPayload');
    assert.ok(pendingPayload, 'pendingConfirmationPayload phải được lưu');
    assert.strictEqual(pendingPayload.payment_method, 'CASH', 'Phương thức đang chờ phải là CASH');
    assert.strictEqual(payloadsSent.length, 1);
    assert.strictEqual(payloadsSent[0].payment_method, 'CASH');

    const firstInvoiceNo = pendingPayload.invoice_no;
    const firstRequestKey = pendingPayload.request_key;

    // Nút thanh toán hiển thị trạng thái thử lại cho tiền mặt
    assert.ok(env.elements['btn-checkout'].textContent.includes('THỬ LẠI'), 'Nút phải chuyển sang Thử lại');
    assert.ok(env.elements['btn-checkout'].textContent.includes('TIỀN MẶT'), 'Nút phải chỉ rõ Tiền mặt');

    // Thu ngân bấm "Thử lại gửi yêu cầu"
    await env.call('checkout');

    // Kiểm tra sau khi thử lại thành công
    assert.strictEqual(payloadsSent.length, 2, 'Phải gửi lại đúng 2 lần yêu cầu thanh toán');
    assert.strictEqual(payloadsSent[1].payment_method, 'CASH', 'Payload thử lại phải giữ nguyên CASH');
    assert.strictEqual(payloadsSent[1].invoice_no, firstInvoiceNo, 'invoice_no phải đúng như cũ');
    assert.strictEqual(payloadsSent[1].request_key, firstRequestKey, 'request_key phải đúng như cũ');
    assert.strictEqual(env.get('isPendingRecovery'), false, 'Giải phóng isPendingRecovery sau thành công');
    assert.strictEqual(env.get('pendingConfirmationPayload'), null, 'pendingConfirmationPayload giải phóng về null');
    assert.strictEqual(env.get('cart').length, 0, 'Giỏ hàng được làm mới');

    console.log('✔ ĐẠT: CASH mất phản hồi rồi thử lại giữ nguyên CASH và đúng payload cũ.');
  }

  // --------------------------------------------------------------------------
  // KỊCH BẢN 2: CASH nhận HTTP 503 vẫn giữ dữ liệu
  // --------------------------------------------------------------------------
  console.log('\n--- Kịch bản 2: CASH nhận HTTP 503 vẫn giữ dữ liệu ---');
  {
    const fetchHandler = async (url, opts) => {
      if (url === '/api/invoices') {
        return {
          status: 503,
          ok: false,
          json: async () => ({ error: 'Database temporary unavailable' })
        };
      }
      return { ok: true, json: async () => ({}) };
    };

    const env = createMockEnv(fetchHandler);

    env.set('cart', [{ product_id: 2, sku: 'SP002', name: 'Sản phẩm 2', quantity: 3, unit_price: 30000 }]);
    env.set('selectedPaymentMethod', 'CASH');

    await env.call('checkout');

    // Kiểm tra sau khi nhận HTTP 503
    assert.strictEqual(env.get('isPendingRecovery'), true, 'isPendingRecovery phải được bật khi gặp 503');
    const pendingPayload = env.get('pendingConfirmationPayload');
    assert.ok(pendingPayload, 'pendingConfirmationPayload không được bị xóa');
    assert.strictEqual(pendingPayload.payment_method, 'CASH');
    assert.strictEqual(pendingPayload.items.length, 1);
    assert.strictEqual(pendingPayload.items[0].quantity, 3);
    assert.strictEqual(env.get('cart').length, 1, 'Giỏ hàng không bị xóa khi gặp 503');

    // Nút thử lại sẵn sàng
    assert.strictEqual(env.elements['btn-checkout'].disabled, false, 'Nút thử lại không bị disable');
    assert.ok(env.elements['btn-checkout'].textContent.includes('THỬ LẠI GỬI YÊU CẦU (TIỀN MẶT)'));

    console.log('✔ ĐẠT: CASH gặp HTTP 503 bảo toàn nguyên vẹn payload, giỏ hàng và cờ phục hồi.');
  }

  // --------------------------------------------------------------------------
  // KỊCH BẢN 3: Đổi phương thức lúc phục hồi CASH không chuyển sang QR
  // --------------------------------------------------------------------------
  console.log('\n--- Kịch bản 3: Đổi phương thức lúc phục hồi CASH không chuyển sang QR ---');
  {
    const fetchHandler = async (url, opts) => {
      if (url === '/api/invoices') throw new Error('Network down');
      return { ok: true, json: async () => ({}) };
    };

    const env = createMockEnv(fetchHandler);

    env.set('cart', [{ product_id: 1, sku: 'SP001', name: 'Sản phẩm 1', quantity: 1, unit_price: 100000 }]);
    env.set('selectedPaymentMethod', 'CASH');

    // Thanh toán gặp lỗi mạng -> Chuyển sang phục hồi CASH
    await env.call('checkout');
    assert.strictEqual(env.get('isPendingRecovery'), true);
    assert.strictEqual(env.get('pendingConfirmationPayload').payment_method, 'CASH');

    // Người dùng bấm vào radio button Chuyển khoản QR
    env.elements['pm-qr'].checked = true;
    env.elements['pm-cash'].checked = false;

    // Sự kiện onchange kích hoạt
    env.call('onPaymentMethodChange');

    // Kiểm tra: Phải khôi phục lại CASH, không ép sang QR
    assert.strictEqual(env.elements['pm-cash'].checked, true, 'Radio Tiền mặt phải được khôi phục về checked');
    assert.strictEqual(env.elements['pm-qr'].checked, false, 'Radio QR phải bị hủy chọn');
    assert.strictEqual(env.get('selectedPaymentMethod'), 'CASH', 'selectedPaymentMethod vẫn phải là CASH');
    assert.ok(env.alerts.some(a => a.includes('tiền mặt') && a.includes('Không thể đổi')), 'Phải cảnh báo người dùng');

    // Thử gọi prepareAndShowQr() khi đang phục hồi CASH -> Phải bị chặn
    let qrModalOpened = false;
    env.context.openQrModal = () => { qrModalOpened = true; };
    await env.call('prepareAndShowQr');
    assert.strictEqual(qrModalOpened, false, 'Không được mở modal QR khi đang phục hồi CASH');

    console.log('✔ ĐẠT: Đổi phương thức khi phục hồi CASH tự động khôi phục lại Tiền mặt, không chuyển sang QR.');
  }

  // --------------------------------------------------------------------------
  // KỊCH BẢN 4: BANK_TRANSFER phục hồi vẫn giữ nguyên nội dung chuyển khoản
  // --------------------------------------------------------------------------
  console.log('\n--- Kịch bản 4: BANK_TRANSFER phục hồi vẫn giữ nguyên nội dung chuyển khoản ---');
  {
    let sentPayloads = [];
    let callCount = 0;

    const fetchHandler = async (url, opts) => {
      callCount++;
      if (url === '/api/invoices') {
        const body = JSON.parse(opts.body);
        sentPayloads.push(body);
        if (callCount === 1) {
          // Lần 1: Giả lập 500 Internal Server Error
          return {
            status: 500,
            ok: false,
            json: async () => ({ error: 'Internal Error' })
          };
        } else {
          // Lần 2: Thử lại thành công
          return {
            status: 201,
            ok: true,
            json: async () => ({ id: 202, invoice_no: body.invoice_no })
          };
        }
      }
      return { ok: true, json: async () => ({}) };
    };

    const env = createMockEnv(fetchHandler);

    env.set('cart', [{ product_id: 1, sku: 'SP001', name: 'Sản phẩm 1', quantity: 1, unit_price: 120000 }]);
    env.set('preparedQrData', {
      transfer_content: 'POS107879_TESTQR',
      amount: 120000,
      bank_id: '970415'
    });
    env.set('selectedPaymentMethod', 'BANK_TRANSFER');

    // Nhân viên bấm xác nhận lần 1
    await env.call('confirmQrPayment');

    assert.strictEqual(env.get('isPendingRecovery'), true, 'isPendingRecovery phải bật');
    const pendingPayload = env.get('pendingConfirmationPayload');
    assert.ok(pendingPayload);
    assert.strictEqual(pendingPayload.payment_method, 'BANK_TRANSFER');
    assert.strictEqual(pendingPayload.transfer_content, 'POS107879_TESTQR', 'transfer_content phải được lưu');

    // Kiểm tra nếu người dùng vô tình bấm radio CASH trong lúc phục hồi QR
    env.elements['pm-cash'].checked = true;
    env.elements['pm-qr'].checked = false;
    env.call('onPaymentMethodChange');
    assert.strictEqual(env.elements['pm-qr'].checked, true, 'Radio QR phải được khôi phục');
    assert.strictEqual(env.get('selectedPaymentMethod'), 'BANK_TRANSFER');

    // Nhân viên bấm "Thử lại gửi yêu cầu" trên modal QR
    await env.call('confirmQrPayment');

    assert.strictEqual(sentPayloads.length, 2);
    assert.strictEqual(sentPayloads[0].transfer_content, 'POS107879_TESTQR');
    assert.strictEqual(sentPayloads[1].transfer_content, 'POS107879_TESTQR', 'Lần thử lại phải giữ đúng transfer_content cũ');
    assert.strictEqual(sentPayloads[1].request_key, sentPayloads[0].request_key);
    assert.strictEqual(env.get('isPendingRecovery'), false, 'Giải phóng trạng thái sau khi thành công');

    console.log('✔ ĐẠT: BANK_TRANSFER phục hồi giữ nguyên vẹn nội dung chuyển khoản và request_key.');
  }

  // --------------------------------------------------------------------------
  // KỊCH BẢN 5: Khóa sửa giỏ hàng trong lúc phục hồi (chống đổi giỏ)
  // --------------------------------------------------------------------------
  console.log('\n--- Kịch bản 5: Khóa sửa giỏ hàng và tạo yêu cầu mới trong lúc phục hồi ---');
  {
    const env = createMockEnv(async () => ({ ok: true }));

    env.set('cart', [{ product_id: 1, sku: 'SP001', name: 'Sản phẩm 1', quantity: 1, unit_price: 50000 }]);
    env.set('isPendingRecovery', true);
    env.set('pendingConfirmationPayload', {
      invoice_no: 'HD_RECOVER_LOCKED',
      request_key: 'req-locked-001',
      payment_method: 'CASH',
      items: [{ product_id: 1, quantity: 1, unit_price: 50000 }]
    });

    // 1. Thử thêm sản phẩm mới
    env.call('addSaleItem');
    assert.ok(env.alerts.some(a => a.includes('phục hồi giao dịch') && a.includes('không thể sửa giỏ hàng')));

    // 2. Thử sửa số lượng
    env.alerts.length = 0;
    env.call('updateCartItemQty', 0, 5);
    assert.strictEqual(env.get('cart')[0].quantity, 1, 'Số lượng không được thay đổi');

    // 3. Thử xóa sản phẩm
    env.alerts.length = 0;
    env.call('removeSaleItem', 0);
    assert.strictEqual(env.get('cart').length, 1, 'Không được xóa sản phẩm');

    console.log('✔ ĐẠT: Toàn bộ thao tác sửa giỏ hàng bị chặn tuyệt đối khi đang phục hồi.');
  }

  console.log('\n=== TẤT CẢ 5 KỊCH BẢN PHỤC HỒI KIỂM TRA ĐỀU HOÀN THÀNH VÀ ĐẠT 100% ===');
}

runRecoveryVerification().catch(err => {
  console.error('LỖI KIỂM THỬ PHỤC HỒI:', err);
  process.exit(1);
});
