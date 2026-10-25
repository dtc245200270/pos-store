/**
 * POS Store - Frontend Script Bán Hàng Tại Quầy (Sales / POS Checkout)
 * Đường dẫn: public/js/sales.js
 *
 * Mục đích:
 * - Quản lý giỏ hàng bán hàng trực tiếp tại quầy thu ngân (POS).
 * - Tìm kiếm, lọc sản phẩm theo tên hoặc mã SKU nhanh chóng.
 * - Kiểm tra số lượng tồn kho theo thời gian thực trước khi thêm/sửa giỏ hàng.
 * - Hỗ trợ 2 phương thức thanh toán linh hoạt: Tiền mặt (CASH) và Chuyển khoản VietQR (BANK_TRANSFER).
 * - Quản lý trạng thái bất định (Indeterminate Recovery): Tự động bảo toàn giỏ hàng và khóa thao tác
 *   khi gặp sự cố mạng hoặc lỗi máy chủ 5xx, cho phép thu ngân bấm "Thử lại gửi yêu cầu" mà không mất dữ liệu.
 * - Hiển thị chi tiết và hỗ trợ in hóa đơn bán hàng theo chuẩn nhiệt hoặc khổ A4/A5.
 */

// ============================================================================
// KHỞI TẠO BIẾN TRẠNG THÁI TOÀN CỤC CỦA PHIÊN BÁN HÀNG
// ============================================================================
// Request key ngẫu nhiên bảo đảm tính Idempotent khi gửi yêu cầu lên server
let currentRequestKey = Date.now().toString() + '-' + Math.random().toString(36).substring(2);
// Số hóa đơn tạm tính theo thời gian thực (HD + timestamp)
let currentInvoiceNo = 'HD' + Date.now();
// Mảng lưu danh sách sản phẩm trong giỏ hàng hiện tại [{ product_id, sku, name, unit, quantity, unit_price, stock_quantity }]
let cart = [];
// Danh mục toàn bộ sản phẩm đang hoạt động được nạp từ máy chủ
let allProducts = [];
// Bảng tra cứu sản phẩm nhanh theo Product ID (Map: id -> product)
let productsMap = {};
// Cờ trạng thái đang gửi yêu cầu tạo hóa đơn (ngăn chặn double-click)
let isSubmitting = false;
// Cờ kích hoạt chế độ phục hồi bất định khi mất mạng hoặc server lỗi 5xx
let isPendingRecovery = false;
// Cờ đang gửi yêu cầu xác nhận thanh toán (chặn gửi lặp và không cho sửa giỏ hàng)
let isConfirming = false;
// Biến lưu trữ nguyên vẹn payload hóa đơn cần thử lại khi kết quả chưa xác định
let pendingConfirmationPayload = null;
// Dữ liệu hóa đơn vừa tạo thành công gần nhất để phục vụ xem/in ngay
let lastCreatedInvoice = null;
// Đối tượng modal Bootstrap xem chi tiết hóa đơn
let invoiceModalInstance = null;
// Dữ liệu hóa đơn chi tiết đang được nạp vào modal
let currentLoadedInvoice = null;

// Quản lý phương thức thanh toán và chuyển khoản QR
let selectedPaymentMethod = 'CASH'; // 'CASH' hoặc 'BANK_TRANSFER'
let bankConfig = null; // Cấu hình tài khoản ngân hàng thụ hưởng nhận từ máy chủ
let preparedQrData = null; // Dữ liệu phiên chuẩn bị QR từ API (/prepare-qr)
let qrModalInstance = null; // Đối tượng modal hiển thị mã VietQR

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
  if (el) {
    const no = (isPendingRecovery && pendingConfirmationPayload) ? pendingConfirmationPayload.invoice_no : currentInvoiceNo;
    el.textContent = no;
  }
}

function dismissSuccessBox() {
  const box = document.getElementById('sales-success-box');
  if (box) box.classList.add('d-none');
}

// Escape ký tự đặc biệt phòng chống tấn công XSS khi hiển thị HTML
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Định dạng ngày giờ theo giờ Việt Nam Asia/Ho_Chi_Minh
function formatDateTimeVN(dateVal) {
  if (!dateVal) return 'Không rõ';
  const d = new Date(dateVal);
  if (isNaN(d.getTime())) return 'Không rõ';
  return d.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
}

// Kích hoạt trạng thái phục hồi khi kết quả chưa xác định (mất mạng hoặc lỗi máy chủ 5xx)
function enterIndeterminateRecovery(message, paymentMethod) {
  isPendingRecovery = true;
  isConfirming = false;
  isSubmitting = false;

  const currentMethod = paymentMethod || (pendingConfirmationPayload ? pendingConfirmationPayload.payment_method : selectedPaymentMethod);

  if (currentMethod === 'CASH') {
    // Với CASH, không yêu cầu mở cửa sổ QR để thử lại
    showSalesMessage(`⚠️ Kết quả giao dịch tiền mặt chưa xác định: ${message}. Dữ liệu thanh toán được bảo toàn nguyên vẹn. Vui lòng bấm "Thử lại gửi yêu cầu (Tiền mặt)".`, 'warning');
    updatePaymentMethodUI();
    renderCart();
    return;
  }

  // Với BANK_TRANSFER:
  const alertEl = document.getElementById('qr-indeterminate-alert');
  if (alertEl) {
    alertEl.classList.remove('d-none');
    alertEl.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-exclamation-octagon-fill me-1" viewBox="0 0 16 16">
        <path d="M11.46.146A.5.5 0 0 0 11.107 0H4.893a.5.5 0 0 0-.353.146L.146 4.54A.5.5 0 0 0 0 4.893v6.214a.5.5 0 0 0 .146.353l4.394 4.394a.5.5 0 0 0 .353.146h6.214a.5.5 0 0 0 .353-.146l4.394-4.394a.5.5 0 0 0 .146-.353V4.893a.5.5 0 0 0-.146-.353L11.46.146zM8 4c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 4.995A.905.905 0 0 1 8 4zm.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2z"/>
      </svg>
      <strong>⚠️ Kết quả chưa xác định:</strong> ${escapeHtml(message)}
    `;
  }

  const confirmBtn = document.getElementById('btn-confirm-qr');
  if (confirmBtn) {
    confirmBtn.disabled = false;
    confirmBtn.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-arrow-repeat me-1" viewBox="0 0 16 16">
        <path d="M11.534 7h3.932a.25.25 0 0 1 .192.41l-1.966 2.36a.25.25 0 0 1-.384 0l-1.966-2.36a.25.25 0 0 1 .192-.41zm-11 2h3.932a.25.25 0 0 0 .192-.41L2.692 6.23a.25.25 0 0 0-.384 0L.342 8.59A.25.25 0 0 0 .534 9z"/>
        <path fill-rule="evenodd" d="M8 3c-1.552 0-2.94.707-3.857 1.818a.5.5 0 1 1-.771-.636A6.002 6.002 0 0 1 13.917 7H12.9A5.002 5.002 0 0 0 8 3zM3.1 9a5.002 5.002 0 0 0 8.757 2.182.5.5 0 1 1 .771.636A6.002 6.002 0 0 1 2.083 9H3.1z"/>
      </svg>
      Thử lại gửi yêu cầu
    `;
  }

  // Khóa nút hủy/quay lại giỏ hàng khi chưa xác định kết quả
  const cancelBtn = document.getElementById('btn-cancel-qr');
  if (cancelBtn) {
    cancelBtn.disabled = true;
    cancelBtn.title = 'Không thể hủy khi kết quả giao dịch chưa được xác định';
  }

  showSalesMessage('Kết quả giao dịch chưa xác định. Dữ liệu thanh toán được bảo toàn. Vui lòng bấm "Thử lại gửi yêu cầu" trên cửa sổ QR.', 'warning');
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

  const isLocked = isPendingRecovery || isConfirming || isSubmitting;
  const selectedId = sel.value;

  if (!selectedId || !productsMap[selectedId]) {
    infoBox.classList.add('d-none');
    if (addBtn) addBtn.disabled = isLocked;
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
      if (addBtn) addBtn.disabled = isLocked;
    }
  }
}

// ============================================================================
// 3. QUẢN LÝ GIỎ HÀNG: THÊM, CỘNG DỒN, SỬA SỐ LƯỢNG, XÓA
// ============================================================================

function addSaleItem(event) {
  if (event) event.preventDefault();
  if (isSubmitting || isPendingRecovery || isConfirming) {
    return alert('Đang trong quá trình xử lý thanh toán hoặc phục hồi giao dịch, không thể sửa giỏ hàng.');
  }

  clearSalesMessage();

  const id = document.getElementById('s-product').value;
  const qtyInput = document.getElementById('s-qty');
  const qtyRaw = qtyInput ? qtyInput.value.trim() : '';

  if (!id) {
    return alert('Vui lòng chọn sản phẩm cần thêm vào giỏ hàng.');
  }

  // 1. Khi để trống rồi bấm Thêm, báo “Vui lòng nhập số lượng mua”
  if (!qtyRaw) {
    showSalesMessage('Vui lòng nhập số lượng mua.', 'warning');
    return alert('Vui lòng nhập số lượng mua.');
  }

  const qty = Number(qtyRaw);

  // 2. Chỉ nhận số lượng nguyên dương
  if (isNaN(qty) || !Number.isInteger(qty) || qty <= 0) {
    showSalesMessage('Số lượng phải là số nguyên dương (> 0).', 'warning');
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

  if (qtyInput) qtyInput.value = '';
  preparedQrData = null;
  currentRequestKey = Date.now().toString() + '-' + Math.random().toString(36).substring(2);
  renderCart();
}

// Sửa số lượng ngay trong giỏ hàng
function updateCartItemQty(index, newQtyVal) {
  if (isSubmitting || isPendingRecovery || isConfirming) {
    alert('Đang trong quá trình xử lý thanh toán hoặc phục hồi giao dịch, không thể sửa giỏ hàng.');
    return;
  }

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
  preparedQrData = null;
  currentRequestKey = Date.now().toString() + '-' + Math.random().toString(36).substring(2);
  renderCart();
}

// Nút tăng/giảm số lượng nhanh (+ / -) trong giỏ
function stepCartQty(index, delta) {
  if (isSubmitting || isPendingRecovery || isConfirming) return;
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
  if (isSubmitting || isPendingRecovery || isConfirming) {
    alert('Đang trong quá trình xử lý thanh toán hoặc phục hồi giao dịch, không thể sửa giỏ hàng.');
    return;
  }

  // Xóa sản phẩm phải cập nhật tổng tiền và xóa lỗi cũ
  clearSalesMessage();

  if (index >= 0 && index < cart.length) {
    cart.splice(index, 1);
    preparedQrData = null;
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

  // 1. Cập nhật trạng thái khóa/mở điều khiển TRƯỚC nhánh giỏ hàng rỗng
  const addBtn = document.getElementById('btn-add-item');
  const selProduct = document.getElementById('s-product');
  const qtyInput = document.getElementById('s-qty');
  const searchInput = document.getElementById('s-search');
  const isLocked = isPendingRecovery || isConfirming || isSubmitting;

  if (selProduct) selProduct.disabled = isLocked;
  if (qtyInput) qtyInput.disabled = isLocked;
  if (searchInput) searchInput.disabled = isLocked;

  // Nút Thêm (btn-add-item) kiểm tra sản phẩm đang chọn và tồn kho
  if (addBtn) {
    if (isLocked) {
      addBtn.disabled = true;
    } else {
      const selectedId = selProduct ? selProduct.value : '';
      if (selectedId && productsMap[selectedId]) {
        const stock = Number(productsMap[selectedId].stock_quantity);
        addBtn.disabled = stock <= 0;
      } else {
        addBtn.disabled = false;
      }
    }
  }

  if (!tbody) return;
  tbody.innerHTML = '';
  let total = 0;

  if (countBadge) {
    countBadge.textContent = `${cart.length} loại sản phẩm`;
  }

  // 2. Nhánh giỏ hàng rỗng
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

  // 3. Giỏ hàng có sản phẩm
  if (checkoutBtn && !isSubmitting && !isConfirming && !isPendingRecovery) {
    checkoutBtn.disabled = false;
    checkoutBtn.classList.remove('disabled');
  }

  cart.forEach((c, i) => {
    const tr = document.createElement('tr');
    const lineTotal = c.unit_price * c.quantity;

    const disabledAttr = (isSubmitting || isPendingRecovery || isConfirming) ? 'disabled' : '';

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
      <td class="text-end fw-bold text-dark font-monospace">${Number(lineTotal).toLocaleString('vi-VN')} đ</td>
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
// 4. PHƯƠNG THỨC THANH TOÁN & QUẢN LÝ CHUYỂN KHOẢN QR
// ============================================================================

async function checkPaymentConfig() {
  try {
    const res = await window.apiFetch('/api/invoices/payment-config');
    if (res && res.ok) {
      bankConfig = await res.json();
    } else {
      bankConfig = { configured: false };
    }
  } catch (err) {
    bankConfig = { configured: false };
  }
  updatePaymentMethodUI();
}

function updatePaymentMethodUI() {
  const badge = document.getElementById('header-payment-badge');
  const checkoutBtn = document.getElementById('btn-checkout');
  const warningEl = document.getElementById('payment-config-warning');

  // Khôi phục hiển thị và nút thử lại nếu đang trong trạng thái phục hồi CASH
  if (isPendingRecovery && pendingConfirmationPayload) {
    if (pendingConfirmationPayload.payment_method === 'CASH') {
      if (badge) {
        badge.className = 'badge bg-warning text-dark fs-6 px-3 py-2';
        badge.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-exclamation-triangle-fill me-1" viewBox="0 0 16 16">
            <path d="M8.982 1.566a1.13 1.13 0 0 0-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 0 1-1.1 0L7.1 4.995A.905.905 0 0 1 8 5zm.002 6a1 1 0 1 1 0 2 1 1 0 0 1 0-2z"/>
          </svg>
          Đang phục hồi: Tiền mặt
        `;
      }
      if (warningEl) warningEl.classList.add('d-none');
      if (checkoutBtn && !isSubmitting && !isConfirming) {
        checkoutBtn.disabled = false;
        checkoutBtn.className = 'btn btn-warning btn-lg w-100 fw-bold py-2 shadow-sm';
        checkoutBtn.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" class="bi bi-arrow-repeat me-2" viewBox="0 0 16 16">
            <path d="M11.534 7h3.932a.25.25 0 0 1 .192.41l-1.966 2.36a.25.25 0 0 1-.384 0l-1.966-2.36a.25.25 0 0 1 .192-.41zm-11 2h3.932a.25.25 0 0 0 .192-.41L2.692 6.23a.25.25 0 0 0-.384 0L.342 8.59A.25.25 0 0 0 .534 9z"/>
            <path fill-rule="evenodd" d="M8 3c-1.552 0-2.94.707-3.857 1.818a.5.5 0 1 1-.771-.636A6.002 6.002 0 0 1 13.917 7H12.9A5.002 5.002 0 0 0 8 3zM3.1 9a5.002 5.002 0 0 0 8.757 2.182.5.5 0 1 1 .771.636A6.002 6.002 0 0 1 2.083 9H3.1z"/>
          </svg>
          THỬ LẠI GỬI YÊU CẦU (TIỀN MẶT)
        `;
      }
      return;
    }
  }

  if (selectedPaymentMethod === 'CASH') {
    if (badge) {
      badge.className = 'badge bg-primary fs-6 px-3 py-2';
      badge.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-cash me-1" viewBox="0 0 16 16">
          <path d="M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/>
          <path d="M0 4a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H1a1 1 0 0 1-1-1V4zm3 0a2 2 0 0 1-2 2v4a2 2 0 0 1 2 2h10a2 2 0 0 1 2-2V6a2 2 0 0 1-2-2H3z"/>
        </svg>
        Phương thức: Tiền mặt
      `;
    }
    if (warningEl) warningEl.classList.add('d-none');
    if (checkoutBtn && !isSubmitting && !isConfirming) {
      checkoutBtn.disabled = cart.length === 0;
      checkoutBtn.className = 'btn btn-primary btn-lg w-100 fw-bold py-2 shadow-sm';
      checkoutBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" class="bi bi-wallet2 me-2" viewBox="0 0 16 16">
          <path d="M12.136.326A1.5 1.5 0 0 1 14 1.78V3h.5A1.5 1.5 0 0 1 16 4.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 0 13.5v-9a1.5 1.5 0 0 1 1.432-1.499L12.136.326zM5.562 3H13V1.78a.5.5 0 0 0-.621-.484L5.562 3zM1.5 4a.5.5 0 0 0-.5.5v9a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-9a.5.5 0 0 0-.5-.5h-13z"/>
        </svg>
        XÁC NHẬN THANH TOÁN (TIỀN MẶT)
      `;
    }
  } else {
    // BANK_TRANSFER
    if (badge) {
      badge.className = 'badge bg-info text-dark fs-6 px-3 py-2';
      badge.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-qr-code-scan me-1" viewBox="0 0 16 16">
          <path d="M0 .5A.5.5 0 0 1 .5 0h3a.5.5 0 0 1 0 1H1v2.5a.5.5 0 0 1-1 0v-3Zm12 0a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5v3a.5.5 0 0 1-1 0V1h-2.5a.5.5 0 0 1-.5-.5ZM.5 12a.5.5 0 0 1 .5.5V15h2.5a.5.5 0 0 1 0 1h-3a.5.5 0 0 1-.5-.5v-3a.5.5 0 0 1 .5-.5Zm15 0a.5.5 0 0 1 .5.5v3a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1 0-1H15v-2.5a.5.5 0 0 1 .5-.5ZM4 4h1v1H4V4Z"/>
        </svg>
        Phương thức: Chuyển khoản QR
      `;
    }
    if (warningEl) {
      if (!bankConfig || !bankConfig.configured) {
        warningEl.classList.remove('d-none');
      } else {
        warningEl.classList.add('d-none');
      }
    }
    if (checkoutBtn && !isSubmitting && !isConfirming) {
      checkoutBtn.disabled = cart.length === 0;
      checkoutBtn.className = 'btn btn-primary btn-lg w-100 fw-bold py-2 shadow-sm';
      checkoutBtn.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" fill="currentColor" class="bi bi-qr-code me-2" viewBox="0 0 16 16">
          <path d="M2 2h2v2H2V2Z"/>
          <path d="M6 0v6H0V0h6ZM5 1H1v4h4V1ZM4 12H2v2h2v-2Z"/>
          <path d="M6 10v6H0v-6h6Zm-5 1v4h4v-4H1Zm11-9h2v2h-2V2Z"/>
          <path d="M10 0v6h6V0h-6Zm5 1v4h-4V1h4ZM8 1V0h1v2H8v2H7V1h1Zm0 5V4h1v2H8ZM6 8V7h1V6h1v2h1V7h5v1h-4v1H7V8H6Zm0 0v1H2V8H1v1H0V7h3v1h3Zm10 1h-1V7h1v2Zm-1 3v-1h1v1h-1Zm-4 4v-1h1v1h-1Zm-2 0v-1h1v1h-1Zm3-3v-1h1v1h-1Zm-2 0v-1h1v1h-1Zm-1-1v-1h1v1H9Zm1 1h1v1h-1v-1Zm2-2v-1h1v1h-1Zm1 1h-1v1h1v-1Zm2 2v-1h1v1h-1Zm-4 0v-1h1v1h-1Z"/>
        </svg>
        TẠO MÃ QR CHUYỂN KHOẢN
      `;
    }
  }
}

function onPaymentMethodChange() {
  if (isPendingRecovery && pendingConfirmationPayload) {
    const pm = pendingConfirmationPayload.payment_method;
    const pmName = (pm === 'BANK_TRANSFER') ? 'chuyển khoản QR' : 'tiền mặt';
    alert(`Đang có giao dịch ${pmName} chờ xác định kết quả. Không thể đổi phương thức thanh toán.`);
    
    // Khôi phục lựa chọn theo payment_method của payload đang chờ, không ép QR
    const cashRadio = document.getElementById('pm-cash');
    const qrRadio = document.getElementById('pm-qr');
    if (pm === 'CASH') {
      if (cashRadio) cashRadio.checked = true;
      if (qrRadio) qrRadio.checked = false;
      selectedPaymentMethod = 'CASH';
    } else {
      if (qrRadio) qrRadio.checked = true;
      if (cashRadio) cashRadio.checked = false;
      selectedPaymentMethod = 'BANK_TRANSFER';
    }
    updatePaymentMethodUI();
    return;
  }
  const qrRadio = document.getElementById('pm-qr');
  selectedPaymentMethod = (qrRadio && qrRadio.checked) ? 'BANK_TRANSFER' : 'CASH';
  preparedQrData = null;
  updatePaymentMethodUI();
}

function openQrModal() {
  const modalEl = document.getElementById('qr-modal');
  if (!modalEl) return;
  if (window.bootstrap && window.bootstrap.Modal) {
    if (!qrModalInstance) {
      qrModalInstance = new window.bootstrap.Modal(modalEl, { backdrop: 'static', keyboard: false });
    }
    qrModalInstance.show();
  } else {
    modalEl.style.display = 'block';
    modalEl.classList.add('show');
    const backdrop = document.getElementById('qr-modal-backdrop');
    if (backdrop) backdrop.style.display = 'block';
    document.body.classList.add('modal-open');
  }
}

function closeQrModal() {
  const modalEl = document.getElementById('qr-modal');
  if (qrModalInstance) {
    qrModalInstance.hide();
  }
  if (modalEl) {
    modalEl.style.display = 'none';
    modalEl.classList.remove('show');
  }
  const backdrop = document.getElementById('qr-modal-backdrop');
  if (backdrop) backdrop.style.display = 'none';
  document.body.classList.remove('modal-open');
}

function cancelQrPayment() {
  if (isPendingRecovery) {
    alert('Giao dịch chưa xác định trạng thái do lỗi kết nối hoặc phản hồi máy chủ. Không được hủy dữ liệu thanh toán. Vui lòng bấm "Thử lại gửi yêu cầu" để đối soát.');
    return;
  }
  closeQrModal();
  preparedQrData = null;
  pendingConfirmationPayload = null;
  clearSalesMessage();
  renderCart();
}

function onQrImageLoad() {
  const spinner = document.getElementById('qr-loading-spinner');
  if (spinner) spinner.classList.add('d-none');
}

function onQrImageError() {
  const spinner = document.getElementById('qr-loading-spinner');
  const errorBox = document.getElementById('qr-img-error');
  if (spinner) spinner.classList.add('d-none');
  if (errorBox) errorBox.classList.remove('d-none');
}

// Chuẩn bị và hiển thị mã QR chuyển khoản
async function prepareAndShowQr() {
  if (isPendingRecovery) {
    if (pendingConfirmationPayload && pendingConfirmationPayload.payment_method === 'BANK_TRANSFER') {
      openQrModal();
      return;
    }
    const pmName = (pendingConfirmationPayload && pendingConfirmationPayload.payment_method === 'CASH') ? 'tiền mặt' : 'chuyển khoản';
    alert(`Đang có yêu cầu ${pmName} chờ xác định kết quả. Không thể tạo mã QR mới.`);
    return;
  }
  if (isConfirming) return;

  if (cart.length === 0) {
    showSalesMessage('Giỏ hàng trống. Vui lòng thêm sản phẩm vào giỏ trước khi thanh toán.', 'warning');
    alert('Giỏ hàng trống. Vui lòng thêm sản phẩm vào giỏ trước khi thanh toán.');
    return;
  }

  // 1. Kiểm tra cấu hình ngân hàng
  if (!bankConfig || !bankConfig.configured) {
    await checkPaymentConfig();
    if (!bankConfig || !bankConfig.configured) {
      const msg = 'Chưa cấu hình tài khoản nhận chuyển khoản';
      showSalesMessage(msg + '. Bạn vẫn có thể thanh toán bằng Tiền mặt.', 'warning');
      alert(msg);
      return;
    }
  }

  clearSalesMessage();
  dismissSuccessBox();
  isSubmitting = true;

  const btn = document.getElementById('btn-checkout');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status"></span>Đang kiểm tra giỏ hàng & tạo mã QR...';
  }

  try {
    const payload = {
      items: cart.map(c => ({
        product_id: c.product_id,
        quantity: c.quantity,
        unit_price: c.unit_price
      }))
    };

    const res = await window.apiFetch('/api/invoices/prepare-qr', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    if (res && res.ok) {
      const data = await res.json();
      preparedQrData = data;

      const bankIdEl = document.getElementById('qr-bank-id');
      const accNoEl = document.getElementById('qr-account-no');
      const accNameEl = document.getElementById('qr-account-name');
      const amountEl = document.getElementById('qr-amount');
      const contentEl = document.getElementById('qr-transfer-content');
      const qrImg = document.getElementById('qr-image');
      const qrSpinner = document.getElementById('qr-loading-spinner');
      const qrErr = document.getElementById('qr-img-error');

      const bankDisplay = (data.bank_name && data.bank_name !== data.bank_id)
        ? `${data.bank_name} (${data.bank_id})`
        : (data.bank_name || data.bank_id);
      if (bankIdEl) bankIdEl.textContent = bankDisplay;
      if (accNoEl) accNoEl.textContent = data.account_no;
      if (accNameEl) accNameEl.textContent = data.account_name;
      if (amountEl) amountEl.textContent = Number(data.amount).toLocaleString('vi-VN') + ' đ';
      if (contentEl) contentEl.textContent = data.transfer_content;

      if (qrErr) qrErr.classList.add('d-none');
      if (qrSpinner) qrSpinner.classList.remove('d-none');
      if (qrImg) qrImg.src = data.qr_url;

      const confirmBtn = document.getElementById('btn-confirm-qr');
      const cancelBtn = document.getElementById('btn-cancel-qr');
      if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.innerHTML = `
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-check2-circle me-1" viewBox="0 0 16 16">
            <path d="M2.5 8a5.5 5.5 0 0 1 8.25-4.764.5.5 0 0 0 .5-.866A6.5 6.5 0 1 0 14.5 8a.5.5 0 0 0-1 0 5.5 5.5 0 1 1-11 0z"/>
            <path d="M15.354 3.354a.5.5 0 0 0-.708-.708L8 9.293 5.354 6.646a.5.5 0 1 0-.708.708l3 3a.5.5 0 0 0 .708 0l7-7z"/>
          </svg>
          Đã kiểm tra và nhận đủ tiền
        `;
      }
      if (cancelBtn) cancelBtn.disabled = false;

      openQrModal();
    } else if (res && res.status === 409) {
      const e = await res.json().catch(() => ({}));
      if (e.requires_confirmation) {
        if (confirm(e.error + '\nBạn có muốn cập nhật lại đơn giá mới cho giỏ hàng để tiếp tục không?')) {
          await loadProducts();
          cart.forEach(c => {
            if (productsMap[c.product_id]) {
              c.unit_price = Number(productsMap[c.product_id].sale_price);
            }
          });
          currentRequestKey = Date.now().toString() + '-' + Math.random().toString(36).substring(2);
          showSalesMessage('Đơn giá đã được cập nhật lại theo giá mới nhất.', 'info');
        }
      } else {
        showSalesMessage(e.error || 'Lỗi kiểm tra giỏ hàng', 'danger');
        alert(e.error || 'Lỗi kiểm tra giỏ hàng');
      }
      renderCart();
    } else {
      const e = await res.json().catch(() => ({}));
      const errText = window.formatApiError(e, 'Không thể tạo mã QR chuyển khoản');
      showSalesMessage(errText, 'danger');
      alert(errText);
      await loadProducts();
      renderCart();
    }
  } catch (err) {
    console.error('Lỗi khi chuẩn bị QR:', err);
    showSalesMessage('Lỗi kết nối khi chuẩn bị mã QR.', 'danger');
    alert('Lỗi kết nối khi chuẩn bị mã QR.');
  } finally {
    isSubmitting = false;
    updatePaymentMethodUI();
  }
}

// Xác nhận thanh toán Chuyển khoản QR (nhân viên bấm xác nhận)
async function confirmQrPayment(event) {
  if (event) event.preventDefault();
  if (isConfirming) return;

  const confirmBtn = document.getElementById('btn-confirm-qr');
  const cancelBtn = document.getElementById('btn-cancel-qr');
  const indeterminateAlert = document.getElementById('qr-indeterminate-alert');

  let payload;
  if (isPendingRecovery && pendingConfirmationPayload) {
    // Bảo toàn nguyên vẹn payload cũ gồm invoice_no, request_key, items, payment_method, transfer_content
    payload = pendingConfirmationPayload;
  } else {
    if (!preparedQrData || !preparedQrData.transfer_content) {
      alert('Thông tin phiên chuyển khoản không hợp lệ hoặc đã hết hiệu lực. Vui lòng tạo lại mã QR.');
      closeQrModal();
      return;
    }
    payload = {
      invoice_no: currentInvoiceNo,
      request_key: currentRequestKey,
      payment_method: 'BANK_TRANSFER',
      transfer_content: preparedQrData.transfer_content,
      items: cart.map(c => ({
        product_id: c.product_id,
        quantity: c.quantity,
        unit_price: c.unit_price
      }))
    };
    pendingConfirmationPayload = payload;
  }

  isConfirming = true;
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status"></span>Đang xác nhận hóa đơn...';
  }
  if (cancelBtn) {
    cancelBtn.disabled = true;
  }
  if (indeterminateAlert) {
    indeterminateAlert.classList.add('d-none');
  }

  try {
    const res = await window.apiFetch('/api/invoices', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    if (res && (res.status === 201 || res.status === 200)) {
      // Giao dịch thành công xác định -> Giải phóng trạng thái phục hồi
      isPendingRecovery = false;
      isConfirming = false;
      pendingConfirmationPayload = null;

      const data = await res.json().catch(() => ({}));
      const actualInvoiceNo = data.invoice_no || payload.invoice_no;
      lastCreatedInvoice = { id: data.id, invoice_no: actualInvoiceNo };

      closeQrModal();

      const successBox = document.getElementById('sales-success-box');
      const successNoEl = document.getElementById('success-invoice-no');
      if (successNoEl) successNoEl.textContent = actualInvoiceNo;
      if (successBox) successBox.classList.remove('d-none');

      showSalesMessage(`Thanh toán thành công! Mã hóa đơn: ${actualInvoiceNo} (Phương thức: Chuyển khoản QR)`, 'success');

      cart = [];
      preparedQrData = null;
      currentRequestKey = Date.now().toString() + '-' + Math.random().toString(36).substring(2);
      currentInvoiceNo = 'HD' + Date.now();
      updateInvoiceNoDisplay();
      renderCart();

      await loadProducts();
      return;
    }

    if (res && res.status >= 500) {
      // Lỗi máy chủ 5xx -> Kết quả chưa xác định (giao dịch có thể đã commit hoặc chưa)
      isConfirming = false;
      const data = await res.json().catch(() => ({}));
      const refCode = (data && data.requestId) ? ` (Mã tra cứu: ${data.requestId})` : '';
      enterIndeterminateRecovery(`Máy chủ phản hồi lỗi nội bộ (HTTP ${res.status}). Không thể thực hiện thao tác${refCode}. Kết quả giao dịch chưa xác định. Dữ liệu thanh toán được bảo toàn. Vui lòng bấm "Thử lại gửi yêu cầu" để đối soát.`, 'BANK_TRANSFER');
      return;
    }

    // Các mã 4xx: Từ chối dứt khoát trước khi lưu -> Giải phóng trạng thái phục hồi
    isPendingRecovery = false;
    isConfirming = false;
    pendingConfirmationPayload = null;

    if (res && res.status === 409) {
      const e = await res.json().catch(() => ({}));
      closeQrModal();
      if (e.reconciliation_required) {
        showSalesMessage(`⚠️ CẦN ĐỐI SOÁT: ${e.error}`, 'danger');
        alert(`⚠️ CẦN ĐỐI SOÁT VỚI KHÁCH HÀNG:\n${e.error}`);
      } else {
        showSalesMessage(e.error || 'Xung đột khi lập hóa đơn', 'danger');
        alert(e.error || 'Xung đột khi lập hóa đơn');
      }
      await loadProducts();
      renderCart();
      return;
    }

    const e = await res.json().catch(() => ({}));
    const errText = e.error || 'Lập hóa đơn thất bại';
    closeQrModal();
    showSalesMessage(errText, 'danger');
    alert(errText);
    await loadProducts();
    renderCart();

  } catch (err) {
    console.error('Lỗi kết nối khi xác nhận chuyển khoản:', err);
    // Mất mạng / Timeout -> Kết quả chưa xác định, bảo toàn dữ liệu
    isConfirming = false;
    enterIndeterminateRecovery('Mất kết nối tới máy chủ. Dữ liệu thanh toán được bảo toàn nguyên vẹn. Vui lòng bấm "Thử lại gửi yêu cầu".', 'BANK_TRANSFER');
  }
}

// Xử lý nút thanh toán tại giỏ hàng
// Xử lý nút thanh toán tại giỏ hàng
async function checkout(event) {
  if (event) event.preventDefault();

  // 1. Giỏ trống không được thanh toán
  if (cart.length === 0) {
    showSalesMessage('Giỏ hàng trống. Vui lòng thêm sản phẩm vào giỏ trước khi thanh toán.', 'warning');
    alert('Giỏ hàng trống. Vui lòng thêm sản phẩm vào giỏ trước khi thanh toán.');
    return;
  }

  // Nếu đang phục hồi BANK_TRANSFER, mở modal QR để thử lại
  if (isPendingRecovery && pendingConfirmationPayload) {
    if (pendingConfirmationPayload.payment_method === 'BANK_TRANSFER') {
      openQrModal();
      return;
    }
  }

  // Nếu chọn Chuyển khoản QR (và không phải đang phục hồi CASH), mở luồng kiểm tra và hiển thị mã QR
  if (!isPendingRecovery && selectedPaymentMethod === 'BANK_TRANSFER') {
    return prepareAndShowQr();
  }

  // 2. Luồng thanh toán Tiền mặt (hoặc thử lại Tiền mặt khi đang phục hồi)
  if (isSubmitting || isConfirming) return;

  clearSalesMessage();
  dismissSuccessBox();
  isSubmitting = true;
  isConfirming = true;
  renderCart();

  const btn = document.getElementById('btn-checkout');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-2" role="status"></span>Đang xử lý thanh toán Tiền mặt...';
  }

  let payload;
  if (isPendingRecovery && pendingConfirmationPayload) {
    // Bảo toàn nguyên vẹn payload cũ gồm invoice_no, request_key, items, payment_method ('CASH')
    payload = pendingConfirmationPayload;
  } else {
    payload = {
      invoice_no: currentInvoiceNo,
      request_key: currentRequestKey,
      payment_method: 'CASH',
      items: cart.map(c => ({
        product_id: c.product_id,
        quantity: c.quantity,
        unit_price: c.unit_price
      }))
    };
    pendingConfirmationPayload = payload;
  }

  try {
    const res = await window.apiFetch('/api/invoices', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    if (res && (res.status === 201 || res.status === 200)) {
      // Thành công -> Giải phóng trạng thái phục hồi
      isPendingRecovery = false;
      isConfirming = false;
      isSubmitting = false;
      pendingConfirmationPayload = null;

      const data = await res.json().catch(() => ({}));
      const actualInvoiceNo = data.invoice_no || payload.invoice_no;
      lastCreatedInvoice = { id: data.id, invoice_no: actualInvoiceNo };

      const successBox = document.getElementById('sales-success-box');
      const successNoEl = document.getElementById('success-invoice-no');
      if (successNoEl) successNoEl.textContent = actualInvoiceNo;
      if (successBox) successBox.classList.remove('d-none');

      showSalesMessage(`Thanh toán thành công! Mã hóa đơn: ${actualInvoiceNo} (Phương thức: Tiền mặt)`, 'success');

      cart = [];
      preparedQrData = null;
      currentRequestKey = Date.now().toString() + '-' + Math.random().toString(36).substring(2);
      currentInvoiceNo = 'HD' + Date.now();
      updateInvoiceNoDisplay();
      renderCart();

      await loadProducts();
      return;
    }

    if (res && res.status >= 500) {
      // Lỗi máy chủ 5xx (ví dụ 500, 503) -> Kết quả chưa xác định
      isConfirming = false;
      isSubmitting = false;
      const data = await res.json().catch(() => ({}));
      const refCode = (data && data.requestId) ? ` (Mã tra cứu: ${data.requestId})` : '';
      enterIndeterminateRecovery(`Máy chủ phản hồi lỗi (HTTP ${res.status}). Không thể thực hiện thao tác${refCode}. Kết quả giao dịch tiền mặt chưa xác định. Dữ liệu thanh toán được bảo toàn. Vui lòng bấm "Thử lại gửi yêu cầu" để đối soát.`, 'CASH');
      alert(`Không thể thực hiện thao tác${refCode}. Máy chủ phản hồi lỗi (HTTP ${res.status}). Kết quả giao dịch tiền mặt chưa xác định. Dữ liệu thanh toán được bảo toàn. Vui lòng bấm "Thử lại gửi yêu cầu".`);
      return;
    }

    // Các mã 4xx: Từ chối dứt khoát trước khi lưu -> Giải phóng trạng thái phục hồi
    isPendingRecovery = false;
    isConfirming = false;
    isSubmitting = false;
    pendingConfirmationPayload = null;

    if (res && res.status === 409) {
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
      renderCart();
      return;
    }

    let data = {};
    try { data = await res.json(); } catch (err) {}
    const errText = data.error || 'Lỗi thanh toán';
    showSalesMessage(errText, 'danger');
    alert(errText);

    await loadProducts();
    renderCart();

  } catch (err) {
    console.error('Lỗi kết nối khi thanh toán:', err);
    // Mất mạng / Timeout -> Kết quả chưa xác định, bảo toàn dữ liệu
    isConfirming = false;
    isSubmitting = false;
    enterIndeterminateRecovery('Mất kết nối tới máy chủ khi thanh toán tiền mặt. Dữ liệu thanh toán được bảo toàn nguyên vẹn. Vui lòng bấm "Thử lại gửi yêu cầu".', 'CASH');
    alert('Mất kết nối máy chủ khi thanh toán tiền mặt. Dữ liệu thanh toán được bảo toàn. Vui lòng bấm "Thử lại gửi yêu cầu".');
  } finally {
    isSubmitting = false;
    isConfirming = false;
    renderCart();
    updatePaymentMethodUI();
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

  let paymentMethodStr = 'Chưa ghi nhận';
  let transferDetailsHtml = '';
  if (inv.payment_method === 'CASH') {
    paymentMethodStr = 'Tiền mặt';
  } else if (inv.payment_method === 'BANK_TRANSFER') {
    paymentMethodStr = 'Chuyển khoản QR';
    const confirmedTime = inv.transfer_confirmed_at ? formatDateTimeVN(inv.transfer_confirmed_at) : 'N/A';
    const escapedContent = escapeHtml(inv.transfer_content || 'N/A');
    transferDetailsHtml = `
      <div class="row g-2 mb-2 p-2 bg-light rounded border text-start small">
        <div class="col-sm-6">
          <strong>Nội dung chuyển khoản:</strong> <span class="font-monospace text-primary fw-bold">${escapedContent}</span>
        </div>
        <div class="col-sm-6 text-sm-end text-muted">
          <span>Xác nhận lúc: <strong>${confirmedTime}</strong> (Thủ công)</span>
        </div>
      </div>
    `;
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
          <p class="mb-1"><strong>Phương thức:</strong> <span class="fw-semibold">${paymentMethodStr}</span></p>
        </div>
      </div>
      ${transferDetailsHtml}

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
              <th class="text-end fw-bold text-dark fs-6">${totalAmountStr}</th>
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
      const msg = window.formatApiError(err, 'Không thể tải chi tiết hóa đơn.');
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
  const qtyInput = document.getElementById('s-qty');
  if (qtyInput) qtyInput.value = '';
  renderCart();
  await initUserInfo();
  await checkPaymentConfig();
  await loadProducts();
});