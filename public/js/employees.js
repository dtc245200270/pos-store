let allEmployees = [];

function closeModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.style.display = 'none';
}

function showModal(id) {
  const modal = document.getElementById(id);
  if (modal) modal.style.display = 'block';
}

// 1. Mở Modal Thêm Thu Ngân Mới
function showAddEmployeeModal() {
  document.getElementById('add-e-username').value = '';
  document.getElementById('add-e-fullname').value = '';
  document.getElementById('add-e-role').value = 'CASHIER';
  document.getElementById('add-e-password').value = '';
  document.getElementById('add-e-confirm-password').value = '';
  
  const errDiv = document.getElementById('add-e-error');
  errDiv.textContent = '';
  errDiv.classList.add('d-none');

  showModal('add-employee-modal');
}

// 2. Mở Modal Sửa Nhân Viên
function showEditEmployeeModal(id) {
  const emp = allEmployees.find(x => x.id === id);
  if (!emp) return;

  document.getElementById('edit-e-id').value = emp.id;
  document.getElementById('edit-e-username').value = emp.username;
  document.getElementById('edit-e-fullname').value = emp.full_name;
  document.getElementById('edit-e-role').value = emp.role;

  const errDiv = document.getElementById('edit-e-error');
  errDiv.textContent = '';
  errDiv.classList.add('d-none');

  showModal('edit-employee-modal');
}

// 3. Mở Modal Đặt Lại Mật Khẩu
function showResetPassModal(id) {
  const emp = allEmployees.find(x => x.id === id);
  if (!emp) return;

  document.getElementById('rp-id').value = emp.id;
  document.getElementById('rp-username').textContent = `${emp.full_name} (${emp.username})`;
  document.getElementById('rp-password').value = '';
  document.getElementById('rp-confirm-password').value = '';

  const errDiv = document.getElementById('rp-error');
  errDiv.textContent = '';
  errDiv.classList.add('d-none');

  showModal('reset-pass-modal');
}

// 4. Tải danh sách nhân viên từ API
async function loadEmployees() {
  try {
    const res = await window.apiFetch('/api/employees');
    if (!res || !res.ok) {
      alert('Không thể tải danh sách tài khoản nhân viên');
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

    const lockBtnText = e.is_active ? 'Khóa' : 'Mở Khóa';
    const lockBtnClass = e.is_active ? 'btn-warning' : 'btn-success';
    const nextStatus = !e.is_active;

    tr.innerHTML = `
      <td class="ps-3 fw-semibold">${escapeHtml(e.username)}</td>
      <td>${escapeHtml(e.full_name)}</td>
      <td>${roleBadge}</td>
      <td>${statusBadge}</td>
      <td class="text-end pe-3">
        <button class="btn btn-sm btn-info text-white me-1" onclick="showEditEmployeeModal(${e.id})">
          <i class="bi bi-pencil me-1"></i>Sửa
        </button>
        <button class="btn btn-sm btn-secondary me-1" onclick="showResetPassModal(${e.id})">
          <i class="bi bi-key me-1"></i>Đổi MK
        </button>
        <button class="btn btn-sm ${lockBtnClass} me-1" onclick="toggleLock(${e.id}, ${nextStatus}, '${escapeHtml(e.username)}')">
          ${lockBtnText}
        </button>
        <button class="btn btn-sm btn-outline-danger" onclick="deleteEmployee(${e.id}, '${escapeHtml(e.username)}')">
          <i class="bi bi-trash"></i>
        </button>
      </td>
    `;
    tbody.appendChild(tr);
  });
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
      errDiv.textContent = data.error || 'Lỗi tạo tài khoản nhân viên.';
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
  const id = document.getElementById('edit-e-id').value;
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
      errDiv.textContent = data.error || 'Lỗi cập nhật tài khoản.';
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
  const id = document.getElementById('rp-id').value;
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
      alert('Đã đặt lại mật khẩu thành công.');
    } else {
      errDiv.textContent = data.error || 'Lỗi đặt lại mật khẩu.';
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
      alert(data.error || `Lỗi ${actionText} tài khoản`);
    }
  } catch (err) {
    alert('Lỗi kết nối máy chủ');
  }
}

// 11. Xóa tài khoản (có hộp thoại xác nhận và bảo vệ chứng từ)
async function deleteEmployee(id, username) {
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
      alert(data.error || 'Lỗi xóa tài khoản');
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
});