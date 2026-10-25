/**
 * ==============================================================================
 * DỰ ÁN POS STORE - GIAO DIỆN QUẢN LÝ NHÂN VIÊN (EMPLOYEES FRONTEND)
 * ==============================================================================
 * Tệp: public/js/employees.js
 * Mục đích:
 *   - Điều khiển tương tác trên trang Quản lý nhân viên (views/employees.html).
 *   - Các chức năng:
 *       1. Tải và hiển thị danh sách tài khoản, tìm kiếm theo tên, lọc theo trạng thái hoạt động.
 *       2. Tạo mới tài khoản (Thu ngân / Quản lý) với mật khẩu tối thiểu 8 ký tự.
 *       3. Chỉnh sửa thông tin nhân viên, khóa/mở khóa tài khoản (toggle active).
 *       4. Đặt lại mật khẩu nhân viên, xóa tài khoản (chỉ khi chưa có chứng từ phát sinh).
 *   - Tự động nhận diện và bảo vệ tài khoản hệ thống (ẩn các nút khóa, sửa, xóa khi `is_system === true`).
 * ==============================================================================
 */

let allEmployees = [];
let tableDropdownInstances = [];

function closeModal(id) {
  const modalEl = typeof id === 'string' ? document.getElementById(id) : id;
  if (!modalEl) return;
  if (typeof bootstrap !== 'undefined' && bootstrap.Modal) {
    const instance = bootstrap.Modal.getOrCreateInstance(modalEl);
    if (instance._isTransitioning) {
      modalEl.addEventListener('shown.bs.modal', () => {
        try { instance.hide(); } catch (e) {}
      }, { once: true });
      return;
    }
    instance.hide();
  } else {
    modalEl.style.display = 'none';
  }
}

function showModal(id) {
  const modalEl = typeof id === 'string' ? document.getElementById(id) : id;
  if (!modalEl) return;
  if (typeof bootstrap !== 'undefined' && bootstrap.Modal) {
    const instance = bootstrap.Modal.getOrCreateInstance(modalEl);
    if (instance._isTransitioning) {
      modalEl.addEventListener('hidden.bs.modal', () => {
        try { instance.show(); } catch (e) {}
      }, { once: true });
      return;
    }
    instance.show();
  } else {
    modalEl.style.display = 'block';
  }
}

// Dọn dẹp các Bootstrap Dropdown cũ trong bảng để giải phóng bộ nhớ và tránh lỗi Popper
function disposeTableDropdowns() {
  if (Array.isArray(tableDropdownInstances)) {
    tableDropdownInstances.forEach(instance => {
      try {
        if (instance && typeof instance.dispose === 'function') {
          instance.dispose();
        }
      } catch (err) {}
    });
  }
  tableDropdownInstances = [];

  const toggles = document.querySelectorAll('#employees-table [data-bs-toggle="dropdown"]');
  toggles.forEach(btn => {
    try {
      if (typeof bootstrap !== 'undefined' && bootstrap.Dropdown) {
        const inst = bootstrap.Dropdown.getInstance(btn);
        if (inst && typeof inst.dispose === 'function') {
          inst.dispose();
        }
      }
    } catch (e) {}
  });
}

// Khởi tạo Bootstrap Dropdown với Popper strategy fixed và boundary viewport để không bị cắt trong .table-responsive
function initTableDropdowns() {
  disposeTableDropdowns();
  if (typeof bootstrap === 'undefined' || !bootstrap.Dropdown) return;

  const toggles = document.querySelectorAll('#employees-table [data-bs-toggle="dropdown"]');
  toggles.forEach(btn => {
    try {
      const instance = new bootstrap.Dropdown(btn, {
        boundary: 'viewport',
        popperConfig: function(defaultConfig) {
          const cfg = (typeof defaultConfig === 'object' && defaultConfig) ? { ...defaultConfig } : {};
          cfg.strategy = 'fixed';
          return cfg;
        }
      });
      tableDropdownInstances.push(instance);
    } catch (err) {
      console.warn('Lỗi khởi tạo dropdown:', err);
    }
  });
}

// 1. Mở Modal Thêm Thu Ngân Mới
function showAddEmployeeModal() {
  document.getElementById('add-e-username').value = '';
  document.getElementById('add-e-fullname').value = '';
  document.getElementById('add-e-role').value = 'CASHIER';
  document.getElementById('add-e-password').value = '';
  document.getElementById('add-e-confirm-password').value = '';
  
  const errDiv = document.getElementById('add-e-error');
  if (errDiv) {
    errDiv.textContent = '';
    errDiv.classList.add('d-none');
  }

  showModal('add-employee-modal');
}

// 2. Mở Modal Sửa Nhân Viên
function showEditEmployeeModal(id) {
  const emp = allEmployees.find(x => x.id === id);
  if (!emp) return;
  // Chặn mở form sửa đối với tài khoản hệ thống
  if (emp.is_system || (emp.username && emp.username.toLowerCase() === 'manager')) {
    return;
  }

  document.getElementById('edit-e-id').value = emp.id;
  document.getElementById('edit-e-username').value = emp.username;
  document.getElementById('edit-e-fullname').value = emp.full_name;
  document.getElementById('edit-e-role').value = emp.role;

  const errDiv = document.getElementById('edit-e-error');
  if (errDiv) {
    errDiv.textContent = '';
    errDiv.classList.add('d-none');
  }

  showModal('edit-employee-modal');
}

// 3. Mở Modal Đặt Lại Mật Khẩu
function showResetPassModal(id) {
  const emp = allEmployees.find(x => x.id === id);
  if (!emp) return;
  // Chặn mở form đặt lại mật khẩu đối với tài khoản hệ thống
  if (emp.is_system || (emp.username && emp.username.toLowerCase() === 'manager')) {
    return;
  }

  document.getElementById('rp-id').value = emp.id;
  document.getElementById('rp-username').textContent = `${emp.full_name} (${emp.username})`;
  document.getElementById('rp-password').value = '';
  document.getElementById('rp-confirm-password').value = '';

  const errDiv = document.getElementById('rp-error');
  if (errDiv) {
    errDiv.textContent = '';
    errDiv.classList.add('d-none');
  }

  showModal('reset-pass-modal');
}

// 4. Tải danh sách nhân viên từ API
async function loadEmployees() {
  try {
    const res = await window.apiFetch('/api/employees');
    if (!res || !res.ok) {
      let data = {};
      try { data = await res.json(); } catch (e) {}
      alert(window.formatApiError(data, 'Không thể tải danh sách tài khoản nhân viên'));
      return;
    }
    const data = await res.json();
    allEmployees = data;
    filterAndRenderEmployees();
  } catch (err) {
    console.error('Lỗi tải nhân viên:', err);
  }
}

// 5. Lọc và hiển thị danh sách
function filterAndRenderEmployees() {
  const searchInput = (document.getElementById('search-employees')?.value || '').trim().toLowerCase();
  const statusFilter = document.getElementById('filter-status')?.value || 'all';

  const filtered = allEmployees.filter(emp => {
    // Lọc theo tìm kiếm (tên đăng nhập hoặc họ tên)
    const matchSearch = !searchInput ||
      (emp.username && emp.username.toLowerCase().includes(searchInput)) ||
      (emp.full_name && emp.full_name.toLowerCase().includes(searchInput));

    // Lọc theo trạng thái
    let matchStatus = true;
    if (statusFilter === 'active') matchStatus = (emp.is_active === 1 || emp.is_active === true);
    else if (statusFilter === 'locked') matchStatus = (emp.is_active === 0 || emp.is_active === false);

    return matchSearch && matchStatus;
  });

  renderEmployeeTable(filtered);
}

// 6. Render dữ liệu ra bảng
function renderEmployeeTable(employees) {
  disposeTableDropdowns();

  const tbody = document.querySelector('#employees-table tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (employees.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center py-4 text-muted">Không tìm thấy tài khoản nhân viên nào phù hợp</td></tr>`;
    return;
  }

  employees.forEach(e => {
    const tr = document.createElement('tr');

    const roleBadge = e.role === 'MANAGER'
      ? `<span class="badge bg-primary">Quản lý</span>`
      : `<span class="badge bg-success">Thu ngân</span>`;

    const statusBadge = e.is_active
      ? `<span class="badge bg-success">Hoạt động</span>`
      : `<span class="badge bg-secondary">Đã khóa</span>`;

    const lockActionLabel = e.is_active ? 'Khóa tài khoản' : 'Mở khóa tài khoản';
    const lockActionIcon = e.is_active ? 'bi-lock me-2 text-warning' : 'bi-unlock me-2 text-success';
    const nextStatus = !e.is_active;

    const isSystem = Boolean(e.is_system || (e.username && e.username.toLowerCase() === 'manager'));

    const actionCellHtml = isSystem
      ? `<span class="badge bg-light text-secondary border fw-normal py-1 px-2"><i class="bi bi-shield-lock text-primary me-1"></i>Tài khoản hệ thống — được bảo vệ</span>`
      : `
        <div class="d-flex justify-content-end align-items-center gap-1">
          <button class="btn btn-sm btn-outline-primary" onclick="showEditEmployeeModal(${e.id})" title="Sửa thông tin nhân viên">
            <i class="bi bi-pencil me-1"></i>Sửa
          </button>
          <div class="dropdown">
            <button class="btn btn-sm btn-outline-secondary dropdown-toggle" type="button" data-bs-toggle="dropdown" data-bs-boundary="viewport" aria-expanded="false" title="Thao tác khác">
              Thao tác
            </button>
            <ul class="dropdown-menu dropdown-menu-end shadow-sm">
              <li>
                <button class="dropdown-item py-2" type="button" onclick="showResetPassModal(${e.id})">
                  <i class="bi bi-key me-2 text-warning"></i>Đặt lại mật khẩu
                </button>
              </li>
              <li>
                <button class="dropdown-item py-2" type="button" onclick="toggleLock(${e.id}, ${nextStatus}, '${escapeHtml(e.username)}')">
                  <i class="bi ${lockActionIcon}"></i>${lockActionLabel}
                </button>
              </li>
              <li><hr class="dropdown-divider my-1"></li>
              <li>
                <button class="dropdown-item py-2 text-danger" type="button" onclick="deleteEmployee(${e.id}, '${escapeHtml(e.username)}')">
                  <i class="bi bi-trash me-2"></i>Xóa tài khoản
                </button>
              </li>
            </ul>
          </div>
        </div>
      `;

    tr.innerHTML = `
      <td class="ps-3 fw-semibold font-monospace">${escapeHtml(e.username)}</td>
      <td class="fw-medium">${escapeHtml(e.full_name)}</td>
      <td>${roleBadge}</td>
      <td>${statusBadge}</td>
      <td class="text-end pe-3">
        ${actionCellHtml}
      </td>
    `;
    tbody.appendChild(tr);
  });

  initTableDropdowns();
}

// 7. Gửi form Thêm Thu Ngân
async function submitAddEmployee() {
  const username = document.getElementById('add-e-username').value.trim();
  const full_name = document.getElementById('add-e-fullname').value.trim();
  const role = document.getElementById('add-e-role').value;
  const password = document.getElementById('add-e-password').value;
  const confirm_password = document.getElementById('add-e-confirm-password').value;

  const errDiv = document.getElementById('add-e-error');
  errDiv.classList.add('d-none');
  errDiv.textContent = '';

  if (!username || !full_name || !password) {
    errDiv.textContent = 'Vui lòng điền đầy đủ tên đăng nhập, họ tên và mật khẩu.';
    errDiv.classList.remove('d-none');
    return;
  }

  if (password.length < 8) {
    errDiv.textContent = 'Mật khẩu phải có ít nhất 8 ký tự.';
    errDiv.classList.remove('d-none');
    return;
  }

  if (password !== confirm_password) {
    errDiv.textContent = 'Mật khẩu xác nhận không khớp.';
    errDiv.classList.remove('d-none');
    return;
  }

  const payload = { username, full_name, role, password, confirm_password };

  const btn = document.getElementById('btn-save-new-employee');
  if (btn) btn.disabled = true;

  try {
    const res = await window.apiFetch('/api/employees', {
      method: 'POST',
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (res && res.ok) {
      closeModal('add-employee-modal');
      await loadEmployees();
    } else {
      errDiv.textContent = window.formatApiError(data, 'Lỗi tạo tài khoản nhân viên.');
      errDiv.classList.remove('d-none');
    }
  } catch (err) {
    errDiv.textContent = 'Lỗi kết nối máy chủ.';
    errDiv.classList.remove('d-none');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// 8. Gửi form Sửa Nhân Viên
async function submitEditEmployee() {
  const id = Number(document.getElementById('edit-e-id').value);
  const emp = allEmployees.find(x => x.id === id);
  if (emp && (emp.is_system || (emp.username && emp.username.toLowerCase() === 'manager'))) {
    closeModal('edit-employee-modal');
    return;
  }
  const full_name = document.getElementById('edit-e-fullname').value.trim();
  const role = document.getElementById('edit-e-role').value;

  const errDiv = document.getElementById('edit-e-error');
  errDiv.classList.add('d-none');
  errDiv.textContent = '';

  if (!full_name) {
    errDiv.textContent = 'Họ tên nhân viên không được để trống.';
    errDiv.classList.remove('d-none');
    return;
  }

  const payload = { full_name, role };
  const btn = document.getElementById('btn-save-edit-employee');
  if (btn) btn.disabled = true;

  try {
    const res = await window.apiFetch('/api/employees/' + id, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (res && res.ok) {
      closeModal('edit-employee-modal');
      await loadEmployees();
    } else {
      errDiv.textContent = window.formatApiError(data, 'Lỗi cập nhật tài khoản.');
      errDiv.classList.remove('d-none');
    }
  } catch (err) {
    errDiv.textContent = 'Lỗi kết nối máy chủ.';
    errDiv.classList.remove('d-none');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// 9. Gửi form Đặt Lại Mật Khẩu
async function submitResetPassword() {
  const id = Number(document.getElementById('rp-id').value);
  const emp = allEmployees.find(x => x.id === id);
  if (emp && (emp.is_system || (emp.username && emp.username.toLowerCase() === 'manager'))) {
    closeModal('reset-pass-modal');
    return;
  }
  const password = document.getElementById('rp-password').value;
  const confirm_password = document.getElementById('rp-confirm-password').value;

  const errDiv = document.getElementById('rp-error');
  errDiv.classList.add('d-none');
  errDiv.textContent = '';

  if (!password || password.length < 8) {
    errDiv.textContent = 'Mật khẩu mới phải có ít nhất 8 ký tự.';
    errDiv.classList.remove('d-none');
    return;
  }

  if (password !== confirm_password) {
    errDiv.textContent = 'Mật khẩu xác nhận không khớp.';
    errDiv.classList.remove('d-none');
    return;
  }

  const btn = document.getElementById('btn-save-reset-pass');
  if (btn) btn.disabled = true;

  try {
    const res = await window.apiFetch('/api/employees/' + id + '/reset-password', {
      method: 'PATCH',
      body: JSON.stringify({ password, confirm_password })
    });

    const data = await res.json();
    if (res && res.ok) {
      closeModal('reset-pass-modal');
      setTimeout(() => {
        alert('Đã đặt lại mật khẩu thành công.');
      }, 150);
    } else {
      errDiv.textContent = window.formatApiError(data, 'Lỗi đặt lại mật khẩu.');
      errDiv.classList.remove('d-none');
    }
  } catch (err) {
    errDiv.textContent = 'Lỗi kết nối máy chủ.';
    errDiv.classList.remove('d-none');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// 10. Khóa / Mở khóa tài khoản (có hộp thoại xác nhận)
async function toggleLock(id, nextStatus, username) {
  const emp = allEmployees.find(x => x.id === id);
  if (emp && (emp.is_system || (emp.username && emp.username.toLowerCase() === 'manager'))) {
    alert('Tài khoản quản trị hệ thống được bảo vệ, không thể thay đổi trạng thái.');
    return;
  }
  const actionText = nextStatus ? 'mở khóa' : 'khóa';
  const confirmed = confirm(`Bạn có chắc chắn muốn ${actionText} tài khoản "${username}" không?`);
  if (!confirmed) return;

  try {
    const res = await window.apiFetch('/api/employees/' + id + '/toggle-active', {
      method: 'PATCH',
      body: JSON.stringify({ is_active: nextStatus })
    });

    const data = await res.json();
    if (res && res.ok) {
      await loadEmployees();
    } else {
      alert(window.formatApiError(data, `Lỗi ${actionText} tài khoản`));
    }
  } catch (err) {
    alert('Lỗi kết nối máy chủ');
  }
}

// 11. Xóa tài khoản (có hộp thoại xác nhận và bảo vệ chứng từ)
async function deleteEmployee(id, username) {
  const emp = allEmployees.find(x => x.id === id);
  if (emp && (emp.is_system || (emp.username && emp.username.toLowerCase() === 'manager'))) {
    alert('Tài khoản quản trị hệ thống được bảo vệ, không thể xóa.');
    return;
  }
  const confirmed = confirm(`Bạn có chắc chắn muốn xóa tài khoản "${username}" không?\nLưu ý: Không thể xóa tài khoản đã có chứng từ (hóa đơn hoặc phiếu nhập).`);
  if (!confirmed) return;

  try {
    const res = await window.apiFetch('/api/employees/' + id, {
      method: 'DELETE'
    });

    const data = await res.json();
    if (res && res.ok) {
      alert('Xóa tài khoản thành công.');
      await loadEmployees();
    } else {
      alert(window.formatApiError(data, 'Lỗi xóa tài khoản'));
    }
  } catch (err) {
    alert('Lỗi kết nối máy chủ');
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/[&<>'"]/g, tag => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[tag] || tag));
}

// Khởi chạy khi tài liệu tải xong
document.addEventListener('DOMContentLoaded', () => {
  loadEmployees();

  // Bắt sự kiện tìm kiếm và lọc
  const searchInput = document.getElementById('search-employees');
  if (searchInput) {
    searchInput.addEventListener('input', filterAndRenderEmployees);
  }

  const statusFilter = document.getElementById('filter-status');
  if (statusFilter) {
    statusFilter.addEventListener('change', filterAndRenderEmployees);
  }

  // Lắng nghe sự kiện đóng modal để xóa thông báo lỗi cũ và đảm bảo không sót backdrop
  ['add-employee-modal', 'edit-employee-modal', 'reset-pass-modal'].forEach(modalId => {
    const modalEl = document.getElementById(modalId);
    if (modalEl) {
      modalEl.addEventListener('hidden.bs.modal', () => {
        const errDiv = modalEl.querySelector('.alert-danger');
        if (errDiv) {
          errDiv.textContent = '';
          errDiv.classList.add('d-none');
        }
        const activeModals = document.querySelectorAll('.modal.show');
        if (activeModals.length === 0) {
          document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
          document.body.classList.remove('modal-open');
          document.body.style.removeProperty('overflow');
          document.body.style.removeProperty('padding-right');
        }
      });
    }
  });
});