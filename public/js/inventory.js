// Quản lý và tra cứu tồn kho - POS Store
let currentUserRole = '';
let currentInventory = [];
let currentThreshold = 5;
let searchDebounceTimer = null;

// Hàm định dạng thời gian chuẩn giờ Việt Nam (UTC+7)
function formatDateTimeVN(dateVal) {
  if (!dateVal) return 'Không rõ';
  const d = new Date(dateVal);
  if (isNaN(d.getTime())) return 'Không rõ';
  return d.toLocaleString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
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

// Khởi tạo thông tin người dùng và vai trò
async function initUserRole() {
  try {
    const res = await window.apiFetch('/api/auth/me');
    if (!res || !res.ok) return;
    const user = await res.json();
    currentUserRole = user.role;

    const roleBadge = document.getElementById('user-role-badge');
    if (roleBadge) {
      if (currentUserRole === 'MANAGER') {
        roleBadge.className = 'badge bg-primary';
        roleBadge.innerHTML = '<i class="bi bi-shield-check me-1"></i>Quản lý';
      } else if (currentUserRole === 'CASHIER') {
        roleBadge.className = 'badge bg-secondary';
        roleBadge.innerHTML = '<i class="bi bi-person me-1"></i>Thu ngân (Chỉ tra cứu)';
      } else {
        roleBadge.className = 'badge bg-info';
        roleBadge.textContent = currentUserRole;
      }
    }

    // Nếu là CASHIER, cập nhật tiêu đề cột thao tác
    const actionHeader = document.getElementById('col-action-header');
    if (actionHeader && currentUserRole === 'CASHIER') {
      actionHeader.textContent = 'Quyền hạn';
    }
  } catch (err) {
    console.error('Lỗi lấy thông tin người dùng:', err);
  }
}

// Cập nhật khi người dùng thay đổi giá trị ngưỡng cảnh báo
function onThresholdChange() {
  const input = document.getElementById('low-stock-threshold');
  let val = parseInt(input ? input.value : '5', 10);
  if (isNaN(val) || val < 0) {
    val = 5;
    if (input) input.value = '5';
  }
  currentThreshold = val;

  const label = document.getElementById('current-threshold-label');
  if (label) label.textContent = currentThreshold;

  loadInventory();
}

// Tải danh sách tồn kho từ API
async function loadInventory() {
  const loadingEl = document.getElementById('inventory-loading');
  const tableContainer = document.getElementById('inventory-table-container');
  const emptyEl = document.getElementById('inventory-empty');
  const errorEl = document.getElementById('inventory-error');
  const errorTextEl = document.getElementById('inventory-error-text');
  const refreshBtn = document.getElementById('btn-refresh-inventory');

  // Đặt trạng thái đang tải
  if (loadingEl) loadingEl.classList.remove('d-none');
  if (tableContainer) tableContainer.classList.add('d-none');
  if (emptyEl) emptyEl.classList.add('d-none');
  if (errorEl) errorEl.classList.add('d-none');
  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Đang tải...';
  }

  // Thu thập tham số lọc
  const searchInput = document.getElementById('search-inventory');
  const filterSelect = document.getElementById('filter-stock-status');
  const thresholdInput = document.getElementById('low-stock-threshold');

  const q = searchInput ? searchInput.value.trim() : '';
  const status = filterSelect ? filterSelect.value : 'all';
  const threshold = thresholdInput ? parseInt(thresholdInput.value, 10) || currentThreshold : currentThreshold;

  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (status && status !== 'all') params.set('status', status);
  params.set('threshold', String(threshold));

  try {
    const res = await window.apiFetch('/api/inventory?' + params.toString());
    if (!res || !res.ok) {
      throw new Error(`Máy chủ phản hồi mã lỗi ${res ? res.status : 'không xác định'}`);
    }

    const data = await res.json();
    currentInventory = data.products || (Array.isArray(data) ? data : []);
    currentThreshold = typeof data.threshold === 'number' ? data.threshold : threshold;

    // Cập nhật nhãn ngưỡng
    const label = document.getElementById('current-threshold-label');
    if (label) label.textContent = currentThreshold;

    // Cập nhật các thẻ thống kê
    if (data.stats) {
      const elTotal = document.getElementById('stat-total');
      const elSafe = document.getElementById('stat-safe');
      const elLow = document.getElementById('stat-low');
      const elOut = document.getElementById('stat-out');
      if (elTotal) elTotal.textContent = data.stats.totalItems;
      if (elSafe) elSafe.textContent = data.stats.safeStockItems;
      if (elLow) elLow.textContent = data.stats.lowStockItems;
      if (elOut) elOut.textContent = data.stats.outOfStockItems;
    }

    // Ẩn loading
    if (loadingEl) loadingEl.classList.add('d-none');

    // Kiểm tra danh sách rỗng
    if (!currentInventory || currentInventory.length === 0) {
      if (emptyEl) emptyEl.classList.remove('d-none');
      const countEl = document.getElementById('inventory-count-info');
      if (countEl) countEl.textContent = 'Hiển thị 0 sản phẩm';
      return;
    }

    // Render danh sách sản phẩm
    renderInventoryTable(currentInventory);
    if (tableContainer) tableContainer.classList.remove('d-none');

    const countEl = document.getElementById('inventory-count-info');
    if (countEl) countEl.textContent = `Hiển thị ${currentInventory.length} sản phẩm`;

  } catch (err) {
    console.error('Lỗi tải danh sách tồn kho:', err);
    if (loadingEl) loadingEl.classList.add('d-none');
    if (errorEl) {
      if (errorTextEl) errorTextEl.textContent = `Lỗi khi tải dữ liệu tồn kho: ${err.message || 'Không thể kết nối'}.`;
      errorEl.classList.remove('d-none');
    }
  } finally {
    if (refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.innerHTML = '<i class="bi bi-arrow-clockwise me-1"></i> Làm mới dữ liệu';
    }
  }
}

// Render các dòng vào bảng tồn kho
function renderInventoryTable(products) {
  const tbody = document.getElementById('inventory-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  products.forEach((p, idx) => {
    const tr = document.createElement('tr');
    const stock = Number(p.stock_quantity || 0);

    // Xác định badge màu cảnh báo theo số lượng tồn
    let stockBadgeHtml = '';
    if (stock === 0) {
      stockBadgeHtml = `<span class="badge bg-danger badge-stock"><i class="bi bi-x-circle-fill me-1"></i>0 ${escapeHtml(p.unit)} (Hết hàng)</span>`;
    } else if (stock <= currentThreshold) {
      stockBadgeHtml = `<span class="badge bg-warning text-dark badge-stock"><i class="bi bi-exclamation-triangle-fill me-1"></i>${stock} ${escapeHtml(p.unit)} (Sắp hết)</span>`;
    } else {
      stockBadgeHtml = `<span class="badge bg-success badge-stock"><i class="bi bi-check-circle-fill me-1"></i>${stock} ${escapeHtml(p.unit)}</span>`;
    }

    // Trạng thái kinh doanh
    const statusBadge = p.is_active
      ? '<span class="badge bg-success bg-opacity-75">Đang kinh doanh</span>'
      : '<span class="badge bg-secondary">Ngừng kinh doanh</span>';

    // Thao tác: Chỉ Quản lý mới có nút xem Lịch sử biến động
    let actionHtml = '';
    if (currentUserRole === 'MANAGER') {
      actionHtml = `
        <button type="button" class="btn btn-outline-primary btn-sm" onclick="viewHistory(${p.id})" title="Xem lịch sử biến động kho của ${escapeHtml(p.name)}">
          <i class="bi bi-clock-history me-1"></i> Lịch sử
        </button>
      `;
    } else {
      actionHtml = `
        <span class="badge bg-light text-muted border py-1 px-2" title="Chỉ Quản lý mới có quyền xem lịch sử chứng từ">
          <i class="bi bi-lock me-1"></i> Chỉ tra cứu
        </span>
      `;
    }

    tr.innerHTML = `
      <td class="text-center text-muted">${idx + 1}</td>
      <td><span class="badge bg-secondary font-monospace">${escapeHtml(p.sku)}</span></td>
      <td class="fw-semibold text-dark">${escapeHtml(p.name)}</td>
      <td class="text-center text-muted">${escapeHtml(p.unit)}</td>
      <td class="text-center">${stockBadgeHtml}</td>
      <td class="text-center">${statusBadge}</td>
      <td class="text-center">${actionHtml}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ----------------------------------------------------------------------------
// MODAL LỊCH SỬ BIẾN ĐỘNG KHO (DÀNH CHO QUẢN LÝ)
// ----------------------------------------------------------------------------
function openHistoryModal() {
  const modalEl = document.getElementById('history-modal');
  if (modalEl) {
    modalEl.classList.add('show');
    modalEl.style.display = 'block';
  }
}

function closeHistoryModal() {
  const modalEl = document.getElementById('history-modal');
  if (modalEl) {
    modalEl.classList.remove('show');
    modalEl.style.display = 'none';
  }
}

async function viewHistory(productId) {
  // Kiểm tra quyền phía Client
  if (currentUserRole !== 'MANAGER') {
    alert('Bị từ chối truy cập: Thu ngân (CASHIER) chỉ được phép tra cứu tồn kho, không có quyền xem lịch sử chứa chứng từ của người khác.');
    return;
  }

  const modalTitle = document.getElementById('history-modal-title');
  const modalSku = document.getElementById('modal-sku');
  const modalName = document.getElementById('modal-name');
  const modalStock = document.getElementById('modal-stock');
  const loadingEl = document.getElementById('history-loading');
  const errorEl = document.getElementById('history-error');
  const errorTextEl = document.getElementById('history-error-text');
  const tableContainer = document.getElementById('history-table-container');
  const emptyEl = document.getElementById('history-empty');
  const tbody = document.getElementById('history-tbody');

  // Đặt trạng thái ban đầu của modal
  if (loadingEl) loadingEl.classList.remove('d-none');
  if (errorEl) errorEl.classList.add('d-none');
  if (tableContainer) tableContainer.classList.add('d-none');
  if (emptyEl) emptyEl.classList.add('d-none');
  if (tbody) tbody.innerHTML = '';

  if (modalTitle) modalTitle.innerHTML = `<i class="bi bi-clock-history me-2 text-info"></i>Đang tải lịch sử...`;
  if (modalSku) modalSku.textContent = '-';
  if (modalName) modalName.textContent = '-';
  if (modalStock) modalStock.textContent = '-';

  openHistoryModal();

  try {
    const res = await window.apiFetch(`/api/inventory/${productId}/movements`);
    if (!res || !res.ok) {
      if (res && res.status === 403) {
        throw new Error('Chỉ Quản lý (MANAGER) mới có quyền truy cập lịch sử biến động kho và chứng từ chi tiết.');
      }
      throw new Error(`Lỗi máy chủ: ${res ? res.status : 'Không phản hồi'}`);
    }

    const data = await res.json();
    const product = data.product || {};
    const movements = data.movements || [];

    // Cập nhật thông tin sản phẩm trên modal
    if (modalTitle) {
      modalTitle.innerHTML = `<i class="bi bi-clock-history me-2 text-info"></i>Lịch Sử Biến Động Kho: ${escapeHtml(product.name)} (${escapeHtml(product.sku)})`;
    }
    if (modalSku) modalSku.textContent = product.sku || 'N/A';
    if (modalName) modalName.textContent = product.name || 'N/A';
    if (modalStock) modalStock.textContent = `${product.stock_quantity} ${product.unit || ''}`;

    if (loadingEl) loadingEl.classList.add('d-none');

    // Nếu chưa có biến động nào
    if (!movements || movements.length === 0) {
      if (emptyEl) emptyEl.classList.remove('d-none');
      return;
    }

    // Render bảng biến động kho
    if (tbody) {
      tbody.innerHTML = '';
      movements.forEach((m, idx) => {
        const tr = document.createElement('tr');
        const delta = Number(m.quantity_delta);
        const isImport = delta > 0;

        // Loại biến động
        const typeBadge = isImport
          ? '<span class="badge bg-success bg-opacity-75"><i class="bi bi-box-arrow-in-down me-1"></i>Nhập kho</span>'
          : '<span class="badge bg-danger bg-opacity-75"><i class="bi bi-cart-check me-1"></i>Xuất bán</span>';

        // Biến động số lượng có dấu (+ / -)
        const deltaFormatted = isImport
          ? `<span class="text-success fw-bold font-monospace fs-6">+${delta}</span>`
          : `<span class="text-danger fw-bold font-monospace fs-6">${delta}</span>`;

        // Thời gian chuẩn giờ Việt Nam
        const dateStr = formatDateTimeVN(m.created_at);

        tr.innerHTML = `
          <td class="text-center text-muted">${idx + 1}</td>
          <td><i class="bi bi-calendar3 me-1 text-muted"></i>${dateStr}</td>
          <td class="text-center">${typeBadge}</td>
          <td><span class="font-monospace text-primary fw-semibold">${escapeHtml(m.document_no)}</span></td>
          <td><i class="bi bi-person me-1 text-secondary"></i>${escapeHtml(m.performed_by)}</td>
          <td class="text-end">${deltaFormatted}</td>
          <td class="text-end fw-bold font-monospace text-dark">${m.balance_after}</td>
        `;
        tbody.appendChild(tr);
      });
    }

    if (tableContainer) tableContainer.classList.remove('d-none');

  } catch (err) {
    console.error('Lỗi khi lấy lịch sử biến động:', err);
    if (loadingEl) loadingEl.classList.add('d-none');
    if (errorEl) {
      if (errorTextEl) errorTextEl.textContent = err.message || 'Không thể tải lịch sử biến động kho.';
      errorEl.classList.remove('d-none');
    }
  }
}

// Lắng nghe sự kiện khởi chạy trang
document.addEventListener('DOMContentLoaded', async () => {
  await initUserRole();
  await loadInventory();

  // Tìm kiếm theo SKU/Tên với debounce
  const searchInput = document.getElementById('search-inventory');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        loadInventory();
      }, 300);
    });
  }

  // Đóng modal khi bấm ESC hoặc click ra ngoài backdrop
  window.addEventListener('click', (e) => {
    const modalEl = document.getElementById('history-modal');
    if (e.target === modalEl) {
      closeHistoryModal();
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeHistoryModal();
    }
  });
});