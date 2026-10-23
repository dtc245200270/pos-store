let currentProducts = [];
let currentPage = 1;
const pageSize = 10;
let totalPages = 1;
let totalItems = 0;
let currentSearch = '';
let currentStatus = 'all';

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.remove('show');
    el.style.display = 'none';
  }
}

function openModal(id) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.add('show');
    el.style.display = 'block';
  }
}

function showError(msg) {
  const errDiv = document.getElementById('p-error');
  if (errDiv) {
    errDiv.textContent = msg;
    errDiv.classList.remove('d-none');
  }
}

function clearError() {
  const errDiv = document.getElementById('p-error');
  if (errDiv) {
    errDiv.textContent = '';
    errDiv.classList.add('d-none');
  }
}

function showAddProductModal() {
  document.getElementById('product-modal-title').textContent = 'Thêm Sản Phẩm Mới';
  document.getElementById('p-id').value = '';
  
  const skuEl = document.getElementById('p-sku');
  skuEl.value = '';
  skuEl.disabled = false;
  skuEl.readOnly = false;

  document.getElementById('p-name').value = '';
  document.getElementById('p-unit').value = '';
  document.getElementById('p-price').value = '';

  const stockNotice = document.getElementById('p-stock-notice');
  if (stockNotice) {
    stockNotice.innerHTML = `
      <div class="alert alert-info py-2 small mb-0">
        <i class="bi bi-info-circle me-1"></i> <strong>Tồn kho ban đầu: 0</strong>. Theo quy định hệ thống, số lượng tồn kho không thể sửa trực tiếp mà chỉ được cập nhật thông qua <em>Phiếu Nhập Hàng</em>.
      </div>
    `;
  }
  
  clearError();
  openModal('product-modal');
}

async function showEditProductModal(id) {
  let p = currentProducts.find(x => String(x.id) === String(id));
  if (!p) {
    try {
      const res = await window.apiFetch('/api/products/' + id);
      if (res && res.ok) {
        p = await res.json();
      }
    } catch (e) {
      console.error('Lỗi lấy thông tin sản phẩm:', e);
    }
  }

  if (!p) {
    alert('Không tìm thấy thông tin sản phẩm');
    return;
  }

  document.getElementById('product-modal-title').textContent = `Sửa Sản Phẩm (#${p.id} - ${p.sku})`;
  document.getElementById('p-id').value = p.id;

  // Cho phép MANAGER chỉnh sửa mã SKU
  const skuEl = document.getElementById('p-sku');
  skuEl.value = p.sku || '';
  skuEl.disabled = false;
  skuEl.readOnly = false;

  document.getElementById('p-name').value = p.name || '';
  document.getElementById('p-unit').value = p.unit || '';
  
  const rawPrice = p.sale_price !== undefined && p.sale_price !== null ? p.sale_price : '';
  document.getElementById('p-price').value = rawPrice !== '' ? Number(rawPrice) : '';

  // Khung thông báo tồn kho hiển thị tồn hiện tại, chặn sửa trực tiếp
  const stockNotice = document.getElementById('p-stock-notice');
  if (stockNotice) {
    stockNotice.innerHTML = `
      <div class="alert alert-light border py-2 small mb-0">
        <i class="bi bi-box-seam me-1"></i> <strong>Tồn kho hiện tại: ${p.stock_quantity} ${p.unit}</strong>. Không cho phép sửa tồn kho trực tiếp trong biểu mẫu sản phẩm (tồn kho chỉ thay đổi qua Nhập hàng / Bán hàng).
      </div>
    `;
  }

  clearError();
  openModal('product-modal');
}

function renderProducts(data) {
  const tbody = document.getElementById('products-tbody');
  tbody.innerHTML = '';

  if (!data || data.length === 0) {
    const emptyTr = document.createElement('tr');
    emptyTr.innerHTML = '<td colspan="7" class="text-center text-muted py-4"><i class="bi bi-inbox fs-4 d-block mb-1"></i>Không tìm thấy sản phẩm phù hợp</td>';
    tbody.appendChild(emptyTr);
    return;
  }

  data.forEach(p => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="ps-3 fw-bold text-primary font-monospace">${escapeHtml(p.sku)}</td>
      <td class="fw-medium">${escapeHtml(p.name)}</td>
      <td class="text-center">${escapeHtml(p.unit)}</td>
      <td class="text-end fw-semibold">${Number(p.sale_price).toLocaleString('vi-VN')} đ</td>
      <td class="text-center">
        <span class="badge ${p.stock_quantity > 0 ? 'bg-light text-dark border' : 'bg-danger-subtle text-danger border border-danger-subtle'} px-2 py-1">
          ${p.stock_quantity}
        </span>
      </td>
      <td class="text-center">
        ${p.is_active 
          ? '<span class="badge bg-success px-2 py-1"><i class="bi bi-check-circle me-1"></i>Đang hoạt động</span>' 
          : '<span class="badge bg-secondary px-2 py-1"><i class="bi bi-slash-circle me-1"></i>Ngừng kinh doanh</span>'}
      </td>
      <td class="text-end pe-3">
        <div class="d-flex justify-content-end align-items-center gap-1">
          <button class="btn btn-sm btn-outline-primary" onclick="showEditProductModal(${p.id})" title="Sửa thông tin sản phẩm">
            <i class="bi bi-pencil me-1"></i>Sửa
          </button>
          <div class="dropdown">
            <button class="btn btn-sm btn-outline-secondary dropdown-toggle" type="button" data-bs-toggle="dropdown" aria-expanded="false" title="Thao tác khác">
              Thao tác
            </button>
            <ul class="dropdown-menu dropdown-menu-end shadow-sm">
              <li>
                <button class="dropdown-item py-2" type="button" onclick="toggleActive(${p.id}, ${!p.is_active}, '${escapeJs(p.name)}')">
                  ${p.is_active 
                    ? '<i class="bi bi-slash-circle me-2 text-warning"></i>Ngừng kinh doanh' 
                    : '<i class="bi bi-arrow-repeat me-2 text-success"></i>Kích hoạt lại'}
                </button>
              </li>
              <li><hr class="dropdown-divider my-1"></li>
              <li>
                <button class="dropdown-item py-2 text-danger" type="button" onclick="deleteProduct(${p.id}, '${escapeJs(p.name)}')">
                  <i class="bi bi-trash me-2"></i>Xóa sản phẩm
                </button>
              </li>
            </ul>
          </div>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

function renderPagination() {
  const infoEl = document.getElementById('pagination-info');
  const controlsEl = document.getElementById('pagination-controls');
  if (!infoEl || !controlsEl) return;

  if (totalItems === 0) {
    infoEl.textContent = 'Không có sản phẩm nào';
    controlsEl.innerHTML = '';
    return;
  }

  const startItem = (currentPage - 1) * pageSize + 1;
  const endItem = Math.min(currentPage * pageSize, totalItems);
  infoEl.textContent = `Hiển thị ${startItem} - ${endItem} trên tổng số ${totalItems} sản phẩm (Trang ${currentPage}/${totalPages})`;

  let html = '';

  // Nút Trước
  const prevDisabled = currentPage <= 1 ? 'disabled' : '';
  html += `
    <li class="page-item ${prevDisabled}">
      <a class="page-link" href="#" onclick="changePage(${currentPage - 1}); return false;" aria-label="Trước">&laquo;</a>
    </li>
  `;

  // Các trang số
  const maxButtons = 5;
  let startPage = Math.max(1, currentPage - Math.floor(maxButtons / 2));
  let endPage = Math.min(totalPages, startPage + maxButtons - 1);
  if (endPage - startPage + 1 < maxButtons) {
    startPage = Math.max(1, endPage - maxButtons + 1);
  }

  for (let i = startPage; i <= endPage; i++) {
    const activeClass = i === currentPage ? 'active' : '';
    html += `
      <li class="page-item ${activeClass}">
        <a class="page-link" href="#" onclick="changePage(${i}); return false;">${i}</a>
      </li>
    `;
  }

  // Nút Sau
  const nextDisabled = currentPage >= totalPages ? 'disabled' : '';
  html += `
    <li class="page-item ${nextDisabled}">
      <a class="page-link" href="#" onclick="changePage(${currentPage + 1}); return false;" aria-label="Sau">&raquo;</a>
    </li>
  `;

  controlsEl.innerHTML = html;
}

function changePage(page) {
  if (page < 1 || page > totalPages || page === currentPage) return;
  loadProducts(page);
}

async function loadProducts(page = 1) {
  currentPage = page;
  try {
    const url = `/api/products?page=${currentPage}&limit=${pageSize}&q=${encodeURIComponent(currentSearch)}&status=${currentStatus}`;
    const res = await window.apiFetch(url);
    if (!res || !res.ok) {
      alert('Lỗi tải danh sách sản phẩm');
      return;
    }
    const result = await res.json();
    if (result && result.pagination) {
      currentProducts = result.data || [];
      totalPages = result.pagination.totalPages || 1;
      totalItems = result.pagination.total || 0;
      currentPage = result.pagination.page || 1;
    } else if (Array.isArray(result)) {
      currentProducts = result;
      totalItems = result.length;
      totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
    }
    renderProducts(currentProducts);
    renderPagination();
  } catch (err) {
    console.error('Lỗi loadProducts:', err);
  }
}

let pendingToggleProductId = null;

async function toggleActive(id, newStatus, productName) {
  const nameDecoded = decodeURIComponent(productName);
  const actionText = newStatus ? 'kích hoạt lại để tiếp tục bán' : 'ngừng kinh doanh (hệ thống sẽ chặn bán mới sản phẩm này)';
  if (!confirm(`Bạn có chắc chắn muốn ${actionText} sản phẩm "${nameDecoded}" không?`)) {
    return;
  }

  await toggleActiveDirect(id, newStatus);
}

async function toggleActiveDirect(id, newStatus) {
  try {
    const res = await window.apiFetch('/api/products/' + id + '/toggle-active', {
      method: 'PATCH',
      body: JSON.stringify({ is_active: newStatus })
    });

    if (res && res.ok) {
      await loadProducts(currentPage);
    } else {
      let data = {};
      try { data = await res.json(); } catch (e) {}
      alert(window.formatApiError(data, 'Lỗi cập nhật trạng thái kinh doanh'));
    }
  } catch (err) {
    console.error('Lỗi toggleActiveDirect:', err);
    alert('Lỗi kết nối máy chủ');
  }
}

async function confirmSwitchToInactive() {
  if (!pendingToggleProductId) return;
  closeModal('delete-fail-modal');
  await toggleActiveDirect(pendingToggleProductId, false);
  pendingToggleProductId = null;
}

async function deleteProduct(id, productName) {
  const nameDecoded = decodeURIComponent(productName);
  
  if (!confirm(`Bạn có chắc chắn muốn xóa vĩnh viễn sản phẩm "${nameDecoded}" không?\n\nLưu ý: Chỉ có thể xóa sản phẩm có tồn kho bằng 0 và chưa từng phát sinh chứng từ (hóa đơn, phiếu nhập, biến động kho).`)) {
    return;
  }

  try {
    const res = await window.apiFetch('/api/products/' + id, {
      method: 'DELETE'
    });

    let data = {};
    try { data = await res.json(); } catch (e) {}

    if (res && res.ok) {
      alert('Đã xóa sản phẩm thành công.');
      await loadProducts(currentPage);
    } else {
      if (data && data.requestId) {
        alert('Không thể thực hiện thao tác. Mã tra cứu: ' + data.requestId);
        return;
      }
      const errorMsg = data.message || data.error || 'Không thể xóa sản phẩm này.';
      const suggestMsg = data.suggest || 'Chuyển trạng thái sang "Ngừng kinh doanh"';

      const reasonEl = document.getElementById('delete-fail-reason');
      const suggestEl = document.getElementById('delete-fail-suggest');
      const modalEl = document.getElementById('delete-fail-modal');

      if (reasonEl && suggestEl && modalEl) {
        reasonEl.innerHTML = `<strong>Lý do từ chối:</strong> ${escapeHtml(errorMsg)}`;
        suggestEl.innerHTML = `Để bảo toàn tính toàn vẹn dữ liệu kế toán và lịch sử giao dịch cũ, hệ thống khuyến nghị bạn <strong>${escapeHtml(suggestMsg)}</strong>.`;
        pendingToggleProductId = id;
        openModal('delete-fail-modal');
      } else {
        if (confirm(`⚠️ ${errorMsg}\n\n💡 Gợi ý: ${suggestMsg}\n\nBạn có muốn chuyển sang "Ngừng kinh doanh" ngay bây giờ không?`)) {
          await toggleActiveDirect(id, false);
        }
      }
    }
  } catch (err) {
    console.error('Lỗi deleteProduct:', err);
    alert('Lỗi kết nối khi xóa sản phẩm');
  }
}

async function saveProduct() {
  const id = document.getElementById('p-id').value;
  const isEditing = Boolean(id);

  const sku = document.getElementById('p-sku').value.trim();
  const name = document.getElementById('p-name').value.trim();
  const unit = document.getElementById('p-unit').value.trim();
  const priceInput = document.getElementById('p-price').value.trim();

  clearError();

  // Kiểm tra hợp lệ ở Frontend
  if (!sku) {
    showError('Vui lòng nhập mã SKU');
    return;
  }

  if (!name) {
    showError('Vui lòng nhập tên sản phẩm');
    return;
  }

  if (!unit) {
    showError('Vui lòng nhập đơn vị tính');
    return;
  }

  if (priceInput === '' || priceInput === null || priceInput === undefined) {
    showError('Vui lòng nhập giá bán');
    return;
  }

  const price = Number(priceInput);
  if (isNaN(price) || !isFinite(price) || price <= 0) {
    showError('Giá bán phải là số hợp lệ lớn hơn 0 (không âm)');
    return;
  }

  if (!/^\d+(\.\d{1,2})?$/.test(priceInput)) {
    showError('Giá bán không được vượt quá 2 chữ số thập phân');
    return;
  }

  if (price >= 10000000000000) {
    showError('Giá bán vượt quá giới hạn hệ thống');
    return;
  }

  // Tồn kho KHÔNG cho phép gửi hoặc sửa từ biểu mẫu
  const payload = {
    sku,
    name,
    unit,
    sale_price: price
  };

  const saveBtn = document.getElementById('btn-save-product');
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Đang lưu...';
  }

  try {
    let res;
    if (isEditing) {
      res = await window.apiFetch('/api/products/' + id, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
    } else {
      res = await window.apiFetch('/api/products', {
        method: 'POST',
        body: JSON.stringify(payload)
      });
    }

    if (res && res.ok) {
      closeModal('product-modal');
      await loadProducts(isEditing ? currentPage : 1);
    } else {
      let data = {};
      try { data = await res.json(); } catch (e) {}
      showError(window.formatApiError(data, 'Lỗi lưu sản phẩm'));
    }
  } catch (err) {
    showError('Lỗi kết nối máy chủ');
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.innerHTML = '<i class="bi bi-check-lg me-1"></i> Lưu Sản Phẩm';
    }
  }
}

function resetFilters() {
  document.getElementById('search-products').value = '';
  document.getElementById('filter-status').value = 'all';
  currentSearch = '';
  currentStatus = 'all';
  loadProducts(1);
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeJs(str) {
  if (!str) return '';
  return encodeURIComponent(String(str));
}

document.addEventListener('DOMContentLoaded', () => {
  loadProducts(1);

  // Tìm kiếm theo tên / SKU với debounce
  const searchInput = document.getElementById('search-products');
  let searchTimeout = null;
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        currentSearch = e.target.value.trim();
        loadProducts(1);
      }, 300);
    });
  }

  // Lọc theo trạng thái
  const statusSelect = document.getElementById('filter-status');
  if (statusSelect) {
    statusSelect.addEventListener('change', (e) => {
      currentStatus = e.target.value;
      loadProducts(1);
    });
  }
});