/**
 * ==============================================================================
 * DỰ ÁN POS STORE - ĐIỀU HƯỚNG VÀ DỰNG BỐ CỤC CHUNG (SHARED LAYOUT ENGINE)
 * ==============================================================================
 * Tệp: public/js/layout.js
 * Mục đích:
 *   - Tự động dựng bố cục giao diện phân tách theo vai trò:
 *       1. Bố cục Quản lý (pos-manager-layout): Sidebar đa cấp bên trái (hỗ trợ thu gọn/mở rộng,
 *          ghi nhớ trạng thái vào localStorage), Topbar hiển thị tên người dùng và dropdown tài khoản.
 *       2. Bố cục Thu ngân (pos-cashier-layout): Thanh Navbar tinh gọn phía trên, tối ưu không gian thao tác bán hàng.
 *   - Đánh dấu mục menu active theo URL hiện tại (sử dụng màu nhận diện #0d6efd).
 *   - Cơ chế bất đồng bộ không gây giật màn hình:
 *       + Bước 1: `renderLayoutSync()` đọc cache localStorage và dựng khung giao diện tức thì.
 *       + Bước 2: `syncUserInfoAsync()` gọi API /api/auth/me để cập nhật họ tên/vai trò thực tế từ backend.
 *   - Tiện ích bảo mật: `escapeHtml()` chống XSS khi render chuỗi người dùng nhập.
 * ==============================================================================
 */

function getSafeLocalStorage(key) {
  try {
    return window.localStorage ? localStorage.getItem(key) : null;
  } catch (e) {
    return null;
  }
}

function setSafeLocalStorage(key, val) {
  try {
    if (window.localStorage) localStorage.setItem(key, val);
  } catch (e) {}
}

function renderLayoutSync() {
  const currentPath = (window.location.pathname || '/').replace(/\/+$/, '') || '/';

  // Xác định vai trò từ cache hoặc mặc định theo đường dẫn nghiệp vụ
  let cachedRole = getSafeLocalStorage('pos_user_role');
  if (!cachedRole) {
    // Các trang thuộc phạm vi quản lý mặc định là MANAGER
    if (['', '/', '/products', '/employees', '/stock-receipts', '/inventory', '/invoices'].includes(currentPath)) {
      cachedRole = 'MANAGER';
    } else {
      cachedRole = 'CASHIER';
    }
  }

  const cachedName = getSafeLocalStorage('pos_user_name') || (cachedRole === 'MANAGER' ? 'Quản lý' : 'Thu ngân');
  const roleLabel = cachedRole === 'MANAGER' ? 'Quản lý' : (cachedRole === 'CASHIER' ? 'Thu ngân' : cachedRole);

  // Áp dụng trạng thái thu gọn đã lưu từ trước khi vẽ
  let isCollapsedSaved = false;
  try {
    isCollapsedSaved = document.documentElement.classList.contains('sidebar-collapsed') ||
      getSafeLocalStorage('pos_sidebar_collapsed') === 'true';
  } catch (e) {}

  if (cachedRole === 'MANAGER') {
    // --- KHU VỰC QUẢN LÝ ---
    document.body.classList.remove('pos-cashier-layout');
    document.body.classList.add('pos-manager-layout');

    if (isCollapsedSaved && window.innerWidth >= 992) {
      document.body.classList.add('sidebar-collapsed');
      document.documentElement.classList.add('sidebar-collapsed');
    }

    // Nếu sidebar chưa tồn tại trong DOM thì mới chèn vào
    if (!document.getElementById('posManagerSidebar')) {
      const menuGroups = [
        {
          groupTitle: 'Tổng quan',
          items: [
            { title: 'Tổng quan', path: '/', icon: 'bi-speedometer2' }
          ]
        },
        {
          groupTitle: 'Giao dịch',
          items: [
            { title: 'Bán hàng', path: '/sales', icon: 'bi-cart3' },
            { title: 'Nhập hàng', path: '/stock-receipts', icon: 'bi-box-arrow-in-down' },
            { title: 'Hóa đơn', path: '/invoices', icon: 'bi-receipt' }
          ]
        },
        {
          groupTitle: 'Quản lý',
          items: [
            { title: 'Sản phẩm', path: '/products', icon: 'bi-box-seam' },
            { title: 'Tồn kho', path: '/inventory', icon: 'bi-archive' },
            { title: 'Tài khoản nhân viên', path: '/employees', icon: 'bi-people' }
          ]
        }
      ];

      let currentPageTitle = 'Quản lý POS Store';
      let navListHtml = '';
      menuGroups.forEach(grp => {
        navListHtml += `<div class="pos-sidebar-group-title" title="${escapeHtml(grp.groupTitle)}">${escapeHtml(grp.groupTitle)}</div>`;
        grp.items.forEach(item => {
          const isActive = (item.path === '/' && currentPath === '/') || (item.path !== '/' && currentPath === item.path);
          if (isActive) currentPageTitle = item.title;
          navListHtml += `
            <a class="nav-link ${isActive ? 'active' : ''}" 
               href="${item.path}" 
               title="${item.title}"
               aria-label="${item.title}"
               ${isActive ? 'aria-current="page"' : ''}>
              <i class="bi ${item.icon}"></i>
              <span>${item.title}</span>
            </a>
          `;
        });
      });

      const userInitial = (cachedName.trim().charAt(0) || 'Q').toUpperCase();

      const layoutMarkup = `
        <!-- Backdrop cho Mobile Drawer -->
        <div class="pos-sidebar-backdrop" id="posSidebarBackdrop"></div>

        <!-- Topbar cố định phía trên -->
        <header class="pos-topbar-wrapper" id="posTopbar">
          <div class="pos-topbar-left">
            <!-- Nút mở drawer trên mobile -->
            <button class="btn btn-sm btn-outline-secondary d-lg-none" id="btn-mobile-sidebar-toggle" aria-label="Mở menu">
              <i class="bi bi-list fs-5"></i>
            </button>
            <!-- Nút thu gọn sidebar trên desktop -->
            <button class="btn btn-sm btn-outline-secondary btn-sidebar-collapse d-none d-lg-inline-flex" id="btn-desktop-sidebar-collapse" title="Thu gọn / Mở rộng menu" aria-label="Thu gọn menu" aria-expanded="${isCollapsedSaved ? 'false' : 'true'}">
              <i class="bi ${isCollapsedSaved ? 'bi-layout-sidebar' : 'bi-layout-sidebar-inset'}"></i>
            </button>
            <!-- Tên trang hiện tại -->
            <span class="pos-topbar-page-name" id="pos-page-title">${escapeHtml(currentPageTitle)}</span>
          </div>

          <!-- Menu tài khoản dropdown -->
          <div class="dropdown">
            <button class="pos-user-dropdown-btn dropdown-toggle" type="button" id="posUserMenuBtn" data-bs-toggle="dropdown" aria-expanded="false">
              <span class="pos-user-avatar" id="pos-user-avatar">${userInitial}</span>
              <span class="d-none d-sm-inline fw-semibold text-truncate" id="pos-user-display-name" style="max-width: 140px;">${escapeHtml(cachedName)}</span>
              <span class="badge bg-primary ms-1" id="pos-user-role-badge">${roleLabel}</span>
            </button>
            <ul class="dropdown-menu dropdown-menu-end shadow-sm" aria-labelledby="posUserMenuBtn">
              <li class="px-3 py-2 border-bottom">
                <div class="fw-bold text-dark text-truncate" id="pos-dropdown-user-name">${escapeHtml(cachedName)}</div>
                <div class="small text-muted">Vai trò: <span class="text-primary fw-medium" id="pos-dropdown-user-role">${roleLabel}</span></div>
              </li>
              <li>
                <a class="dropdown-item py-2" href="/profile">
                  <i class="bi bi-person-circle me-2 text-primary"></i>Tài khoản của tôi
                </a>
              </li>
              <li><hr class="dropdown-divider my-1"></li>
              <li>
                <button class="dropdown-item py-2 text-danger" type="button" onclick="logout()">
                  <i class="bi bi-box-arrow-right me-2"></i>Đăng xuất
                </button>
              </li>
            </ul>
          </div>
        </header>

        <!-- Sidebar bên trái -->
        <aside class="pos-manager-sidebar" id="posManagerSidebar" aria-label="Điều hướng chính">
          <!-- Brand Header -->
          <div class="pos-sidebar-brand">
            <a href="/" class="text-decoration-none brand-text" title="POS Store">
              <i class="bi bi-shop text-primary fs-5"></i>
              <span class="brand-title">POS Store</span>
            </a>
            <span class="badge bg-primary brand-badge">Quản lý</span>
            <button type="button" class="btn btn-sm btn-link text-white p-0 d-lg-none" id="btn-close-mobile-drawer" aria-label="Đóng menu">
              <i class="bi bi-x-lg fs-5"></i>
            </button>
          </div>

          <!-- Navigation Menu -->
          <nav class="pos-sidebar-nav-container" aria-label="Danh mục chức năng">
            ${navListHtml}
          </nav>

          <!-- Sidebar Footer -->
          <div class="pos-sidebar-footer">
            <!-- Khi mở rộng: 2 nút đầy đủ nhãn không xuống dòng -->
            <div class="pos-sidebar-footer-expanded">
              <a href="/profile" class="btn btn-outline-light btn-sm" title="Tài khoản của tôi" aria-label="Tài khoản của tôi">
                <i class="bi bi-person-gear me-1"></i><span>Tài khoản</span>
              </a>
              <button type="button" class="btn btn-outline-danger btn-sm" onclick="logout()" title="Đăng xuất" aria-label="Đăng xuất">
                <i class="bi bi-box-arrow-right me-1"></i><span>Đăng xuất</span>
              </button>
            </div>
            <!-- Khi thu gọn: 2 nút icon vuông 42x42px căn giữa -->
            <div class="pos-sidebar-footer-collapsed">
              <a href="/profile" class="btn btn-outline-light pos-footer-icon-btn" title="Tài khoản của tôi" aria-label="Tài khoản của tôi">
                <i class="bi bi-person-gear"></i>
              </a>
              <button type="button" class="btn btn-outline-danger pos-footer-icon-btn" onclick="logout()" title="Đăng xuất" aria-label="Đăng xuất">
                <i class="bi bi-box-arrow-right"></i>
              </button>
            </div>
          </div>
        </aside>
      `;

      document.body.insertAdjacentHTML('afterbegin', layoutMarkup);

      // Xử lý sự kiện thu gọn desktop
      const desktopCollapseBtn = document.getElementById('btn-desktop-sidebar-collapse');
      if (desktopCollapseBtn) {
        desktopCollapseBtn.addEventListener('click', () => {
          // Bật transition tạm thời trong 280ms để hiệu ứng bấm nút mượt mà
          document.body.classList.add('sidebar-transitioning');
          const isCollapsed = document.body.classList.toggle('sidebar-collapsed');
          document.documentElement.classList.toggle('sidebar-collapsed', isCollapsed);
          setSafeLocalStorage('pos_sidebar_collapsed', isCollapsed ? 'true' : 'false');
          desktopCollapseBtn.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
          const iconEl = desktopCollapseBtn.querySelector('i');
          if (iconEl) {
            iconEl.className = isCollapsed ? 'bi bi-layout-sidebar' : 'bi bi-layout-sidebar-inset';
          }
          setTimeout(() => {
            document.body.classList.remove('sidebar-transitioning');
          }, 280);
        });
      }

      // Xử lý sự kiện mở / đóng drawer mobile
      const mobileToggleBtn = document.getElementById('btn-mobile-sidebar-toggle');
      const closeDrawerBtn = document.getElementById('btn-close-mobile-drawer');
      const sidebarEl = document.getElementById('posManagerSidebar');
      const backdropEl = document.getElementById('posSidebarBackdrop');

      function openMobileDrawer() {
        if (sidebarEl) sidebarEl.classList.add('show');
        if (backdropEl) backdropEl.classList.add('show');
        document.body.style.overflow = 'hidden';
      }

      function closeMobileDrawer() {
        if (sidebarEl) sidebarEl.classList.remove('show');
        if (backdropEl) backdropEl.classList.remove('show');
        document.body.style.overflow = '';
      }

      if (mobileToggleBtn) mobileToggleBtn.addEventListener('click', openMobileDrawer);
      if (closeDrawerBtn) closeDrawerBtn.addEventListener('click', closeMobileDrawer);
      if (backdropEl) backdropEl.addEventListener('click', closeMobileDrawer);
    }

  } else {
    // --- KHU VỰC THU NGÂN ---
    document.body.classList.remove('pos-manager-layout');
    document.body.classList.add('pos-cashier-layout');

    if (!document.querySelector('.pos-cashier-nav')) {
      const cashierNavItems = [
        { title: 'Bán hàng', path: '/sales', icon: 'bi-cart3' },
        { title: 'Hóa đơn của tôi', path: '/invoices', icon: 'bi-receipt' },
        { title: 'Tra cứu tồn kho', path: '/inventory', icon: 'bi-archive' },
        { title: 'Tài khoản của tôi', path: '/profile', icon: 'bi-person-circle' }
      ];

      let navListHtml = '';
      cashierNavItems.forEach(item => {
        const isActive = (item.path === '/' && currentPath === '/') || (item.path !== '/' && currentPath === item.path);
        navListHtml += `
          <li class="nav-item">
            <a class="nav-link ${isActive ? 'active' : ''}" 
               href="${item.path}" 
               ${isActive ? 'aria-current="page"' : ''}>
              <i class="bi ${item.icon} me-1"></i>
              <span>${item.title}</span>
            </a>
          </li>
        `;
      });

      const cashierNavHtml = `
        <nav class="navbar navbar-expand-lg navbar-dark pos-cashier-nav mb-3 shadow-sm" aria-label="Thanh điều hướng thu ngân">
          <div class="container-fluid px-3">
            <a class="navbar-brand py-0 me-3 fw-bold fs-6 d-flex align-items-center" href="/sales">
              <i class="bi bi-shop me-2 text-primary"></i>POS Store <span class="badge bg-success ms-2">Thu ngân</span>
            </a>
            <button class="navbar-toggler py-1 px-2" type="button" data-bs-toggle="collapse" data-bs-target="#cashierNavCollapse" aria-label="Menu">
              <span class="navbar-toggler-icon"></span>
            </button>
            <div class="collapse navbar-collapse" id="cashierNavCollapse">
              <ul class="navbar-nav me-auto mb-2 mb-lg-0 align-items-lg-center">
                ${navListHtml}
              </ul>
              <div class="d-flex text-white align-items-center py-1">
                <span class="me-3 small" id="cashier-user-greeting">
                  Xin chào, <strong>${escapeHtml(cachedName)}</strong>
                  <span class="badge bg-secondary ms-1">${roleLabel}</span>
                </span>
                <button type="button" class="btn btn-outline-light btn-sm py-1 px-2" onclick="logout()">
                  <i class="bi bi-box-arrow-right me-1"></i>Đăng xuất
                </button>
              </div>
            </div>
          </div>
        </nav>
      `;

      document.body.insertAdjacentHTML('afterbegin', cashierNavHtml);
    }
  }
}

// Cập nhật thông tin tài khoản người dùng trong nền sau khi API trả về
async function syncUserInfoAsync() {
  try {
    const res = await window.apiFetch('/api/auth/me', { method: 'GET' });
    if (!res || !res.ok) return;

    const user = await res.json();
    const role = user.role;
    const name = user.fullName || user.username || 'Người dùng';
    const roleLabel = role === 'MANAGER' ? 'Quản lý' : (role === 'CASHIER' ? 'Thu ngân' : role);

    // Lưu vào cache để trang kế tiếp hiển thị ngay tức thì
    setSafeLocalStorage('pos_user_role', role);
    setSafeLocalStorage('pos_user_name', name);

    // Cập nhật text hiển thị trên Topbar/Navbar mà không xóa dựng lại khung giao diện
    const displayNameEl = document.getElementById('pos-user-display-name');
    if (displayNameEl && displayNameEl.textContent !== name) {
      displayNameEl.textContent = name;
    }
    const avatarEl = document.getElementById('pos-user-avatar');
    if (avatarEl) {
      avatarEl.textContent = (name.trim().charAt(0) || 'Q').toUpperCase();
    }
    const roleBadgeEl = document.getElementById('pos-user-role-badge');
    if (roleBadgeEl && roleBadgeEl.textContent !== roleLabel) {
      roleBadgeEl.textContent = roleLabel;
    }
    const dropNameEl = document.getElementById('pos-dropdown-user-name');
    if (dropNameEl && dropNameEl.textContent !== name) {
      dropNameEl.textContent = name;
    }
    const dropRoleEl = document.getElementById('pos-dropdown-user-role');
    if (dropRoleEl && dropRoleEl.textContent !== roleLabel) {
      dropRoleEl.textContent = roleLabel;
    }
    const cashierGreeting = document.getElementById('cashier-user-greeting');
    if (cashierGreeting) {
      cashierGreeting.innerHTML = `Xin chào, <strong>${escapeHtml(name)}</strong> <span class="badge bg-secondary ms-1">${roleLabel}</span>`;
    }

    // Nếu vai trò thực tế khác vai trò đã render trước đó, re-render chính xác
    const isManagerLayout = document.body.classList.contains('pos-manager-layout');
    if ((role === 'MANAGER' && !isManagerLayout) || (role === 'CASHIER' && isManagerLayout)) {
      renderLayoutSync();
    }
  } catch (err) {
    console.warn('Lỗi đồng bộ thông tin tài khoản:', err);
  }
}

// Khởi chạy bố cục đồng bộ ngay khi DOM sẵn sàng
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    renderLayoutSync();
    syncUserInfoAsync();
  });
} else {
  renderLayoutSync();
  syncUserInfoAsync();
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

async function logout() {
  try {
    const res = await window.apiFetch('/api/auth/logout', { method: 'POST' });
    if (res && res.ok) {
      try { localStorage.clear(); } catch (e) {}
      window.location.href = '/login';
    } else {
      alert('Đăng xuất thất bại');
    }
  } catch (e) {
    try { localStorage.clear(); } catch (err) {}
    window.location.href = '/login';
  }
}
