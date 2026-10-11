// Quản lý giỏ hàng phiếu nhập kho
window.stockReceiptCart = window.stockReceiptCart || [];
let cart = window.stockReceiptCart;
let activeProducts = [];
let editingItemIndex = -1;

function generateKey() {
  return Date.now().toString() + '-' + Math.random().toString(36).substring(2);
}
let currentRequestKey = generateKey();
let isSubmitting = false;
let isPendingRetry = false;

// Biến phân trang và lọc lịch sử phiếu nhập
let historyPage = 1;
const historyPageSize = 5;
let historyTotalPages = 1;
let historyTotalItems = 0;

// Hiển thị thông báo trên giao diện
function showReceiptMessage(message, type = 'info') {
  const msgBox = document.getElementById('receipt-msg');
  if (!msgBox) return;
  msgBox.className = `alert alert-${type} mb-3 shadow-sm`;
  msgBox.innerHTML = message;
  msgBox.classList.remove('d-none');
}

// Xóa thông báo cũ mỗi khi có thao tác mới
function clearReceiptMessage() {
  const msgBox = document.getElementById('receipt-msg');
  if (msgBox) {
    msgBox.classList.add('d-none');
    msgBox.innerHTML = '';
  }
}

// Định dạng tiền tệ VNĐ
function formatMoney(amount) {
  return Number(amount || 0).toLocaleString('vi-VN') + ' đ';
}

// Định dạng ngày giờ chuẩn Asia/Ho_Chi_Minh
function formatDateTimeVN(dateVal) {
  if (!dateVal) return 'Không rõ';
  const d = new Date(dateVal);
  if (isNaN(d.getTime())) return 'Không rõ';
  return d.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
}

// Kiểm tra ngày hợp lệ theo dương lịch thực tế (YYYY-MM-DD), chặn các ngày không tồn tại (như 2026-02-30, 2026-04-31) và chấp nhận năm nhuận
function isValidCalendarDate(dateStr) {
  if (typeof dateStr !== 'string') return false;
  const match = dateStr.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const d = new Date(year, month - 1, day);
  return (d.getFullYear() === year && (d.getMonth() + 1) === month && d.getDate() === day);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Tải danh sách sản phẩm đang kinh doanh
async function loadProducts() {
  try {
    const res = await window.apiFetch('/api/products?active_only=true');
    if (!res || !res.ok) return;
    activeProducts = await res.json();
    populateProductSelect(activeProducts);
  } catch (err) {
    console.error('Lỗi tải sản phẩm:', err);
  }
}

// Đổ dữ liệu sản phẩm vào dropdown
function populateProductSelect(list) {
  const sel = document.getElementById('r-product');
  if (!sel) return;
  const currentVal = sel.value;
  sel.innerHTML = '<option value="">-- Chọn sản phẩm --</option>';
  list.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.dataset.sku = p.sku;
    opt.dataset.name = p.name;
    opt.dataset.unit = p.unit;
    opt.dataset.stock = p.stock_quantity;
    opt.textContent = `${p.name} (${p.sku}) [Hiện tồn: ${p.stock_quantity} ${p.unit}]`;
    sel.appendChild(opt);
  });
  if (currentVal && list.some(p => String(p.id) === String(currentVal))) {
    sel.value = currentVal;
  }
}

// Lọc nhanh sản phẩm theo từ khóa SKU/tên
function filterProductDropdown() {
  clearReceiptMessage();
  const searchInput = document.getElementById('r-product-search');
  const term = searchInput ? searchInput.value.trim().toLowerCase() : '';
  if (!term) {
    populateProductSelect(activeProducts);
    return;
  }
  const filtered = activeProducts.filter(p => 
    (p.name && p.name.toLowerCase().includes(term)) || 
    (p.sku && p.sku.toLowerCase().includes(term))
  );
  populateProductSelect(filtered);
}

// Bắt đầu chỉnh sửa 1 dòng trong giỏ nhập
function editReceiptItem(index) {
  clearReceiptMessage();
  if (isPendingRetry) {
    return showReceiptMessage('⚠️ Phiếu nhập đang chờ xác minh kết quả lưu. Không thể sửa mặt hàng trong khi chờ thử lại.', 'warning');
  }
  cart = window.stockReceiptCart;
  if (index < 0 || index >= cart.length) return;

  const item = cart[index];
  editingItemIndex = index;

  // Điền dữ liệu dòng vào form
  const sel = document.getElementById('r-product');
  const qtyInput = document.getElementById('r-qty');
  const costInput = document.getElementById('r-cost');
  const cardTitle = document.getElementById('item-form-title');
  const editingBadge = document.getElementById('editing-badge');
  const btnAdd = document.getElementById('btn-add-item');
  const btnCancel = document.getElementById('btn-cancel-edit');

  // Đảm bảo option tồn tại trong select
  populateProductSelect(activeProducts);
  sel.value = item.product_id;
  qtyInput.value = item.quantity;
  costInput.value = item.unit_cost;

  // Cập nhật giao diện nút
  if (cardTitle) cardTitle.innerHTML = `<i class="bi bi-pencil-square text-warning me-1"></i> Chỉnh Sửa Dòng Sản Phẩm:`;
  if (editingBadge) editingBadge.classList.remove('d-none');
  if (btnAdd) {
    btnAdd.className = 'btn btn-warning btn-sm px-3 text-dark fw-bold';
    btnAdd.innerHTML = '<i class="bi bi-check-lg me-1"></i> Lưu Cập Nhật Dòng';
  }
  if (btnCancel) btnCancel.classList.remove('d-none');

  renderCart();
  qtyInput.focus();
}

// Hủy thao tác chỉnh sửa dòng
function cancelEditItem(shouldClearMessage = true) {
  if (shouldClearMessage) {
    clearReceiptMessage();
  }
  editingItemIndex = -1;

  const sel = document.getElementById('r-product');
  const qtyInput = document.getElementById('r-qty');
  const costInput = document.getElementById('r-cost');
  const cardTitle = document.getElementById('item-form-title');
  const editingBadge = document.getElementById('editing-badge');
  const btnAdd = document.getElementById('btn-add-item');
  const btnCancel = document.getElementById('btn-cancel-edit');

  sel.value = '';
  qtyInput.value = '';
  costInput.value = '';

  if (cardTitle) cardTitle.innerHTML = `<i class="bi bi-plus-circle text-primary me-1"></i> Thêm Dòng Sản Phẩm Vào Phiếu:`;
  if (editingBadge) editingBadge.classList.add('d-none');
  if (btnAdd) {
    btnAdd.className = 'btn btn-success btn-sm px-3';
    btnAdd.innerHTML = '<i class="bi bi-plus-lg me-1"></i> Thêm vào phiếu';
  }
  if (btnCancel) btnCancel.classList.add('d-none');

  renderCart();
}

// Thêm hoặc Cập nhật dòng sản phẩm vào phiếu
function addOrUpdateReceiptItem(event) {
  if (event) event.preventDefault();
  clearReceiptMessage();

  if (isPendingRetry) {
    return showReceiptMessage('⚠️ Phiếu nhập đang chờ xác minh kết quả lưu từ máy chủ (phiếu có thể đã được ghi nhận). Hệ thống giữ nguyên mã phiếu, nội dung và khóa yêu cầu. Vui lòng bấm <strong>Thử Lại Lưu Phiếu</strong> để hoàn tất an toàn.', 'warning');
  }

  if (isSubmitting) {
    return showReceiptMessage('Hệ thống đang lưu phiếu nhập, vui lòng chờ trong giây lát.', 'warning');
  }

  const sel = document.getElementById('r-product');
  const qtyInput = document.getElementById('r-qty');
  const costInput = document.getElementById('r-cost');

  const id = Number(sel.value);
  const selectedOpt = sel.options[sel.selectedIndex];
  const qtyRaw = qtyInput.value.trim();
  const costRaw = costInput.value.trim();

  if (!id) {
    return showReceiptMessage('Vui lòng chọn sản phẩm cần nhập vào phiếu.', 'danger');
  }

  const qty = Number(qtyRaw);
  if (!qtyRaw || isNaN(qty) || !Number.isInteger(qty) || qty <= 0 || !/^[1-9]\d*$/.test(qtyRaw) || qty > 2147483647) {
    return showReceiptMessage('Số lượng nhập phải là số nguyên dương lớn hơn 0 (không chứa số thập phân).', 'danger');
  }

  const cost = Number(costRaw);
  if (costRaw === '' || isNaN(cost) || cost < 0) {
    return showReceiptMessage('Giá nhập phải là số không âm (>= 0).', 'danger');
  }

  if (!/^\d+(\.\d{1,2})?$/.test(costRaw)) {
    return showReceiptMessage('Giá nhập không được vượt quá 2 chữ số thập phân.', 'danger');
  }

  if (cost >= 10000000000000) {
    return showReceiptMessage('Giá nhập vượt quá giới hạn hệ thống cho phép.', 'danger');
  }

  // Lấy snapshot thông tin sản phẩm
  const prodInfo = activeProducts.find(p => p.id === id) || {};
  const sku = prodInfo.sku || selectedOpt?.dataset.sku || '';
  const name = prodInfo.name || selectedOpt?.dataset.name || selectedOpt?.text || '';
  const unit = prodInfo.unit || selectedOpt?.dataset.unit || 'Cái';

  cart = window.stockReceiptCart;

  if (editingItemIndex >= 0 && editingItemIndex < cart.length) {
    // ĐANG SỬA DÒNG
    cart[editingItemIndex] = {
      product_id: id,
      sku: sku,
      name: name,
      unit: unit,
      quantity: qty,
      unit_cost: cost
    };
    showReceiptMessage(`Đã cập nhật dòng sản phẩm <strong>${escapeHtml(name)}</strong> thành công.`, 'success');
    cancelEditItem();
  } else {
    // THÊM MỚI DÒNG
    const existingIndex = cart.findIndex(c => c.product_id === id);
    if (existingIndex !== -1) {
      const existing = cart[existingIndex];
      if (Math.abs(existing.unit_cost - cost) > 0.001) {
        return showReceiptMessage(`Sản phẩm <strong>${escapeHtml(name)}</strong> đã có trong phiếu với đơn giá ${formatMoney(existing.unit_cost)}. Vui lòng sửa trực tiếp dòng đó hoặc thống nhất giá nhập.`, 'warning');
      }
      existing.quantity += qty;
      showReceiptMessage(`Đã cộng dồn ${qty} ${unit} vào dòng sản phẩm <strong>${escapeHtml(name)}</strong> có sẵn.`, 'info');
    } else {
      cart.push({
        product_id: id,
        sku: sku,
        name: name,
        unit: unit,
        quantity: qty,
        unit_cost: cost
      });
      showReceiptMessage(`Đã thêm <strong>${escapeHtml(name)}</strong> (${qty} ${unit}) vào phiếu nhập.`, 'success');
    }

    // Xóa form sau khi thêm
    sel.value = '';
    qtyInput.value = '';
    costInput.value = '';
  }

  window.stockReceiptCart = cart;
  currentRequestKey = generateKey();
  renderCart();
}

// Xóa sản phẩm khỏi giỏ hàng
function removeReceiptItem(index, event) {
  if (event) event.preventDefault();
  clearReceiptMessage();
  if (isPendingRetry) {
    return showReceiptMessage('⚠️ Phiếu nhập đang chờ xác minh kết quả lưu. Không thể xóa mặt hàng trong khi chờ thử lại.', 'warning');
  }
  if (isSubmitting) return;

  cart = window.stockReceiptCart;
  if (index >= 0 && index < cart.length) {
    const removedName = cart[index].name;
    if (editingItemIndex === index) {
      cancelEditItem();
    } else if (editingItemIndex > index) {
      editingItemIndex--;
    }
    cart.splice(index, 1);
    window.stockReceiptCart = cart;
    currentRequestKey = generateKey();
    renderCart();
    showReceiptMessage(`Đã xóa sản phẩm <strong>${escapeHtml(removedName)}</strong> khỏi phiếu nhập.`, 'info');
  }
}

// Hiển thị danh sách sản phẩm trong giỏ nhập
function renderCart() {
  cart = window.stockReceiptCart;
  const tbody = document.querySelector('#r-cart tbody');
  if (!tbody) return;

  tbody.innerHTML = '';
  let grandTotal = 0;

  if (!cart || cart.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="7" class="text-center text-muted py-4"><i class="bi bi-cart-x fs-4 d-block mb-1 text-secondary"></i>Chưa có sản phẩm nào trong phiếu nhập</td>';
    tbody.appendChild(tr);
    document.getElementById('r-total').textContent = '0 đ';
    return;
  }

  cart.forEach((c, i) => {
    const lineTotal = c.quantity * c.unit_cost;
    grandTotal += lineTotal;

    const isEditingThis = editingItemIndex === i;
    const tr = document.createElement('tr');
    if (isEditingThis) tr.className = 'editing-row';

    tr.innerHTML = `
      <td class="text-center text-muted">${i + 1}</td>
      <td>
        <span class="badge bg-secondary font-monospace me-1">${escapeHtml(c.sku || 'N/A')}</span>
        <span class="fw-semibold text-dark">${escapeHtml(c.name)}</span>
      </td>
      <td class="text-center text-muted">${escapeHtml(c.unit || 'Cái')}</td>
      <td class="text-center fw-bold text-primary">${c.quantity}</td>
      <td class="text-end">${formatMoney(c.unit_cost)}</td>
      <td class="text-end fw-bold text-danger">${formatMoney(lineTotal)}</td>
      <td class="text-center">
        <div class="btn-group btn-group-sm">
          <button type="button" class="btn btn-outline-primary" onclick="editReceiptItem(${i})" title="Sửa dòng này">
            <i class="bi bi-pencil"></i> Sửa
          </button>
          <button type="button" class="btn btn-outline-danger" onclick="removeReceiptItem(${i}, event)" title="Xóa dòng này">
            <i class="bi bi-trash"></i> Xóa
          </button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById('r-total').textContent = formatMoney(grandTotal);
}

// Làm mới toàn bộ biểu mẫu phiếu nhập
function resetForm(confirmBefore = false) {
  clearReceiptMessage();

  // Chặn làm mới biểu mẫu khi đang gửi hoặc đang chờ xác minh kết quả lưu
  if (isSubmitting) {
    showReceiptMessage('⚠️ Hệ thống đang gửi phiếu nhập lên máy chủ. Vui lòng chờ phản hồi, không làm mới biểu mẫu lúc này.', 'warning');
    return;
  }
  if (isPendingRetry) {
    showReceiptMessage('⚠️ Phiếu nhập đang chờ xác minh kết quả lưu từ máy chủ (phiếu có thể đã được ghi nhận). Hệ thống giữ nguyên mã phiếu, nội dung và khóa yêu cầu. Vui lòng bấm <strong>Thử Lại Lưu Phiếu</strong> để hoàn tất an toàn, không làm mới biểu mẫu lúc này.', 'warning');
    return;
  }

  // Khi làm mới bản nháp đang soạn dở (chưa gửi), xác nhận xóa danh sách mặt hàng nháp
  if (confirmBefore && cart.length > 0) {
    const confirmMsg = 'Bạn có chắc chắn muốn làm mới biểu mẫu? Danh sách mặt hàng đang soạn trong bản nháp sẽ bị xóa.';
    if (!confirm(confirmMsg)) {
      return;
    }
  }

  isPendingRetry = false;
  window.stockReceiptCart = [];
  cart = window.stockReceiptCart;
  cancelEditItem(false);
  const noInput = document.getElementById('r-no');
  if (noInput) {
    noInput.value = '';
    noInput.disabled = false;
  }
  const saveBtn = document.getElementById('btn-save-receipt');
  if (saveBtn) {
    saveBtn.disabled = false;
    saveBtn.innerHTML = '<i class="bi bi-check2-circle me-1"></i> Hoàn Tất Nhập Hàng';
    saveBtn.className = 'btn btn-success btn-lg w-100 shadow-sm';
  }
  const resetBtn = document.getElementById('btn-reset-form');
  if (resetBtn) {
    resetBtn.disabled = false;
  }
  document.getElementById('r-product-search').value = '';
  populateProductSelect(activeProducts);
  currentRequestKey = generateKey();
  renderCart();
}

// Lưu phiếu nhập hàng
async function saveReceipt(event) {
  if (event) event.preventDefault();
  clearReceiptMessage();
  if (isSubmitting) return;

  cart = window.stockReceiptCart;

  // Kiểm tra giỏ nhập trống
  if (!cart || cart.length === 0) {
    showReceiptMessage('⚠️ <strong>Giỏ nhập trống!</strong> Vui lòng chọn và thêm ít nhất 1 sản phẩm vào phiếu nhập trước khi hoàn tất.', 'warning');
    return;
  }

  // Tự sinh mã nếu để trống
  const noInput = document.getElementById('r-no');
  let receiptNo = noInput.value ? noInput.value.trim() : '';
  if (!receiptNo) {
    receiptNo = 'PN' + Date.now();
    noInput.value = receiptNo;
  }

  isSubmitting = true;
  noInput.disabled = true;
  const resetBtn = document.getElementById('btn-reset-form');
  if (resetBtn) {
    resetBtn.disabled = true;
  }
  const saveBtn = document.getElementById('btn-save-receipt');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span> Đang ghi nhận phiếu nhập và cập nhật kho...';
  }

  const payload = {
    receipt_no: receiptNo,
    request_key: currentRequestKey,
    items: cart.map(c => ({
      product_id: Number(c.product_id),
      quantity: parseInt(c.quantity, 10),
      unit_cost: Number(Number(c.unit_cost).toFixed(2))
    }))
  };

  try {
    const res = await window.apiFetch('/api/stock-receipts', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    const data = await res.json().catch(() => ({}));

    if (res && (res.status === 201 || res.status === 200)) {
      const successMsg = data.message || `Lập phiếu nhập thành công! Mã chứng từ: ${receiptNo}`;

      // CHỈ XÓA CART VÀ RESET FORM SAU KHI BACKEND LƯU THÀNH CÔNG VÀ COMMIT TRANSACTION
      isPendingRetry = false;
      window.stockReceiptCart = [];
      cart = window.stockReceiptCart;
      cancelEditItem(false);
      noInput.value = '';
      noInput.disabled = false;
      currentRequestKey = generateKey();

      renderCart();
      await loadProducts(); // Cập nhật lại tồn kho trong danh sách chọn sản phẩm
      await loadHistory(1, true); // Làm mới lịch sử nhưng giữ nguyên thông báo thành công
      showReceiptMessage(`✅ <strong>Thành công:</strong> ${escapeHtml(successMsg)}`, 'success');
    } else if (res && res.status >= 500) {
      // Lỗi máy chủ 5xx (chưa xác định được kết quả commit): GIỮ NGUYÊN request_key, mã phiếu và giỏ hàng
      isPendingRetry = true;
      noInput.disabled = true;
      showReceiptMessage(`⚠️ <strong>Chưa xác định được kết quả lưu:</strong> Máy chủ phản hồi mã lỗi ${res.status}. Hệ thống giữ nguyên mã phiếu <strong>${escapeHtml(receiptNo)}</strong>, nội dung hàng hóa và khóa yêu cầu. Vui lòng bấm <strong>Thử Lại Lưu Phiếu</strong> bên dưới để hoàn tất an toàn.`, 'warning');
    } else {
      // NẾU LƯU THẤT BẠI DO LỖI 4xx (Client validation, chắc chắn bị từ chối):
      isPendingRetry = false;
      let errMsg = data.error || data.message || 'Lưu phiếu nhập thất bại do lỗi hệ thống.';
      if (errMsg.includes('Mã phiếu nhập đã tồn tại') || errMsg.includes('receipt_no')) {
        errMsg = 'Mã phiếu nhập đã tồn tại. Vui lòng nhập mã khác.';
        noInput.disabled = false;
        currentRequestKey = generateKey();
      }
      showReceiptMessage(escapeHtml(errMsg), 'danger');
    }
  } catch (err) {
    // MẤT KẾT NỐI (Chưa xác định được kết quả lưu): GIỮ NGUYÊN request_key, mã phiếu và nội dung để thử lại
    isPendingRetry = true;
    noInput.disabled = true;
    console.error('Lỗi kết nối khi lưu phiếu nhập:', err);
    showReceiptMessage(`⚠️ <strong>Mất kết nối mạng - Chưa xác định được kết quả lưu:</strong> Không thể kết nối đến máy chủ. Hệ thống giữ nguyên mã phiếu <strong>${escapeHtml(receiptNo)}</strong>, nội dung hàng hóa và khóa yêu cầu. Nếu máy chủ đã commit, bấm <strong>Thử Lại Lưu Phiếu</strong> sẽ nhận lại đúng phiếu cũ mà không cộng trùng tồn kho.`, 'warning');
  } finally {
    isSubmitting = false;
    if (!isPendingRetry) {
      noInput.disabled = false;
    }
    const resetBtn = document.getElementById('btn-reset-form');
    if (resetBtn) {
      resetBtn.disabled = isPendingRetry;
    }
    if (saveBtn) {
      saveBtn.disabled = false;
      if (isPendingRetry) {
        saveBtn.innerHTML = '<i class="bi bi-arrow-repeat me-1"></i> Thử Lại Lưu Phiếu';
        saveBtn.className = 'btn btn-warning btn-lg w-100 shadow-sm text-dark fw-bold';
      } else {
        saveBtn.innerHTML = '<i class="bi bi-check2-circle me-1"></i> Hoàn Tất Nhập Hàng';
        saveBtn.className = 'btn btn-success btn-lg w-100 shadow-sm';
      }
    }
  }
}

// Điều khiển hiển thị lỗi bộ lọc lịch sử
function showHistoryFilterError(msg) {
  const alertEl = document.getElementById('history-filter-error');
  const textEl = document.getElementById('history-filter-error-text');
  if (alertEl && textEl) {
    textEl.textContent = msg;
    alertEl.style.display = 'block';
  } else {
    showReceiptMessage('⚠️ ' + msg, 'danger');
  }
}

function clearHistoryFilterError() {
  const alertEl = document.getElementById('history-filter-error');
  const textEl = document.getElementById('history-filter-error-text');
  if (alertEl) alertEl.style.display = 'none';
  if (textEl) textEl.textContent = '';
}

// Tải lịch sử nhập hàng (hỗ trợ tìm kiếm, lọc ngày, phân trang)
async function loadHistory(page = 1, keepCurrentMessage = false) {
  if (!keepCurrentMessage) {
    clearReceiptMessage();
  }
  historyPage = page;
  const historyContainer = document.getElementById('r-history');
  if (!historyContainer) return;

  const searchVal = document.getElementById('history-search')?.value.trim() || '';
  const fromDate = document.getElementById('history-from-date')?.value.trim() || '';
  const toDate = document.getElementById('history-to-date')?.value.trim() || '';

  // Kiểm tra ngày hợp lệ theo lịch thực tế và chặn from_date > to_date ở frontend
  if (fromDate && !isValidCalendarDate(fromDate)) {
    showHistoryFilterError('Từ ngày không hợp lệ hoặc không tồn tại trên lịch.');
    return;
  }
  if (toDate && !isValidCalendarDate(toDate)) {
    showHistoryFilterError('Đến ngày không hợp lệ hoặc không tồn tại trên lịch.');
    return;
  }
  if (fromDate && toDate && fromDate > toDate) {
    showHistoryFilterError('Từ ngày không được lớn hơn Đến ngày.');
    return;
  }

  // Ngày hợp lệ: Xóa thông báo lỗi
  clearHistoryFilterError();

  const queryParams = new URLSearchParams({
    page: String(historyPage),
    limit: String(historyPageSize),
    paginate: 'true'
  });
  if (searchVal) queryParams.set('q', searchVal);
  if (fromDate) queryParams.set('from_date', fromDate);
  if (toDate) queryParams.set('to_date', toDate);

  try {
    const res = await window.apiFetch('/api/stock-receipts?' + queryParams.toString());
    if (!res || !res.ok) {
      let errMsg = 'Lỗi tải lịch sử phiếu nhập';
      try {
        const errJson = await res.json();
        if (errJson && errJson.error) errMsg = errJson.error;
      } catch (e) {}
      showHistoryFilterError(errMsg);
      // Giữ nguyên danh sách đang hiển thị khi gặp lỗi bộ lọc
      return;
    }

    const result = await res.json();
    let list = [];
    if (result && result.pagination) {
      list = result.receipts || result.data || [];
      historyTotal = result.pagination.total || 0;
      historyTotalPages = result.pagination.totalPages || 1;
      historyPage = result.pagination.page || 1;
    } else if (Array.isArray(result)) {
      list = result;
      historyTotal = result.length;
      historyTotalPages = Math.max(1, Math.ceil(historyTotal / historyPageSize));
    }

    renderHistoryList(list);
    renderHistoryPagination();
  } catch (err) {
    console.error('Lỗi tải lịch sử:', err);
    showHistoryFilterError('Lỗi kết nối khi tải lịch sử phiếu nhập');
  }
}

// Hiển thị danh sách lịch sử phiếu nhập
function renderHistoryList(list) {
  const container = document.getElementById('r-history');
  if (!container) return;
  container.innerHTML = '';

  if (!list || list.length === 0) {
    container.innerHTML = `
      <div class="text-center text-muted py-4">
        <i class="bi bi-inbox fs-4 d-block mb-1"></i>
        Không tìm thấy phiếu nhập nào phù hợp
      </div>
    `;
    return;
  }

  list.forEach(r => {
    const dateStr = formatDateTimeVN(r.created_at);
    const amountStr = formatMoney(r.total_amount);
    const creator = r.created_by_name || r.created_by_username || 'Quản lý';

    const itemDiv = document.createElement('div');
    itemDiv.className = 'list-group-item d-flex justify-content-between align-items-center py-2 px-3';
    itemDiv.innerHTML = `
      <div class="pe-2">
        <div class="fw-bold text-primary font-monospace">${escapeHtml(r.receipt_no)}</div>
        <small class="text-muted d-block">${dateStr} | ${escapeHtml(creator)}</small>
        <span class="small fw-bold text-danger">Tổng: ${amountStr}</span>
      </div>
      <div>
        <button type="button" class="btn btn-outline-info btn-sm" onclick="viewReceiptDetails(${r.id})" title="Xem chi tiết phiếu">
          <i class="bi bi-eye me-1"></i> Chi tiết
        </button>
      </div>
    `;
    container.appendChild(itemDiv);
  });
}

// Hiển thị phân trang lịch sử
function renderHistoryPagination() {
  const infoEl = document.getElementById('history-pagination-info');
  const controlsEl = document.getElementById('history-pagination-controls');
  if (!infoEl || !controlsEl) return;

  if (historyTotal === 0) {
    infoEl.textContent = 'Hiển thị 0 phiếu';
    controlsEl.innerHTML = '';
    return;
  }

  const startItem = (historyPage - 1) * historyPageSize + 1;
  const endItem = Math.min(historyPage * historyPageSize, historyTotal);
  infoEl.textContent = `Hiển thị ${startItem}-${endItem} / ${historyTotal} phiếu (Trang ${historyPage}/${historyTotalPages})`;

  let html = '';
  const prevDisabled = historyPage <= 1 ? 'disabled' : '';
  html += `
    <li class="page-item ${prevDisabled}">
      <a class="page-link py-1 px-2" href="#" onclick="changeHistoryPage(${historyPage - 1}); return false;">&laquo;</a>
    </li>
  `;

  for (let i = 1; i <= historyTotalPages; i++) {
    if (i === 1 || i === historyTotalPages || (i >= historyPage - 1 && i <= historyPage + 1)) {
      const activeClass = i === historyPage ? 'active' : '';
      html += `
        <li class="page-item ${activeClass}">
          <a class="page-link py-1 px-2" href="#" onclick="changeHistoryPage(${i}); return false;">${i}</a>
        </li>
      `;
    }
  }

  const nextDisabled = historyPage >= historyTotalPages ? 'disabled' : '';
  html += `
    <li class="page-item ${nextDisabled}">
      <a class="page-link py-1 px-2" href="#" onclick="changeHistoryPage(${historyPage + 1}); return false;">&raquo;</a>
    </li>
  `;

  controlsEl.innerHTML = html;
}

function changeHistoryPage(page) {
  if (page < 1 || page > historyTotalPages || page === historyPage) return;
  loadHistory(page);
}

function resetHistoryFilters() {
  clearReceiptMessage();
  clearHistoryFilterError();
  const searchInput = document.getElementById('history-search');
  const fromInput = document.getElementById('history-from-date');
  const toInput = document.getElementById('history-to-date');
  if (searchInput) searchInput.value = '';
  if (fromInput) fromInput.value = '';
  if (toInput) toInput.value = '';
  loadHistory(1);
}

// Điều khiển Modal chi tiết phiếu nhập
function openReceiptModal() {
  const modalEl = document.getElementById('receipt-detail-modal');
  if (modalEl) {
    modalEl.classList.add('show');
    modalEl.style.display = 'block';
  }
}

function closeReceiptModal() {
  const modalEl = document.getElementById('receipt-detail-modal');
  if (modalEl) {
    modalEl.classList.remove('show');
    modalEl.style.display = 'none';
  }
}

// Xem chi tiết phiếu nhập (Mã phiếu, người lập, giờ VN, SKU/tên, ĐVT, SL, giá nhập, tổng tiền)
async function viewReceiptDetails(id) {
  clearReceiptMessage();
  const modalTitle = document.getElementById('receipt-modal-title');
  const modalBody = document.getElementById('receipt-modal-body');

  if (!id) return alert('Không tìm thấy mã phiếu!');

  if (modalTitle) modalTitle.textContent = `Chi Tiết Phiếu Nhập #${id}`;
  if (modalBody) {
    modalBody.innerHTML = `
      <div class="text-center py-4">
        <div class="spinner-border text-primary" role="status"></div>
        <p class="mt-2 text-muted mb-0">Đang tải chi tiết chứng từ phiếu nhập...</p>
      </div>
    `;
  }
  openReceiptModal();

  try {
    const res = await window.apiFetch('/api/stock-receipts/' + id);
    if (!res || !res.ok) {
      if (modalBody) modalBody.innerHTML = '<div class="alert alert-danger mb-0">Không thể tải chi tiết phiếu nhập</div>';
      return;
    }

    const data = await res.json();
    const r = data.receipt;
    const items = data.items || [];

    if (!r) {
      if (modalBody) modalBody.innerHTML = '<div class="alert alert-danger mb-0">Không tìm thấy dữ liệu phiếu</div>';
      return;
    }

    if (modalTitle) {
      modalTitle.textContent = `Chi Tiết Phiếu Nhập: ${r.receipt_no}`;
    }

    const createdDate = formatDateTimeVN(r.created_at);
    const creator = r.created_by_name || r.created_by_username || 'Quản lý';
    const totalAmountStr = formatMoney(r.total_amount);

    let contentHtml = `
      <div class="card bg-light border-0 mb-3 p-3">
        <div class="row g-2">
          <div class="col-sm-6"><strong>Mã phiếu:</strong> <span class="text-primary fw-bold font-monospace">${escapeHtml(r.receipt_no)}</span></div>
          <div class="col-sm-6"><strong>Ngày giờ lập (VN):</strong> <span>${createdDate}</span></div>
          <div class="col-sm-6"><strong>Người lập:</strong> <span class="fw-semibold">${escapeHtml(creator)}</span></div>
          <div class="col-sm-6"><strong>Tổng tiền phiếu:</strong> <span class="text-danger fw-bold fs-6">${totalAmountStr}</span></div>
        </div>
      </div>
      <h6 class="fw-bold mb-2 text-dark"><i class="bi bi-list-check me-1 text-primary"></i> Danh sách mặt hàng nhập kho:</h6>
      <div class="table-responsive border rounded">
        <table class="table table-bordered table-hover table-sm align-middle mb-0">
          <thead class="table-light">
            <tr>
              <th class="text-center" style="width: 40px;">#</th>
              <th>Mã SKU</th>
              <th>Tên Sản Phẩm</th>
              <th class="text-center" style="width: 75px;">ĐVT</th>
              <th class="text-center" style="width: 80px;">Số Lượng</th>
              <th class="text-end" style="width: 125px;">Giá Nhập</th>
              <th class="text-end" style="width: 135px;">Thành Tiền</th>
            </tr>
          </thead>
          <tbody>
    `;

    if (items.length === 0) {
      contentHtml += `<tr><td colspan="7" class="text-center text-muted py-3">Phiếu này không có chi tiết mặt hàng</td></tr>`;
    } else {
      items.forEach((it, idx) => {
        const lineTotal = Number(it.quantity) * Number(it.unit_cost);
        contentHtml += `
          <tr>
            <td class="text-center text-muted">${idx + 1}</td>
            <td><span class="badge bg-secondary font-monospace">${escapeHtml(it.sku || 'N/A')}</span></td>
            <td class="fw-semibold">${escapeHtml(it.product_name_snapshot || '')}</td>
            <td class="text-center">${escapeHtml(it.unit_snapshot || '')}</td>
            <td class="text-center fw-bold text-primary">${it.quantity}</td>
            <td class="text-end">${formatMoney(it.unit_cost)}</td>
            <td class="text-end fw-bold text-danger">${formatMoney(lineTotal)}</td>
          </tr>
        `;
      });

      contentHtml += `
          </tbody>
          <tfoot class="table-light">
            <tr>
              <th colspan="6" class="text-end fw-bold">Tổng cộng phiếu:</th>
              <th class="text-end fw-bold text-danger fs-6">${totalAmountStr}</th>
            </tr>
          </tfoot>
      `;
    }

    contentHtml += `
        </table>
      </div>
    `;

    if (modalBody) modalBody.innerHTML = contentHtml;
  } catch (err) {
    console.error('Lỗi tải chi tiết phiếu nhập:', err);
    if (modalBody) modalBody.innerHTML = '<div class="alert alert-danger mb-0">Lỗi kết nối khi tải chi tiết phiếu nhập</div>';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  renderCart();
  loadProducts();
  loadHistory(1);

  // Tìm kiếm nhanh dropdown sản phẩm
  const searchInput = document.getElementById('r-product-search');
  if (searchInput) {
    searchInput.addEventListener('input', filterProductDropdown);
  }

  // Tìm kiếm lịch sử khi gõ với debounce
  const historySearch = document.getElementById('history-search');
  let historySearchTimeout = null;
  if (historySearch) {
    historySearch.addEventListener('input', () => {
      clearReceiptMessage();
      clearTimeout(historySearchTimeout);
      historySearchTimeout = setTimeout(() => {
        loadHistory(1);
      }, 300);
    });
  }

  // Xóa thông báo khi người dùng thay đổi dữ liệu trên form
  const inputsToClear = ['r-product', 'r-qty', 'r-cost', 'r-no'];
  inputsToClear.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', clearReceiptMessage);
      el.addEventListener('change', clearReceiptMessage);
    }
  });

  // Tự động xóa lỗi khoảng ngày khi người dùng chỉnh lại ngày hợp lệ
  ['history-from-date', 'history-to-date'].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('input', () => {
        const fromVal = document.getElementById('history-from-date')?.value.trim() || '';
        const toVal = document.getElementById('history-to-date')?.value.trim() || '';
        if (!fromVal || !toVal || fromVal <= toVal) {
          clearHistoryFilterError();
        }
      });
      el.addEventListener('change', () => {
        const fromVal = document.getElementById('history-from-date')?.value.trim() || '';
        const toVal = document.getElementById('history-to-date')?.value.trim() || '';
        if (!fromVal || !toVal || fromVal <= toVal) {
          clearHistoryFilterError();
        }
      });
    }
  });
});