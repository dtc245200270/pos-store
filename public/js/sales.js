// Quản lý Bán Hàng tại quầy
let currentRequestKey = Date.now().toString() + '-' + Math.random().toString(36).substring(2);
let currentInvoiceNo = 'HD' + Date.now();
let cart = [];
let allProducts = [];
let productsMap = {};
let isSubmitting = false;
let isPendingRecovery = false;
let lastCreatedInvoice = null;
let invoiceModalInstance = null;
let currentLoadedInvoice = null;

// ============================================================================
// 1. THÔNG BÁO VÀ TIỆN ÍCH HIỂN THỊ
// ============================================================================

function showSalesMessage(message, type = 'info') {
  const msgBox = document.getElementById('sales-msg');
  if (!msgBox) return;
  msgBox.className = `alert alert-${type} mb-3`;
  msgBox.textContent = message;
  msgBox.classList.remove('d-none');
}

function clearSalesMessage() {
  const msgBox = document.getElementById('sales-msg');
  if (msgBox) {
    msgBox.classList.add('d-none');
    msgBox.textContent = '';
  }
}

function updateInvoiceNoDisplay() {
  const el = document.getElementById('display-invoice-no');
  if (el) el.textContent = currentInvoiceNo;
}

function dismissSuccessBox() {
  const box = document.getElementById('sales-success-box');
  if (box) box.classList.add('d-none');
}

// Định dạng ngày giờ theo giờ Việt Nam Asia/Ho_Chi_Minh
function formatDateTimeVN(dateVal) {
  if (!dateVal) return 'Không rõ';
  const d = new Date(dateVal);
  if (isNaN(d.getTime())) return 'Không rõ';
  return d.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
}

// ============================================================================
// 2. KHỞI TẠO DỮ LIỆU & TÌM KIẾM SẢN PHẨM (TÊN HOẶC SKU)
// ============================================================================

async function initUserInfo() {
  try {
    const res = await window.apiFetch('/api/auth/me');
    if (!res || !res.ok) return;
    const user = await res.json();
    const sellerEl = document.getElementById('display-seller-info');
    if (sellerEl) {
      const roleText = user.role === 'MANAGER' ? 'Quản lý' : 'Thu ngân';
      sellerEl.textContent = `${user.fullName || user.username} (${roleText})`;
    }
  } catch (err) {
    console.error('Lỗi lấy thông tin người dùng:', err);
  }
}

// Tải danh sách sản phẩm còn hoạt động từ server
async function loadProducts() {
  try {
    const res = await window.apiFetch('/api/products?active_only=true');
    if (!res || !res.ok) return;
    const data = await res.json();
    allProducts = data || [];
    productsMap = {};
    allProducts.forEach(p => {
      productsMap[p.id] = p;
    });

    renderProductOptions(allProducts);
    onProductSelectChange();
    updateInvoiceNoDisplay();
  } catch (err) {
    console.error('Lỗi tải sản phẩm:', err);
  }
}

// Render các lựa chọn sản phẩm vào thẻ select
function renderProductOptions(productsList) {
  const sel = document.getElementById('s-product');
  if (!sel) return;

  const currentSelectedId = sel.value;
  sel.innerHTML = '<option value="">-- Chọn sản phẩm --</option>';

  productsList.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    const stock = Number(p.stock_quantity);
    const stockText = stock <= 0 ? ' [HẾT HÀNG]' : ` - Tồn: ${stock} ${p.unit}`;
    opt.textContent = `${p.name} (SKU: ${p.sku})${stockText} - Giá: ${Number(p.sale_price).toLocaleString('vi-VN')} đ`;
    if (String(p.id) === String(currentSelectedId)) {
      opt.selected = true;
    }
    sel.appendChild(opt);
  });
}

// Lọc sản phẩm theo tên hoặc SKU khi người dùng gõ tìm kiếm
function filterProductOptions(query) {
  const cleanQ = (query || '').trim().toLowerCase();
  if (!cleanQ) {
    renderProductOptions(allProducts);
    onProductSelectChange();
    return;
  }

  const filtered = allProducts.filter(p => {
    const matchName = (p.name || '').toLowerCase().includes(cleanQ);
    const matchSku = (p.sku || '').toLowerCase().includes(cleanQ);
    return matchName || matchSku;
  });

  renderProductOptions(filtered);

  // Nếu lọc chỉ còn đúng 1 sản phẩm khớp, tự động chọn sản phẩm đó
  const sel = document.getElementById('s-product');
  if (filtered.length === 1 && sel) {
    sel.value = filtered[0].id;
  }
  onProductSelectChange();
}

// Cập nhật thông tin chi tiết (ĐVT, Giá bán, Tồn kho) khi chọn sản phẩm
function onProductSelectChange() {
  const sel = document.getElementById('s-product');
  const infoBox = document.getElementById('s-product-info-box');
  const addBtn = document.getElementById('btn-add-item');
  if (!sel || !infoBox) return;

  const selectedId = sel.value;
  if (!selectedId || !productsMap[selectedId]) {
    infoBox.classList.add('d-none');
    if (addBtn) addBtn.disabled = false;
    return;
  }

  const p = productsMap[selectedId];
  const stock = Number(p.stock_quantity);

  infoBox.classList.remove('d-none');
  document.getElementById('info-p-sku').textContent = p.sku;
  document.getElementById('info-p-unit').textContent = p.unit;
  document.getElementById('info-p-price').textContent = `${Number(p.sale_price).toLocaleString('vi-VN')} đ`;

  const stockBadge = document.getElementById('info-p-stock');
  if (stockBadge) {
    if (stock <= 0) {
      stockBadge.className = 'badge bg-danger';
      stockBadge.textContent = '0 (Hết hàng)';
      if (addBtn) addBtn.disabled = true;
    } else {
      stockBadge.className = 'badge bg-success';
      stockBadge.textContent = `${stock} ${p.unit}`;
      if (addBtn) addBtn.disabled = false;
    }
  }
}

// ============================================================================
// 3. QUẢN LÝ GIỎ HÀNG: THÊM, CỘNG DỒN, SỬA SỐ LƯỢNG, XÓA
// ============================================================================

function addSaleItem(event) {
  if (event) event.preventDefault();
  if (isSubmitting || isPendingRecovery) {
    return alert('Đang trong quá trình xử lý thanh toán, không thể sửa giỏ hàng.');
  }

  clearSalesMessage();

  const id = document.getElementById('s-product').value;
  const qtyInput = document.getElementById('s-qty');
  const qtyRaw = qtyInput.value.trim();
  const qty = Number(qtyRaw);

  if (!id) {
    return alert('Vui lòng chọn sản phẩm cần thêm vào giỏ hàng.');
  }

  // 1. Chỉ nhận số lượng nguyên dương
  if (!qtyRaw || isNaN(qty) || !Number.isInteger(qty) || qty <= 0) {
    return alert('Số lượng phải là số nguyên dương (> 0).');
  }

  const p = productsMap[id];
  if (!p) return;

  // 2. Sản phẩm hết hàng / ngừng kinh doanh không được thêm
  const stock = Number(p.stock_quantity);
  if (stock <= 0) {
    showSalesMessage('Sản phẩm đã hết hàng (Tồn: 0). Không thể thêm vào giỏ hàng.', 'warning');
    return alert('Sản phẩm đã hết hàng. Không thể thêm vào giỏ hàng.');
  }
  if (!p.is_active) {
    showSalesMessage('Sản phẩm đã ngừng kinh doanh. Không thể thêm vào giỏ hàng.', 'warning');
    return alert('Sản phẩm đã ngừng kinh doanh.');
  }

  // 3. Thêm nhiều lần phải cộng dồn và kiểm tra tổng số lượng không vượt tồn kho
  const existing = cart.find(c => c.product_id === p.id);
  const existingQty = existing ? existing.quantity : 0;
  const totalRequestedQty = existingQty + qty;

  if (totalRequestedQty > stock) {
    const errText = `Không thể thêm: Tổng số lượng trong giỏ (${totalRequestedQty}) vượt quá tồn kho hiện có (${stock}). Giỏ hàng được giữ nguyên.`;
    showSalesMessage(errText, 'danger');
    return alert(errText);
  }

  // Thêm thành công: xóa thông báo lỗi cũ
  clearSalesMessage();

  if (existing) {
    existing.quantity = totalRequestedQty;
  } else {
    cart.push({
      product_id: p.id,
      sku: p.sku,
      name: p.name,
      unit: p.unit,
      quantity: qty,
      unit_price: Number(p.sale_price),
      stock_quantity: stock
    });
  }

  qtyInput.value = '1';
  currentRequestKey = Date.now().toString() + '-' + Math.random().toString(36).substring(2);
  renderCart();
}

// Sửa số lượng ngay trong giỏ hàng
function updateCartItemQty(index, newQtyVal) {
  if (isSubmitting || isPendingRecovery) return;

  const qty = Number(newQtyVal);

  // Chỉ nhận số lượng nguyên dương
  if (isNaN(qty) || !Number.isInteger(qty) || qty <= 0) {
    alert('Số lượng phải là số nguyên dương (> 0).');
    renderCart(); // Hoàn tác về giá trị hợp lệ trước đó
    return;
  }

  if (index < 0 || index >= cart.length) return;

  const item = cart[index];
  const p = productsMap[item.product_id];
  const stock = p ? Number(p.stock_quantity) : item.stock_quantity;

  // Kiểm tra tồn kho
  if (qty > stock) {
    const errText = `Không thể sửa: Số lượng yêu cầu (${qty}) vượt quá tồn kho hiện có (${stock}).`;
    showSalesMessage(errText, 'danger');
    alert(errText);
    renderCart(); // Hoàn tác về giá trị hợp lệ trước đó
    return;
  }

  clearSalesMessage();
  item.quantity = qty;
  currentRequestKey = Date.now().toString() + '-' + Math.random().toString(36).substring(2);
  renderCart();
}

// Nút tăng/giảm số lượng nhanh (+ / -) trong giỏ
function stepCartQty(index, delta) {
  if (isSubmitting || isPendingRecovery) return;
  if (index < 0 || index >= cart.length) return;
  const targetQty = cart[index].quantity + delta;
  if (targetQty <= 0) {
    if (confirm(`Bạn có muốn xóa sản phẩm "${cart[index].name}" khỏi giỏ hàng không?`)) {
      removeSaleItem(index);
    }
    return;
  }
  updateCartItemQty(index, targetQty);
}

// Xóa sản phẩm khỏi giỏ hàng
function removeSaleItem(index, event) {
  if (event) event.preventDefault();
  if (isSubmitting || isPendingRecovery) return;

  // Xóa sản phẩm phải cập nhật tổng tiền và xóa lỗi cũ
  clearSalesMessage();

  if (index >= 0 && index < cart.length) {
    cart.splice(index, 1);
    currentRequestKey = Date.now().toString() + '-' + Math.random().toString(36).substring(2);
    renderCart();
  }
}

// Render bảng giỏ hàng
function renderCart() {
  const tbody = document.querySelector('#s-cart tbody');
  const countBadge = document.getElementById('cart-item-count');
  const totalEl = document.getElementById('s-total');
  const checkoutBtn = document.getElementById('btn-checkout');

  if (!tbody) return;
  tbody.innerHTML = '';
  let total = 0;

  if (countBadge) {
    countBadge.textContent = `${cart.length} loại sản phẩm`;
  }

  if (cart.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="8" class="text-center text-muted py-4"><i class="bi bi-cart-x fs-3 d-block mb-1"></i>Chưa có sản phẩm nào trong giỏ hàng</td>';
    tbody.appendChild(tr);
    if (totalEl) totalEl.textContent = '0 đ';
    if (checkoutBtn) {
      checkoutBtn.disabled = true;
      checkoutBtn.classList.add('disabled');
    }
    return;
  }

  if (checkoutBtn && !isSubmitting) {
    checkoutBtn.disabled = false;
    checkoutBtn.classList.remove('disabled');
  }

  cart.forEach((c, i) => {
    const tr = document.createElement('tr');
    const lineTotal = c.unit_price * c.quantity;

    const disabledAttr = (isSubmitting || isPendingRecovery) ? 'disabled' : '';

    tr.innerHTML = `
      <td class="text-center">${i + 1}</td>
      <td class="fw-semibold text-primary font-monospace">${c.sku || 'N/A'}</td>
      <td class="fw-semibold">${c.name}</td>
      <td class="text-center">${c.unit || ''}</td>
      <td class="text-end">${Number(c.unit_price).toLocaleString('vi-VN')} đ</td>
      <td class="text-center">
        <div class="input-group input-group-sm justify-content-center" style="width: 125px; margin: 0 auto;">
          <button type="button" class="btn btn-outline-secondary px-2" onclick="stepCartQty(${i}, -1)" ${disabledAttr}>-</button>
          <input type="number" class="form-control text-center fw-bold px-1" min="1" step="1" value="${c.quantity}" onchange="updateCartItemQty(${i}, this.value)" ${disabledAttr}>
          <button type="button" class="btn btn-outline-secondary px-2" onclick="stepCartQty(${i}, 1)" ${disabledAttr}>+</button>
        </div>
      </td>
      <td class="text-end fw-bold text-danger">${Number(lineTotal).toLocaleString('vi-VN')} đ</td>
      <td class="text-center">
        <button type="button" class="btn btn-sm btn-outline-danger" onclick="removeSaleItem(${i}, event)" ${disabledAttr} title="Xóa dòng">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" class="bi bi-trash" viewBox="0 0 16 16">
            <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z"/>
            <path fill-rule="evenodd" d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/>
          </svg>
        </button>
      </td>
    `;
    tbody.appendChild(tr);
    total += lineTotal;
  });

  if (totalEl) totalEl.textContent = `${Number(total).toLocaleString('vi-VN')} đ`;
}

// ============================================================================
// 4. XỬ LÝ THANH TOÁN (KHÓA LẶP, KIỂM TRA LẠI Ở BACKEND, GIỮ GIỎ KHI LỖI)
// ============================================================================

async function checkout(event) {
  if (event) event.preventDefault();

  // 1. Giỏ trống không được thanh toán
  if (cart.length === 0) {
    showSalesMessage('Giỏ hàng trống. Vui lòng thêm sản phẩm vào giỏ trước khi thanh toán.', 'warning');
    alert('Giỏ hàng trống. Vui lòng thêm sản phẩm vào giỏ trước khi thanh toán.');
    return;
  }

  // 2. Khóa thao tác gửi lặp khi đang xử lý
  if (isSubmitting) return;

  clearSalesMessage();
  dismissSuccessBox();
  isSubmitting = true;
  renderCart();

  const btn = document.getElementById('btn-checkout');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status"></span>Đang xử lý thanh toán (Khóa gửi lặp)...';
  }

  // Chuẩn bị payload gửi lên server
  // Backend tự lấy giá bán và kiểm tra lại sản phẩm, trạng thái và tồn kho từ DB
  const payload = {
    invoice_no: currentInvoiceNo,
    request_key: currentRequestKey,
    items: cart.map(c => ({
      product_id: c.product_id,
      quantity: c.quantity,
      unit_price: c.unit_price
    }))
  };

  try {
    const res = await window.apiFetch('/api/invoices', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    if (res && (res.status === 201 || res.status === 200)) {
      const data = await res.json().catch(() => ({}));
      const actualInvoiceNo = data.invoice_no || currentInvoiceNo;
      lastCreatedInvoice = { id: data.id, invoice_no: actualInvoiceNo };

      // Hiển thị mã hóa đơn thực tế đã lưu và hộp thao tác xem / in
      const successBox = document.getElementById('sales-success-box');
      const successNoEl = document.getElementById('success-invoice-no');
      if (successNoEl) successNoEl.textContent = actualInvoiceNo;
      if (successBox) successBox.classList.remove('d-none');

      showSalesMessage(`Thanh toán thành công! Mã hóa đơn: ${actualInvoiceNo}`, 'success');

      // Sau thành công: làm trống giỏ và cập nhật lại tồn kho
      isPendingRecovery = false;
      cart = [];
      currentRequestKey = Date.now().toString() + '-' + Math.random().toString(36).substring(2);
      currentInvoiceNo = 'HD' + Date.now();
      updateInvoiceNoDisplay();
      renderCart();

      // Cập nhật lại tồn kho mới nhất từ DB
      await loadProducts();
    } else if (res && res.status === 409) {
      isPendingRecovery = false;
      const e = await res.json().catch(() => ({}));
      if (e.requires_confirmation) {
        if (confirm(e.error + '\nBạn có muốn cập nhật lại đơn giá mới cho giỏ hàng để thanh toán tiếp không?')) {
          await loadProducts();
          cart.forEach(c => {
            if (productsMap[c.product_id]) {
              c.unit_price = Number(productsMap[c.product_id].sale_price);
            }
          });
          currentRequestKey = Date.now().toString() + '-' + Math.random().toString(36).substring(2);
          showSalesMessage('Đơn giá đã được cập nhật lại theo giá mới nhất. Vui lòng bấm Thanh toán lần nữa.', 'info');
        }
      } else {
        showSalesMessage(e.error || 'Xung đột yêu cầu thanh toán (Conflict)', 'danger');
        alert(e.error || 'Xung đột yêu cầu thanh toán');
      }
      renderCart(); // Giữ nguyên giỏ hàng
    } else {
      isPendingRecovery = false;
      let data = {};
      try { data = await res.json(); } catch (err) {}
      const errText = data.error || 'Lỗi thanh toán';
      showSalesMessage(errText, 'danger');
      alert(errText);

      // Cập nhật lại thông tin tồn kho mới nhất để người dùng nắm được
      await loadProducts();
      renderCart(); // Giữ nguyên giỏ hàng để thử lại an toàn
    }
  } catch (err) {
    console.error('Lỗi kết nối khi thanh toán:', err);
    isPendingRecovery = true;
    showSalesMessage('Mất kết nối tới máy chủ khi thanh toán. Giỏ hàng được giữ nguyên để bạn thử lại an toàn.', 'danger');
    alert('Mất kết nối máy chủ khi thanh toán. Giỏ hàng được giữ nguyên để thử lại.');
    renderCart(); // Giữ nguyên giỏ hàng
  } finally {
    isSubmitting = false;
    renderCart();
    if (btn) {
      btn.disabled = cart.length === 0;
      btn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" class="bi bi-wallet2 me-2" viewBox="0 0 16 16">
          <path d="M12.136.326A1.5 1.5 0 0 1 14 1.78V3h.5A1.5 1.5 0 0 1 16 4.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 0 13.5v-9a1.5 1.5 0 0 1 1.432-1.499L12.136.326zM5.562 3H13V1.78a.5.5 0 0 0-.621-.484L5.562 3zM1.5 4a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-9a.5.5 0 0 0-.5-.5h-13z"/>
        </svg>
        XÁC NHẬN THANH TOÁN (TIỀN MẶT)
      `;
    }
  }
}

// ============================================================================
// 5. XEM / IN HÓA ĐƠN VỪA LẬP TRỰC TIẾP TẠI TRANG BÁN HÀNG
// ============================================================================

function openInvoiceModal() {
  const modalEl = document.getElementById('invoice-modal');
  if (!modalEl) return;

  if (window.bootstrap && window.bootstrap.Modal) {
    if (!invoiceModalInstance) {
      invoiceModalInstance = new window.bootstrap.Modal(modalEl, { backdrop: true, keyboard: true });
    }
    invoiceModalInstance.show();
  } else {
    modalEl.style.display = 'block';
    modalEl.classList.add('show');
    const backdrop = document.getElementById('modal-backdrop');
    if (backdrop) backdrop.style.display = 'block';
    document.body.classList.add('modal-open');
  }
}

function closeInvoiceModal() {
  const modalEl = document.getElementById('invoice-modal');
  if (invoiceModalInstance) {
    invoiceModalInstance.hide();
  }
  if (modalEl) {
    modalEl.style.display = 'none';
    modalEl.classList.remove('show');
  }
  const backdrop = document.getElementById('modal-backdrop');
  if (backdrop) backdrop.style.display = 'none';
  document.body.classList.remove('modal-open');
}

function printInvoice() {
  if (!currentLoadedInvoice || !currentLoadedInvoice.invoice) {
    alert('Dữ liệu hóa đơn chưa sẵn sàng để in.');
    return;
  }
  const printSection = document.getElementById('invoice-print-section');
  if (!printSection || !printSection.innerHTML.trim()) {
    alert('Không tìm thấy nội dung hóa đơn để in.');
    return;
  }
  window.print();
}

function renderReceiptHtml(inv, items) {
  const dateStr = formatDateTimeVN(inv.created_at);
  const sellerStr = inv.created_by_name || 'Thu ngân';
  const totalAmountStr = Number(inv.total_amount).toLocaleString('vi-VN') + ' đ';

  let itemsHtml = '';
  if (items.length === 0) {
    itemsHtml = `<tr><td colspan="7" class="text-center text-muted py-3">Hóa đơn không có sản phẩm</td></tr>`;
  } else {
    items.forEach((it, idx) => {
      const lineTotal = Number(it.quantity) * Number(it.unit_price);
      itemsHtml += `
        <tr>
          <td class="text-center">${idx + 1}</td>
          <td class="fw-semibold text-primary font-monospace">${it.sku || 'N/A'}</td>
          <td class="fw-semibold">${it.product_name_snapshot || ''}</td>
          <td class="text-center">${it.unit_snapshot || ''}</td>
          <td class="text-center fw-bold">${it.quantity}</td>
          <td class="text-end">${Number(it.unit_price).toLocaleString('vi-VN')} đ</td>
          <td class="text-end fw-bold">${Number(lineTotal).toLocaleString('vi-VN')} đ</td>
        </tr>
      `;
    });
  }

  return `
    <div class="invoice-receipt-wrapper">
      <div class="text-center mb-4 pb-2 border-bottom">
        <h3 class="fw-bold mb-1">CỬA HÀNG POS STORE</h3>
        <p class="text-muted small mb-1">Hệ thống quản lý bán hàng & thanh toán</p>
        <h4 class="fw-bold text-uppercase mt-2 text-dark">HÓA ĐƠN BÁN HÀNG</h4>
      </div>

      <div class="row g-2 mb-3">
        <div class="col-sm-6">
          <p class="mb-1"><strong>Mã hóa đơn:</strong> <span class="text-primary fw-bold">${inv.invoice_no}</span></p>
          <p class="mb-1"><strong>Người bán:</strong> <span>${sellerStr}</span></p>
        </div>
        <div class="col-sm-6 text-sm-end">
          <p class="mb-1"><strong>Ngày lập:</strong> <span>${dateStr}</span></p>
          <p class="mb-1"><strong>Phương thức:</strong> <span>Tiền mặt</span></p>
        </div>
      </div>

      <div class="table-responsive mb-3">
        <table class="table table-bordered table-sm align-middle mb-0">
          <thead class="table-light">
            <tr>
              <th class="text-center" style="width: 40px;">#</th>
              <th style="width: 120px;">Mã SKU</th>
              <th>Tên Sản Phẩm</th>
              <th class="text-center" style="width: 75px;">ĐVT</th>
              <th class="text-center" style="width: 65px;">SL</th>
              <th class="text-end" style="width: 130px;">Đơn Giá</th>
              <th class="text-end" style="width: 140px;">Thành Tiền</th>
            </tr>
          </thead>
          <tbody>
            ${itemsHtml}
          </tbody>
          <tfoot class="table-light">
            <tr>
              <th colspan="6" class="text-end fw-bold">Tổng cộng tiền thanh toán:</th>
              <th class="text-end fw-bold text-danger fs-6">${totalAmountStr}</th>
            </tr>
          </tfoot>
        </table>
      </div>

      <div class="text-center mt-4 pt-2 border-top text-muted small">
        <p class="mb-1 fw-semibold">Cảm ơn quý khách đã mua hàng tại POS Store!</p>
        <p class="mb-0">Hẹn gặp lại quý khách lần sau.</p>
      </div>
    </div>
  `;
}

async function viewSavedInvoice() {
  if (!lastCreatedInvoice || !lastCreatedInvoice.id) {
    alert('Không tìm thấy thông tin hóa đơn vừa thanh toán.');
    return;
  }
  await viewInvoiceDetails(lastCreatedInvoice.id);
}

async function viewInvoiceDetails(id) {
  const modalTitle = document.getElementById('invoice-modal-title');
  const previewArea = document.getElementById('invoice-preview-area');
  const printSection = document.getElementById('invoice-print-section');

  currentLoadedInvoice = null;
  if (printSection) printSection.innerHTML = '';
  if (modalTitle) modalTitle.textContent = `Chi Tiết Hóa Đơn #${id}`;
  if (previewArea) {
    previewArea.innerHTML = `
      <div class="text-center py-4">
        <div class="spinner-border text-primary" role="status"></div>
        <p class="mt-2 text-muted mb-0">Đang tải thông tin chi tiết hóa đơn...</p>
      </div>
    `;
  }
  openInvoiceModal();

  try {
    const res = await window.apiFetch('/api/invoices/' + id);
    if (!res || !res.ok) {
      const err = await res.json().catch(() => ({}));
      const msg = err.error || 'Không thể tải chi tiết hóa đơn.';
      if (previewArea) previewArea.innerHTML = `<div class="alert alert-danger">${msg}</div>`;
      alert(msg);
      return;
    }

    const data = await res.json();
    currentLoadedInvoice = data;
    const inv = data.invoice;
    const items = data.items || [];

    if (modalTitle) modalTitle.textContent = `Hóa Đơn: ${inv.invoice_no}`;

    const receiptHtml = renderReceiptHtml(inv, items);
    if (previewArea) previewArea.innerHTML = receiptHtml;
    if (printSection) printSection.innerHTML = receiptHtml;
  } catch (err) {
    console.error('Lỗi tải chi tiết hóa đơn:', err);
    if (previewArea) previewArea.innerHTML = '<div class="alert alert-danger">Lỗi kết nối khi tải chi tiết hóa đơn.</div>';
  }
}

// Khởi tạo trang bán hàng
document.addEventListener('DOMContentLoaded', async () => {
  renderCart();
  await initUserInfo();
  await loadProducts();
});