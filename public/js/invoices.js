/**
 * ==============================================================================
 * DỰ ÁN POS STORE - GIAO DIỆN QUẢN LÝ HÓA ĐƠN & IN ẤN (INVOICES FRONTEND)
 * ==============================================================================
 * Tệp: public/js/invoices.js
 * Mục đích:
 *   - Điều khiển tương tác trang Danh sách hóa đơn bán lẻ (views/invoices.html).
 *   - Các tính năng chính:
 *       1. Tải danh sách hóa đơn phân trang (mặc định 10 dòng/trang).
 *       2. Tìm kiếm theo mã hóa đơn, lọc theo khoảng ngày tạo (từ ngày - đến ngày).
 *       3. Lọc theo nhân viên bán hàng (chỉ hiển thị dropdown lọc cho Quản lý).
 *       4. Mở modal xem chi tiết hóa đơn (snapshot tên, đơn vị, giá bán tại thời điểm lập).
 *       5. Hỗ trợ in hóa đơn nhiệt / lưu PDF bằng giao diện in chuyên biệt (@media print).
 *       6. Phân biệt rõ hình thức thanh toán: Tiền mặt hoặc Chuyển khoản VietQR kèm nội dung chuyển khoản.
 * ==============================================================================
 */

let invoiceModalInstance = null;
let currentLoadedInvoice = null;
let currentUser = null;
let currentPage = 1;
const pageSize = 10;
let totalPages = 1;

function openInvoiceModal() {
  const modalEl = document.getElementById('invoice-modal');
  if (!modalEl) return;

  if (window.bootstrap && window.bootstrap.Modal) {
    if (!invoiceModalInstance) {
      invoiceModalInstance = new window.bootstrap.Modal(modalEl, { backdrop: true, keyboard: true });
    }
    invoiceModalInstance.show();
  } else {
    // Dự phòng khi không có Bootstrap JS
    modalEl.style.display = 'block';
    modalEl.classList.add('show');
    modalEl.removeAttribute('aria-hidden');
    modalEl.setAttribute('aria-modal', 'true');
    const backdrop = document.getElementById('modal-backdrop');
    if (backdrop) {
      backdrop.style.display = 'block';
      backdrop.classList.add('show');
    }
    document.body.classList.add('modal-open');
  }
}

function closeInvoiceModal() {
  const modalEl = document.getElementById('invoice-modal');
  if (invoiceModalInstance) {
    invoiceModalInstance.hide();
  }
  if (modalEl) {
    modalEl.classList.remove('show');
    modalEl.style.display = 'none';
    modalEl.setAttribute('aria-hidden', 'true');
    modalEl.removeAttribute('aria-modal');
  }
  const backdrop = document.getElementById('modal-backdrop');
  if (backdrop) {
    backdrop.classList.remove('show');
    backdrop.style.display = 'none';
  }
  document.body.classList.remove('modal-open');
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

// Định dạng ngày giờ theo đúng múi giờ Asia/Ho_Chi_Minh
function formatDateTimeVN(dateVal) {
  if (!dateVal) return 'Không rõ';
  const d = new Date(dateVal);
  if (isNaN(d.getTime())) return 'Không rõ';
  return d.toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
}

// Hàm in hóa đơn / Lưu dưới dạng PDF
function printInvoice() {
  // Chỉ gọi window.print() khi nội dung và dữ liệu hóa đơn đã tải xong và sẵn sàng
  if (!currentLoadedInvoice || !currentLoadedInvoice.invoice) {
    alert('Dữ liệu hóa đơn chưa sẵn sàng để in. Vui lòng chờ tải xong.');
    return;
  }

  const printSection = document.getElementById('invoice-print-section');
  if (!printSection || !printSection.innerHTML.trim()) {
    alert('Không tìm thấy nội dung hóa đơn trong vùng in.');
    return;
  }

  // Kích hoạt hộp thoại in / Lưu dưới dạng PDF của trình duyệt
  window.print();
}

// Tạo mã HTML hóa đơn hoàn chỉnh dùng chung cho cả xem trước và in ấn (lấy dữ liệu snapshot đã lưu)
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

// Khởi tạo thông tin người dùng và bộ lọc theo vai trò
async function initUserAndRole() {
  try {
    const res = await window.apiFetch('/api/auth/me');
    if (res && res.ok) {
      currentUser = await res.json();
      
      const pageTitle = document.getElementById('invoices-page-title');
      const listTitle = document.getElementById('invoices-list-title');
      const sellerContainer = document.getElementById('seller-filter-container');

      if (currentUser.role === 'MANAGER') {
        if (pageTitle) pageTitle.textContent = 'QUẢN LÝ HÓA ĐƠN';
        if (listTitle) listTitle.textContent = 'Danh Sách Hóa Đơn (Toàn Bộ)';
        if (sellerContainer) sellerContainer.style.display = 'block';

        // Tải danh sách người bán cho Quản lý
        loadSellersDropdown();
      } else {
        // CASHIER
        if (pageTitle) pageTitle.textContent = 'HÓA ĐƠN CỦA TÔI';
        if (listTitle) listTitle.textContent = 'Danh Sách Hóa Đơn Của Tôi';
        if (sellerContainer) sellerContainer.style.display = 'none';
      }
    }
  } catch (e) {
    console.error('Lỗi lấy thông tin người dùng:', e);
  }
}

// Tải danh sách người bán vào dropdown cho Quản lý
async function loadSellersDropdown() {
  try {
    const res = await window.apiFetch('/api/invoices/sellers');
    if (!res || !res.ok) return;
    const sellers = await res.json();
    const select = document.getElementById('filter-seller');
    if (!select) return;

    select.innerHTML = '<option value="">-- Tất cả người bán --</option>';
    sellers.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      const roleText = s.role === 'MANAGER' ? 'Quản lý' : 'Thu ngân';
      opt.textContent = `${s.full_name} (${s.username} - ${roleText})`;
      select.appendChild(opt);
    });
  } catch (err) {
    console.error('Lỗi tải danh sách người bán:', err);
  }
}

// Hiển thị thông báo lỗi bộ lọc
function showFilterError(message) {
  const alertEl = document.getElementById('filter-error-alert');
  const textEl = document.getElementById('filter-error-text');
  if (alertEl && textEl) {
    textEl.textContent = message;
    alertEl.style.display = 'flex';
  }
}

// Xóa thông báo lỗi bộ lọc
function clearFilterError() {
  const alertEl = document.getElementById('filter-error-alert');
  const textEl = document.getElementById('filter-error-text');
  if (alertEl && textEl) {
    textEl.textContent = '';
    alertEl.style.display = 'none';
  }
}

// Áp dụng bộ lọc
function applyFilter() {
  const fromDate = document.getElementById('filter-from-date')?.value?.trim() || '';
  const toDate = document.getElementById('filter-to-date')?.value?.trim() || '';

  // Kiểm tra frontend: Từ ngày không được lớn hơn Đến ngày
  if (fromDate && toDate && fromDate > toDate) {
    showFilterError('Từ ngày không được lớn hơn Đến ngày.');
    // Giữ nguyên các giá trị người dùng nhập để họ sửa; không thay danh sách hiện tại bằng kết quả trống
    return;
  }

  // Xóa thông báo lỗi cũ khi lọc lại với ngày hợp lệ
  clearFilterError();

  currentPage = 1;
  loadInvoices(1);
}

// Đặt lại bộ lọc
function resetFilter() {
  clearFilterError();

  const invoiceNoInput = document.getElementById('filter-invoice-no');
  const fromDateInput = document.getElementById('filter-from-date');
  const toDateInput = document.getElementById('filter-to-date');
  const sellerSelect = document.getElementById('filter-seller');

  if (invoiceNoInput) invoiceNoInput.value = '';
  if (fromDateInput) fromDateInput.value = '';
  if (toDateInput) toDateInput.value = '';
  if (sellerSelect) sellerSelect.value = '';

  currentPage = 1;
  loadInvoices(1);
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

// Tải danh sách hóa đơn từ server có phân trang và bộ lọc
async function loadInvoices(page = 1) {
  currentPage = page;

  const invoiceNo = document.getElementById('filter-invoice-no')?.value?.trim() || '';
  const fromDate = document.getElementById('filter-from-date')?.value?.trim() || '';
  const toDate = document.getElementById('filter-to-date')?.value?.trim() || '';
  const sellerId = document.getElementById('filter-seller')?.value || '';

  // Kiểm tra ngày hợp lệ theo lịch thực tế và chặn from_date > to_date
  if (fromDate && !isValidCalendarDate(fromDate)) {
    showFilterError('Từ ngày không hợp lệ hoặc không tồn tại trên lịch.');
    return;
  }
  if (toDate && !isValidCalendarDate(toDate)) {
    showFilterError('Đến ngày không hợp lệ hoặc không tồn tại trên lịch.');
    return;
  }
  if (fromDate && toDate && fromDate > toDate) {
    showFilterError('Từ ngày không được lớn hơn Đến ngày.');
    return;
  }

  const tbody = document.querySelector('#invoices-table tbody');
  const countInfo = document.getElementById('invoices-count-info');
  const paginationEl = document.getElementById('invoices-pagination');

  const previousTbodyHtml = tbody ? tbody.innerHTML : '';
  const previousCountInfo = countInfo ? countInfo.textContent : '';

  const params = new URLSearchParams();
  params.append('page', currentPage);
  params.append('limit', pageSize);
  params.append('paginate', 'true');

  if (invoiceNo) params.append('q', invoiceNo);
  if (fromDate) params.append('from_date', fromDate);
  if (toDate) params.append('to_date', toDate);
  if (sellerId && currentUser && currentUser.role === 'MANAGER') {
    params.append('seller_id', sellerId);
  }

  // Hiển thị trạng thái đang tải nếu danh sách ban đầu đang trống
  if (tbody && !previousTbodyHtml.trim()) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="text-center py-4 text-muted">
          <div class="spinner-border spinner-border-sm text-primary me-2" role="status"></div>
          Đang tải danh sách hóa đơn...
        </td>
      </tr>
    `;
  }

  try {
    const res = await window.apiFetch('/api/invoices?' + params.toString());
    if (!res || !res.ok) {
      let errMsg = 'Không thể tải dữ liệu hóa đơn';
      try {
        const errJson = await res.json();
        if (errJson && errJson.error) errMsg = errJson.error;
      } catch (e) {}
      showFilterError(errMsg);
      // Giữ nguyên danh sách hiện tại nếu gặp lỗi nhập liệu hoặc lỗi backend
      if (tbody && previousTbodyHtml.trim()) {
        tbody.innerHTML = previousTbodyHtml;
      }
      if (countInfo && previousCountInfo.trim()) {
        countInfo.textContent = previousCountInfo;
      }
      return;
    }

    // Nếu tải thành công, xóa thông báo lỗi
    clearFilterError();

    const data = await res.json();
    let invoices = [];
    let total = 0;

    if (Array.isArray(data)) {
      invoices = data;
      total = data.length;
      totalPages = 1;
    } else {
      invoices = data.invoices || [];
      total = Number(data.total || 0);
      totalPages = Number(data.totalPages || 0);
    }

    if (!tbody) return;
    tbody.innerHTML = '';

    // Thông báo khi không có kết quả
    if (invoices.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" class="text-center text-muted py-5">
            <div class="d-flex flex-column align-items-center">
              <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" fill="currentColor" class="bi bi-inbox text-secondary mb-2" viewBox="0 0 16 16">
                <path d="M4.98 4a.5.5 0 0 0-.39.188L1.54 8H6a.5.5 0 0 1 .5.5 1.5 1.5 0 1 0 3 0A.5.5 0 0 1 10 8h4.46l-3.05-3.812A.5.5 0 0 0 11.02 4H4.98zm-1.17-.437A1.5 1.5 0 0 1 4.98 3h6.04a1.5 1.5 0 0 1 1.17.563l3.7 4.625a1 1 0 0 1 .11.45V13a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V8.638a1 1 0 0 1 .11-.45l3.7-4.625zM1 9.5v3.5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5h-3.72a2.5 2.5 0 0 1-4.56 0H1z"/>
              </svg>
              <h6 class="fw-bold mb-1">Không tìm thấy hóa đơn nào</h6>
              <p class="small text-muted mb-0">Không có hóa đơn phù hợp với điều kiện lọc hoặc chưa có dữ liệu.</p>
            </div>
          </td>
        </tr>
      `;
      if (countInfo) countInfo.textContent = 'Hiển thị 0 hóa đơn';
      if (paginationEl) paginationEl.innerHTML = '';
      return;
    }

    // Hiển thị danh sách hóa đơn
    invoices.forEach(inv => {
      const tr = document.createElement('tr');
      const dateStr = formatDateTimeVN(inv.created_at);
      const amountStr = Number(inv.total_amount).toLocaleString('vi-VN') + ' đ';

      let pmBadge = '<span class="badge bg-secondary">Chưa ghi nhận</span>';
      if (inv.payment_method === 'CASH') {
        pmBadge = '<span class="badge bg-success">Tiền mặt</span>';
      } else if (inv.payment_method === 'BANK_TRANSFER') {
        const escapedContent = escapeHtml(inv.transfer_content || '');
        const tooltip = escapedContent ? `Nội dung: ${escapedContent}` : 'Chuyển khoản QR';
        pmBadge = `<span class="badge bg-info text-dark" title="${tooltip}">Chuyển khoản QR</span>`;
      }

      tr.innerHTML = `
        <td class="text-center">${inv.id}</td>
        <td class="fw-bold text-primary font-monospace">${inv.invoice_no}</td>
        <td class="text-end fw-bold text-dark font-monospace">${amountStr}</td>
        <td class="text-center">${pmBadge}</td>
        <td>${dateStr}</td>
        <td>${inv.created_by_name || 'Hệ thống'}</td>
        <td class="text-center">
          <button type="button" class="btn btn-sm btn-outline-primary" onclick="viewDetails(${inv.id})">
            <i class="bi bi-eye me-1"></i>Chi tiết
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    // Cập nhật thông tin số lượng
    const startIdx = (currentPage - 1) * pageSize + 1;
    const endIdx = Math.min(total, currentPage * pageSize);
    if (countInfo) {
      countInfo.textContent = `Hiển thị ${startIdx} - ${endIdx} trên tổng số ${total} hóa đơn (Trang ${currentPage} / ${totalPages || 1})`;
    }

    // Render các nút phân trang
    renderPagination(paginationEl, totalPages, currentPage);

  } catch (err) {
    console.error('Lỗi tải danh sách hóa đơn:', err);
    if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="text-center text-danger py-4">Lỗi kết nối khi tải danh sách hóa đơn</td></tr>';
  }
}

// Render các nút điều hướng phân trang
function renderPagination(container, totalPg, currentPg) {
  if (!container) return;
  container.innerHTML = '';

  if (totalPg <= 1) return;

  // Nút Trước
  const prevLi = document.createElement('li');
  prevLi.className = `page-item ${currentPg <= 1 ? 'disabled' : ''}`;
  prevLi.innerHTML = `<button type="button" class="page-link" aria-label="Trang trước" ${currentPg <= 1 ? 'disabled' : ''}>&laquo;</button>`;
  if (currentPg > 1) {
    prevLi.addEventListener('click', () => loadInvoices(currentPg - 1));
  }
  container.appendChild(prevLi);

  // Danh sách các số trang
  for (let i = 1; i <= totalPg; i++) {
    // Chỉ hiển thị các trang gần trang hiện tại nếu có quá nhiều trang
    if (totalPg > 7 && Math.abs(i - currentPg) > 2 && i !== 1 && i !== totalPg) {
      if (i === 2 || i === totalPg - 1) {
        const dotsLi = document.createElement('li');
        dotsLi.className = 'page-item disabled';
        dotsLi.innerHTML = '<span class="page-link">...</span>';
        container.appendChild(dotsLi);
      }
      continue;
    }

    const pageLi = document.createElement('li');
    pageLi.className = `page-item ${i === currentPg ? 'active' : ''}`;
    pageLi.innerHTML = `<button type="button" class="page-link">${i}</button>`;
    if (i !== currentPg) {
      pageLi.addEventListener('click', () => loadInvoices(i));
    }
    container.appendChild(pageLi);
  }

  // Nút Sau
  const nextLi = document.createElement('li');
  nextLi.className = `page-item ${currentPg >= totalPg ? 'disabled' : ''}`;
  nextLi.innerHTML = `<button type="button" class="page-link" aria-label="Trang sau" ${currentPg >= totalPg ? 'disabled' : ''}>&raquo;</button>`;
  if (currentPg < totalPg) {
    nextLi.addEventListener('click', () => loadInvoices(currentPg + 1));
  }
  container.appendChild(nextLi);
}

// Xem chi tiết hóa đơn (kiểm tra phân quyền tại backend)
async function viewDetails(id) {
  const modalTitle = document.getElementById('invoice-modal-title');
  const previewArea = document.getElementById('invoice-preview-area');
  const printSection = document.getElementById('invoice-print-section');

  if (!id) {
    alert('ID hóa đơn không hợp lệ');
    return;
  }

  // Đặt lại dữ liệu hiện tại khi đang tải
  currentLoadedInvoice = null;
  if (printSection) printSection.innerHTML = '';

  // Hiển thị trạng thái đang tải trên modal
  if (modalTitle) modalTitle.textContent = `Chi Tiết Hóa Đơn #${id}`;
  if (previewArea) {
    previewArea.innerHTML = `
      <div class="text-center py-4">
        <div class="spinner-border text-primary" role="status">
          <span class="visually-hidden">Đang tải...</span>
        </div>
        <p class="mt-2 text-muted mb-0">Đang tải thông tin chi tiết hóa đơn...</p>
      </div>
    `;
  }
  openInvoiceModal();

  try {
    const res = await window.apiFetch('/api/invoices/' + id);
    if (!res || !res.ok) {
      let errMsg = `Không thể tải chi tiết hóa đơn (Mã lỗi: ${res ? res.status : 'Mất kết nối'})`;
      try {
        const errJson = await res.json();
        errMsg = window.formatApiError(errJson, errMsg);
      } catch (e) {}
      if (previewArea) {
        previewArea.innerHTML = `<div class="alert alert-danger mb-0">${escapeHtml(errMsg)}</div>`;
      }
      alert(errMsg);
      return;
    }

    const data = await res.json();
    const inv = data.invoice;
    const items = data.items || [];

    if (!inv) {
      const errMsg = 'Không tìm thấy dữ liệu hóa đơn';
      if (previewArea) previewArea.innerHTML = `<div class="alert alert-danger mb-0">${errMsg}</div>`;
      alert(errMsg);
      return;
    }

    if (modalTitle) {
      modalTitle.textContent = `Hóa Đơn: ${inv.invoice_no}`;
    }

    // Lưu dữ liệu đã sẵn sàng
    currentLoadedInvoice = data;

    // Render nội dung hóa đơn (giữ nguyên snapshot tên, sku, đơn vị, giá tại thời điểm bán)
    const receiptHtml = renderReceiptHtml(inv, items);

    // Cập nhật cả vùng xem trước trong modal và vùng in riêng độc lập trực thuộc body
    if (previewArea) {
      previewArea.innerHTML = receiptHtml;
    }
    if (printSection) {
      printSection.innerHTML = receiptHtml;
    }

  } catch (err) {
    console.error('Lỗi khi tải chi tiết hóa đơn:', err);
    const errMsg = 'Lỗi kết nối khi tải chi tiết hóa đơn. Vui lòng thử lại.';
    if (previewArea) {
      previewArea.innerHTML = `<div class="alert alert-danger mb-0">${errMsg}</div>`;
    }
    alert(errMsg);
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  await initUserAndRole();
  await loadInvoices(1);
});