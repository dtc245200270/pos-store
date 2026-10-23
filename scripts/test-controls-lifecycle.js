/**
 * scripts/test-controls-lifecycle.js
 * Kiểm tra các trạng thái của điều khiển bán hàng theo yêu cầu:
 * 1. Mở trang mới (giỏ rỗng): nhập được số lượng, tìm kiếm và chọn sản phẩm được; nút thanh toán disabled.
 * 2. Thanh toán tiền mặt thành công: các ô điều khiển được mở lại, thêm được giao dịch tiếp theo.
 * 3. Thanh toán QR thành công: các ô điều khiển được mở lại, thêm được giao dịch tiếp theo.
 * 4. Xóa sản phẩm cuối khỏi giỏ: ô số lượng, tìm kiếm, chọn sản phẩm vẫn sử dụng được; nút thanh toán disabled.
 * 5. Đang phục hồi: toàn bộ điều khiển giỏ và nút thêm bị khóa; không sửa được giỏ.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

async function runControlsLifecycleTest() {
  console.log('=== BẮT ĐẦU KIỂM TRA VÒNG ĐỜI ĐIỀU KHIỂN BÁN HÀNG ===\n');

  const salesJsPath = path.join(__dirname, '../public/js/sales.js');
  const salesJsContent = fs.readFileSync(salesJsPath, 'utf8');

  function createEnv(fetchHandler) {
    const alerts = [];
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

    const requiredIds = [
      'display-invoice-no', 'sales-msg', 'sales-success-box', 'success-invoice-no',
      'display-seller-info', 'header-payment-badge', 'btn-checkout', 'payment-config-warning',
      'pm-cash', 'pm-qr', 's-product', 's-qty', 'btn-add-item', 's-search', 's-cart',
      'cart-item-count', 's-total', 'qr-modal', 'qr-indeterminate-alert', 'qr-img-error',
      'qr-image', 'qr-loading-spinner', 'qr-bank-id', 'qr-account-no', 'qr-account-name',
      'qr-amount', 'qr-transfer-content', 'btn-confirm-qr', 'btn-cancel-qr', 'qr-modal-backdrop',
      's-product-info-box', 'info-p-sku', 'info-p-unit', 'info-p-price', 'info-p-stock'
    ];

    requiredIds.forEach(id => getOrCreateEl(id));
    elements['pm-cash'].checked = true;
    elements['s-qty'].value = '';

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
      body: { classList: { add() {}, remove() {} } },
      addEventListener() {}
    };

    const mockWindow = {
      document: mockDocument,
      apiFetch: fetchHandler,
      alert(msg) { alerts.push(msg); },
      confirm(msg) { return true; },
      console: { log: () => {}, error: () => {}, warn: () => {} },
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

  // TEST 1: Mở trang mới (giỏ rỗng)
  console.log('--- Test 1: Mở trang mới (giỏ rỗng) ---');
  {
    const env = createEnv(async () => ({ ok: true, json: async () => ({}) }));
    env.set('cart', []);
    env.call('renderCart');

    // Kiểm tra ô s-qty để trống ban đầu
    assert.strictEqual(env.elements['s-qty'].value, '', 'Ô s-qty phải để trống khi mở trang');

    // Kiểm tra điều khiển không bị khóa
    assert.strictEqual(env.elements['s-qty'].disabled, false, 'Ô số lượng s-qty phải sử dụng được khi mở trang');
    assert.strictEqual(env.elements['s-product'].disabled, false, 'Ô chọn sản phẩm s-product phải sử dụng được khi mở trang');
    assert.strictEqual(env.elements['s-search'].disabled, false, 'Ô tìm kiếm s-search phải sử dụng được khi mở trang');
    assert.strictEqual(env.elements['btn-add-item'].disabled, false, 'Nút Thêm phải sử dụng được khi mở trang');

    // Nút thanh toán phải bị vô hiệu hóa vì giỏ rỗng
    assert.strictEqual(env.elements['btn-checkout'].disabled, true, 'Nút thanh toán phải bị disable khi giỏ rỗng');
    console.log('✔ ĐẠT: Mở trang mới ô số lượng để trống, tìm kiếm và chọn sản phẩm dùng được; nút thanh toán bị khóa khi giỏ rỗng.');
  }

  // TEST 2: Thanh toán tiền mặt thành công -> thêm được giao dịch tiếp theo
  console.log('\n--- Test 2: Thanh toán tiền mặt thành công -> thêm được giao dịch tiếp theo ---');
  {
    const env = createEnv(async (url, opts) => {
      if (url === '/api/invoices') {
        const body = JSON.parse(opts.body);
        return {
          status: 201,
          ok: true,
          json: async () => ({ id: 501, invoice_no: body.invoice_no })
        };
      }
      if (url.includes('/api/products')) {
        return {
          ok: true,
          json: async () => ([
            { id: 1, sku: 'SP001', name: 'Sản phẩm 1', unit: 'Cái', sale_price: 100000, stock_quantity: 10, is_active: true }
          ])
        };
      }
      return { ok: true, json: async () => ({}) };
    });

    // Giả lập giỏ hàng đang có 1 sản phẩm
    env.set('productsMap', {
      1: { id: 1, sku: 'SP001', name: 'Sản phẩm 1', unit: 'Cái', sale_price: 100000, stock_quantity: 10, is_active: true }
    });
    env.set('cart', [{ product_id: 1, sku: 'SP001', name: 'Sản phẩm 1', quantity: 1, unit_price: 100000 }]);
    env.set('selectedPaymentMethod', 'CASH');

    // Thực hiện thanh toán tiền mặt
    await env.call('checkout');

    // Giỏ hàng đã về rỗng sau khi thanh toán thành công
    assert.strictEqual(env.get('cart').length, 0, 'Giỏ hàng phải rỗng sau thanh toán');
    assert.strictEqual(env.get('isSubmitting'), false);
    assert.strictEqual(env.get('isConfirming'), false);
    assert.strictEqual(env.get('isPendingRecovery'), false);

    // Kiểm tra các ô điều khiển phải mở khóa ngay lập tức
    assert.strictEqual(env.elements['s-qty'].disabled, false, 'Ô s-qty phải mở khóa để nhập giao dịch tiếp theo');
    assert.strictEqual(env.elements['s-product'].disabled, false, 'Ô s-product phải mở khóa');
    assert.strictEqual(env.elements['s-search'].disabled, false, 'Ô s-search phải mở khóa');
    assert.strictEqual(env.elements['btn-add-item'].disabled, false, 'Nút Thêm phải mở khóa');
    assert.strictEqual(env.elements['btn-checkout'].disabled, true, 'Nút thanh toán phải bị disable vì giỏ rỗng');

    // Thêm sản phẩm cho giao dịch tiếp theo
    env.elements['s-product'].value = '1';
    env.elements['s-qty'].value = '2';
    env.call('addSaleItem');
    assert.strictEqual(env.get('cart').length, 1, 'Thêm sản phẩm cho giao dịch tiếp theo thành công');
    assert.strictEqual(env.get('cart')[0].quantity, 2);

    console.log('✔ ĐẠT: Thanh toán tiền mặt thành công mở lại toàn bộ điều khiển, thêm được giao dịch tiếp theo.');
  }

  // TEST 3: Thanh toán QR thành công -> thêm được giao dịch tiếp theo
  console.log('\n--- Test 3: Thanh toán QR thành công -> thêm được giao dịch tiếp theo ---');
  {
    const env = createEnv(async (url, opts) => {
      if (url === '/api/invoices') {
        const body = JSON.parse(opts.body);
        return {
          status: 201,
          ok: true,
          json: async () => ({ id: 502, invoice_no: body.invoice_no })
        };
      }
      if (url.includes('/api/products')) {
        return {
          ok: true,
          json: async () => ([
            { id: 1, sku: 'SP001', name: 'Sản phẩm 1', unit: 'Cái', sale_price: 100000, stock_quantity: 10, is_active: true }
          ])
        };
      }
      return { ok: true, json: async () => ({}) };
    });

    env.set('productsMap', {
      1: { id: 1, sku: 'SP001', name: 'Sản phẩm 1', unit: 'Cái', sale_price: 100000, stock_quantity: 10, is_active: true }
    });
    env.set('cart', [{ product_id: 1, sku: 'SP001', name: 'Sản phẩm 1', quantity: 1, unit_price: 100000 }]);
    env.set('preparedQrData', { transfer_content: 'POS12345678', amount: 100000 });
    env.set('selectedPaymentMethod', 'BANK_TRANSFER');

    // Xác nhận QR thành công
    await env.call('confirmQrPayment');

    assert.strictEqual(env.get('cart').length, 0);
    assert.strictEqual(env.get('isConfirming'), false);
    assert.strictEqual(env.get('isPendingRecovery'), false);

    // Kiểm tra điều khiển mở khóa
    assert.strictEqual(env.elements['s-qty'].disabled, false, 'Ô s-qty phải mở khóa sau QR');
    assert.strictEqual(env.elements['s-product'].disabled, false, 'Ô s-product phải mở khóa sau QR');
    assert.strictEqual(env.elements['s-search'].disabled, false, 'Ô s-search phải mở khóa sau QR');
    assert.strictEqual(env.elements['btn-add-item'].disabled, false, 'Nút Thêm phải mở khóa sau QR');
    assert.strictEqual(env.elements['btn-checkout'].disabled, true, 'Nút thanh toán phải disable vì giỏ rỗng');

    // Thêm sản phẩm cho giao dịch tiếp theo
    env.elements['s-product'].value = '1';
    env.elements['s-qty'].value = '3';
    env.call('addSaleItem');
    assert.strictEqual(env.get('cart').length, 1);
    assert.strictEqual(env.get('cart')[0].quantity, 3);

    console.log('✔ ĐẠT: Thanh toán QR thành công mở lại toàn bộ điều khiển, thêm được giao dịch tiếp theo.');
  }

  // TEST 4: Xóa sản phẩm cuối khỏi giỏ -> ô số lượng vẫn sử dụng được
  console.log('\n--- Test 4: Xóa sản phẩm cuối khỏi giỏ -> ô số lượng vẫn sử dụng được ---');
  {
    const env = createEnv(async () => ({ ok: true }));

    env.set('cart', [{ product_id: 1, sku: 'SP001', name: 'Sản phẩm 1', quantity: 1, unit_price: 100000 }]);
    env.call('renderCart');
    assert.strictEqual(env.elements['btn-checkout'].disabled, false, 'Giỏ có hàng thì checkout enabled');

    // Xóa dòng sản phẩm cuối cùng
    env.call('removeSaleItem', 0);
    assert.strictEqual(env.get('cart').length, 0, 'Giỏ hàng đã rỗng');

    // Kiểm tra các ô điều khiển
    assert.strictEqual(env.elements['s-qty'].disabled, false, 'Ô s-qty vẫn sử dụng được sau khi xóa sạch giỏ');
    assert.strictEqual(env.elements['s-product'].disabled, false, 'Ô s-product vẫn sử dụng được');
    assert.strictEqual(env.elements['s-search'].disabled, false, 'Ô s-search vẫn sử dụng được');
    assert.strictEqual(env.elements['btn-add-item'].disabled, false, 'Nút Thêm vẫn sử dụng được');
    assert.strictEqual(env.elements['btn-checkout'].disabled, true, 'Nút thanh toán phải bị disable');

    console.log('✔ ĐẠT: Xóa sản phẩm cuối khỏi giỏ, các ô điều khiển thêm vẫn sử dụng bình thường.');
  }

  // TEST 5: Đang phục hồi -> không sửa được giỏ
  console.log('\n--- Test 5: Đang phục hồi -> không sửa được giỏ ---');
  {
    const env = createEnv(async () => ({ ok: true }));

    env.set('productsMap', {
      1: { id: 1, sku: 'SP001', name: 'Sản phẩm 1', unit: 'Cái', sale_price: 100000, stock_quantity: 10, is_active: true }
    });
    env.set('cart', [{ product_id: 1, sku: 'SP001', name: 'Sản phẩm 1', quantity: 1, unit_price: 100000 }]);
    env.set('isPendingRecovery', true);
    env.set('pendingConfirmationPayload', {
      invoice_no: 'HD_RECOVERING',
      request_key: 'req-rec-001',
      payment_method: 'CASH',
      items: [{ product_id: 1, quantity: 1, unit_price: 100000 }]
    });

    env.call('renderCart');

    // Kiểm tra toàn bộ điều khiển bị khóa
    assert.strictEqual(env.elements['s-qty'].disabled, true, 'Ô s-qty phải bị khóa khi đang phục hồi');
    assert.strictEqual(env.elements['s-product'].disabled, true, 'Ô s-product phải bị khóa khi đang phục hồi');
    assert.strictEqual(env.elements['s-search'].disabled, true, 'Ô s-search phải bị khóa khi đang phục hồi');
    assert.strictEqual(env.elements['btn-add-item'].disabled, true, 'Nút Thêm phải bị khóa khi đang phục hồi');

    // Thử gọi các hàm chỉnh sửa giỏ
    env.call('addSaleItem');
    assert.ok(env.alerts.some(a => a.includes('phục hồi giao dịch')), 'addSaleItem phải bị chặn');

    env.alerts.length = 0;
    env.call('updateCartItemQty', 0, 5);
    assert.strictEqual(env.get('cart')[0].quantity, 1, 'updateCartItemQty không được đổi số lượng');

    env.call('removeSaleItem', 0);
    assert.strictEqual(env.get('cart').length, 1, 'removeSaleItem không được xóa dòng');

    console.log('✔ ĐẠT: Đang phục hồi, toàn bộ điều khiển bị khóa và không thể sửa giỏ hàng.');
  }

  // TEST 6: Kiểm tra nút Thêm theo sản phẩm đang chọn và tồn kho
  console.log('\n--- Test 6: Nút Thêm kiểm tra sản phẩm đang chọn và tồn kho ---');
  {
    const env = createEnv(async () => ({ ok: true }));

    env.set('productsMap', {
      1: { id: 1, sku: 'SP001', name: 'Còn hàng', unit: 'Cái', sale_price: 50000, stock_quantity: 5, is_active: true },
      2: { id: 2, sku: 'SP002', name: 'Hết hàng', unit: 'Cái', sale_price: 50000, stock_quantity: 0, is_active: true }
    });

    // 1. Chưa chọn sản phẩm: nút Thêm enabled (để khi click báo lỗi chọn sản phẩm)
    env.elements['s-product'].value = '';
    env.call('onProductSelectChange');
    assert.strictEqual(env.elements['btn-add-item'].disabled, false);

    // 2. Chọn sản phẩm còn hàng: nút Thêm enabled
    env.elements['s-product'].value = '1';
    env.call('onProductSelectChange');
    assert.strictEqual(env.elements['btn-add-item'].disabled, false);

    // 3. Chọn sản phẩm hết hàng: nút Thêm disabled
    env.elements['s-product'].value = '2';
    env.call('onProductSelectChange');
    assert.strictEqual(env.elements['btn-add-item'].disabled, true, 'Sản phẩm hết hàng thì nút Thêm phải disabled');

    console.log('✔ ĐẠT: Nút Thêm kiểm tra chính xác trạng thái tồn kho của sản phẩm được chọn.');
  }

  // TEST 7: Kiểm tra ô Số lượng mua (để trống, validation, tự xóa sau khi thêm)
  console.log('\n--- Test 7: Kiểm tra ô Số lượng mua (để trống, validation, tự xóa sau khi thêm) ---');
  {
    // Kiểm tra cấu trúc HTML views/sales.html
    const salesHtmlPath = path.join(__dirname, '../views/sales.html');
    const salesHtml = fs.readFileSync(salesHtmlPath, 'utf8');

    assert.ok(salesHtml.includes('id="s-qty"'), 'views/sales.html phải có thẻ s-qty');
    assert.ok(salesHtml.includes('placeholder="Nhập số lượng"'), 's-qty phải có placeholder="Nhập số lượng"');
    assert.ok(salesHtml.includes('min="1"'), 's-qty phải có min="1"');
    assert.ok(salesHtml.includes('step="1"'), 's-qty phải có step="1"');
    // Đảm bảo không chứa value="1" trong thẻ s-qty
    const sqtyTagMatch = salesHtml.match(/<input[^>]*id="s-qty"[^>]*>/);
    assert.ok(sqtyTagMatch, 'Phải tìm thấy thẻ input s-qty');
    assert.ok(!sqtyTagMatch[0].includes('value="1"'), 'Thẻ s-qty không được chứa value="1"');

    const env = createEnv(async () => ({ ok: true }));
    env.set('productsMap', {
      1: { id: 1, sku: 'SP001', name: 'Sản phẩm 1', unit: 'Hộp', sale_price: 50000, stock_quantity: 5, is_active: true }
    });

    // 1. Để trống rồi bấm Thêm -> Phải báo "Vui lòng nhập số lượng mua"
    env.elements['s-product'].value = '1';
    env.elements['s-qty'].value = '';
    env.alerts.length = 0;
    env.call('addSaleItem');
    assert.strictEqual(env.get('cart').length, 0, 'Giỏ không được thêm khi để trống số lượng');
    assert.ok(env.alerts.some(a => a.includes('Vui lòng nhập số lượng mua')), 'Phải báo "Vui lòng nhập số lượng mua"');

    // 2. Nhập số không hợp lệ (<= 0 hoặc thập phân)
    const invalidValues = ['0', '-1', '1.5', 'abc'];
    for (const val of invalidValues) {
      env.elements['s-qty'].value = val;
      env.alerts.length = 0;
      env.call('addSaleItem');
      assert.strictEqual(env.get('cart').length, 0);
      assert.ok(env.alerts.some(a => a.includes('số nguyên dương')), `Giá trị "${val}" phải bị từ chối với thông báo số nguyên dương`);
    }

    // 3. Nhập số lượng hợp lệ (ví dụ: 2) -> Thêm thành công, ô s-qty tự động để trống
    env.elements['s-qty'].value = '2';
    env.alerts.length = 0;
    env.call('addSaleItem');
    assert.strictEqual(env.get('cart').length, 1, 'Thêm thành công vào giỏ');
    assert.strictEqual(env.get('cart')[0].quantity, 2);
    assert.strictEqual(env.elements['s-qty'].value, '', 'Ô s-qty phải tự động để trống sau khi thêm thành công');

    // 4. Thử thêm vượt tồn kho (tồn là 5, đã có 2, thêm 4 -> tổng 6 > 5)
    env.elements['s-qty'].value = '4';
    env.alerts.length = 0;
    env.call('addSaleItem');
    assert.strictEqual(env.get('cart')[0].quantity, 2, 'Giỏ giữ nguyên');
    assert.ok(env.alerts.some(a => a.includes('vượt quá tồn kho')), 'Phải báo lỗi vượt tồn kho');

    console.log('✔ ĐẠT: Ô Số lượng mua để trống khi mở/sau thêm, báo "Vui lòng nhập số lượng mua" khi trống, và kiểm tra tồn kho chính xác.');
  }

  console.log('\n=== TẤT CẢ CÁC BÀI KIỂM TRA ĐIỀU KHIỂN BÁN HÀNG ĐÃ HOÀN THÀNH VÀ ĐẠT 100% ===');
}

runControlsLifecycleTest().catch(err => {
  console.error('LỖI KIỂM THỬ:', err);
  process.exit(1);
});
