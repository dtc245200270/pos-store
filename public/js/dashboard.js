// Trang Tổng quan dành cho Quản lý (MANAGER) - POS Store

function formatMoney(amount) {
  return Number(amount || 0).toLocaleString('vi-VN') + ' đ';
}

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

function formatDateVN(dateStr) {
  if (!dateStr) return '';
  // dateStr: YYYY-MM-DD
  const parts = dateStr.split('-');
  if (parts.length === 3) {
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }
  return dateStr;
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

async function loadDashboard() {
  const loadingEl = document.getElementById('dashboard-loading');
  const contentEl = document.getElementById('dashboard-content');
  const errorEl = document.getElementById('dashboard-error');
  const errorTextEl = document.getElementById('dashboard-error-text');
  const refreshBtn = document.getElementById('btn-refresh-dashboard');

  if (loadingEl) loadingEl.classList.remove('d-none');
  if (contentEl) contentEl.classList.add('d-none');
  if (errorEl) errorEl.classList.add('d-none');
  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span> Đang tải...';
  }

  try {
    const res = await window.apiFetch('/api/dashboard/stats');
    if (!res || !res.ok) {
      if (res && res.status === 403) {
        throw new Error('Chỉ Quản lý (MANAGER) mới có quyền truy cập dữ liệu thống kê tổng quan.');
      }
      throw new Error(`Máy chủ phản hồi mã lỗi ${res ? res.status : 'không xác định'}`);
    }

    const data = await res.json();

    // 1. Cập nhật ngày hôm nay theo Asia/Ho_Chi_Minh
    const todayLabel = document.getElementById('today-date-label');
    if (todayLabel) {
      todayLabel.textContent = formatDateVN(data.date);
    }

    // 2. Cập nhật các thẻ số liệu
    const elRevenue = document.getElementById('stat-today-revenue');
    const elInvoices = document.getElementById('stat-today-invoices');
    const elProducts = document.getElementById('stat-active-products');
    const elLowStockCount = document.getElementById('stat-low-stock-count');

    if (elRevenue) elRevenue.textContent = formatMoney(data.summary?.todayRevenue || 0);
    if (elInvoices) elInvoices.textContent = (data.summary?.todayInvoicesCount || 0).toLocaleString('vi-VN');
    if (elProducts) elProducts.textContent = (data.summary?.activeProductsCount || 0).toLocaleString('vi-VN');

    const lowStockList = data.lowStockProducts || [];
    const totalLowStock = (data.summary && data.summary.lowStockCount !== undefined)
      ? Number(data.summary.lowStockCount)
      : lowStockList.length;
    if (elLowStockCount) elLowStockCount.textContent = totalLowStock.toLocaleString('vi-VN');

    // 3. Render danh sách sản phẩm hết / sắp hết hàng
    renderLowStockProducts(lowStockList, data.threshold || 5, totalLowStock);

    // 4. Render danh sách hóa đơn gần đây
    renderRecentInvoices(data.recentInvoices || []);

    if (loadingEl) loadingEl.classList.add('d-none');
    if (contentEl) contentEl.classList.remove('d-none');

  } catch (err) {
    console.error('Lỗi khi tải dữ liệu tổng quan:', err);
    if (loadingEl) loadingEl.classList.add('d-none');
    if (errorEl) {
      if (errorTextEl) errorTextEl.textContent = err.message || 'Lỗi kết nối khi tải dữ liệu tổng quan.';
      errorEl.classList.remove('d-none');
    }
  } finally {
    if (refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.innerHTML = '<i class="bi bi-arrow-clockwise me-1"></i> Làm mới';
    }
  }
}

function renderLowStockProducts(products, threshold, totalLowStock = null) {
  const tableContainer = document.getElementById('low-stock-table-container');
  const emptyEl = document.getElementById('low-stock-empty');
  const tbody = document.getElementById('low-stock-tbody');

  // Xóa ghi chú cũ nếu có
  const existingNote = document.getElementById('low-stock-more-note');
  if (existingNote) existingNote.remove();

  if (!products || products.length === 0) {
    if (tableContainer) tableContainer.classList.add('d-none');
    if (emptyEl) emptyEl.classList.remove('d-none');
    return;
  }

  if (emptyEl) emptyEl.classList.add('d-none');
  if (tableContainer) tableContainer.classList.remove('d-none');
  if (!tbody) return;

  tbody.innerHTML = '';
  products.forEach((p, idx) => {
    const tr = document.createElement('tr');
    const stock = Number(p.stock_quantity || 0);

    let stockBadgeHtml = '';
    if (stock === 0) {
      stockBadgeHtml = `<span class="badge bg-danger badge-stock"><i class="bi bi-x-circle-fill me-1"></i>0 ${escapeHtml(p.unit)} (Hết)</span>`;
    } else {
      stockBadgeHtml = `<span class="badge bg-warning text-dark badge-stock"><i class="bi bi-exclamation-triangle-fill me-1"></i>${stock} ${escapeHtml(p.unit)} (Sắp hết)</span>`;
    }

    tr.innerHTML = `
      <td class="text-center text-muted">${idx + 1}</td>
      <td><span class="badge bg-secondary font-monospace">${escapeHtml(p.sku)}</span></td>
      <td class="fw-semibold text-dark">${escapeHtml(p.name)}</td>
      <td class="text-center text-muted small">${escapeHtml(p.unit)}</td>
      <td class="text-center">${stockBadgeHtml}</td>
      <td class="text-center">
        <a href="/stock-receipts" class="btn btn-outline-success btn-sm py-0 px-2" title="Lập phiếu nhập cho sản phẩm này">
          <i class="bi bi-plus-lg me-1"></i>Nhập
        </a>
      </td>
    `;
    tbody.appendChild(tr);
  });

  // Nếu tổng số sản phẩm cần nhập thực tế lớn hơn số dòng hiển thị (20 dòng)
  if (totalLowStock !== null && totalLowStock > products.length && tableContainer) {
    const noteDiv = document.createElement('div');
    noteDiv.id = 'low-stock-more-note';
    noteDiv.className = 'text-center py-2 bg-light border-top small text-muted';
    noteDiv.innerHTML = `Hiển thị ${products.length} / <strong>${totalLowStock}</strong> sản phẩm cần nhập. <a href="/inventory" class="fw-semibold">Xem toàn bộ trong Quản lý Tồn kho &raquo;</a>`;
    tableContainer.appendChild(noteDiv);
  }
}

function renderRecentInvoices(invoices) {
  const tableContainer = document.getElementById('recent-invoices-table-container');
  const emptyEl = document.getElementById('recent-invoices-empty');
  const tbody = document.getElementById('recent-invoices-tbody');

  if (!invoices || invoices.length === 0) {
    if (tableContainer) tableContainer.classList.add('d-none');
    if (emptyEl) emptyEl.classList.remove('d-none');
    return;
  }

  if (emptyEl) emptyEl.classList.add('d-none');
  if (tableContainer) tableContainer.classList.remove('d-none');
  if (!tbody) return;

  tbody.innerHTML = '';
  invoices.forEach((inv, idx) => {
    const tr = document.createElement('tr');
    const dateStr = formatDateTimeVN(inv.created_at);
    const amountStr = formatMoney(inv.total_amount);

    tr.innerHTML = `
      <td class="text-center text-muted">${idx + 1}</td>
      <td>
        <span class="font-monospace text-primary fw-semibold">${escapeHtml(inv.invoice_no)}</span>
      </td>
      <td>
        <small class="text-dark">${escapeHtml(inv.created_by_name || 'Thu ngân')}</small>
      </td>
      <td class="text-end fw-bold text-danger">${amountStr}</td>
      <td>
        <small class="text-muted"><i class="bi bi-clock me-1"></i>${dateStr}</small>
      </td>
      <td class="text-center">
        <button type="button" class="btn btn-outline-info btn-sm py-0 px-2" onclick="viewInvoiceDetail(${inv.id})" title="Xem chi tiết hóa đơn ${escapeHtml(inv.invoice_no)}">
          <i class="bi bi-eye"></i> Xem
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// ----------------------------------------------------------------------------
// MODAL CHI TIẾT HÓA ĐƠN
// ----------------------------------------------------------------------------
function openInvoiceModal() {
  const modalEl = document.getElementById('invoice-detail-modal');
  if (modalEl) {
    modalEl.classList.add('show');
    modalEl.style.display = 'block';
  }
}

function closeInvoiceModal() {
  const modalEl = document.getElementById('invoice-detail-modal');
  if (modalEl) {
    modalEl.classList.remove('show');
    modalEl.style.display = 'none';
  }
}

async function viewInvoiceDetail(id) {
  const loadingEl = document.getElementById('modal-invoice-loading');
  const errorEl = document.getElementById('modal-invoice-error');
  const contentEl = document.getElementById('modal-invoice-content');

  if (loadingEl) loadingEl.classList.remove('d-none');
  if (errorEl) errorEl.classList.add('d-none');
  if (contentEl) contentEl.classList.add('d-none');

  openInvoiceModal();

  try {
    const res = await window.apiFetch('/api/invoices/' + id);
    if (!res || !res.ok) throw new Error('Không thể tải chi tiết hóa đơn');

    const data = await res.json();
    const inv = data.invoice;
    const items = data.items || [];

    if (!inv) throw new Error('Hóa đơn không tồn tại');

    document.getElementById('m-inv-no').textContent = inv.invoice_no || 'N/A';
    document.getElementById('m-inv-date').textContent = formatDateTimeVN(inv.created_at);
    document.getElementById('m-inv-creator').textContent = inv.created_by_name || 'Thu ngân';
    document.getElementById('m-inv-total').textContent = formatMoney(inv.total_amount);

    const fullLink = document.getElementById('btn-full-invoice-link');
    if (fullLink) fullLink.href = `/invoices`;

    const itemsTbody = document.getElementById('m-inv-items-tbody');
    if (itemsTbody) {
      itemsTbody.innerHTML = '';
      items.forEach((item, idx) => {
        const tr = document.createElement('tr');
        const lineTotal = Number(item.quantity) * Number(item.unit_price);
        tr.innerHTML = `
          <td class="text-center text-muted">${idx + 1}</td>
          <td><span class="badge bg-secondary font-monospace">${escapeHtml(item.sku || 'N/A')}</span></td>
          <td class="fw-semibold text-dark">${escapeHtml(item.product_name_snapshot || 'Sản phẩm')}</td>
          <td class="text-center text-muted">${escapeHtml(item.unit_snapshot || 'Cái')}</td>
          <td class="text-center fw-bold text-primary">${item.quantity}</td>
          <td class="text-end">${formatMoney(item.unit_price)}</td>
          <td class="text-end fw-bold text-danger">${formatMoney(lineTotal)}</td>
        `;
        itemsTbody.appendChild(tr);
      });
    }

    if (loadingEl) loadingEl.classList.add('d-none');
    if (contentEl) contentEl.classList.remove('d-none');

  } catch (err) {
    console.error('Lỗi chi tiết hóa đơn:', err);
    if (loadingEl) loadingEl.classList.add('d-none');
    if (errorEl) {
      errorEl.textContent = err.message || 'Không thể tải chi tiết hóa đơn';
      errorEl.classList.remove('d-none');
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadDashboard();

  window.addEventListener('click', (e) => {
    const modalEl = document.getElementById('invoice-detail-modal');
    if (e.target === modalEl) closeInvoiceModal();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeInvoiceModal();
  });
});
