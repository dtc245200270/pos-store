// Render phân tách layout theo vai trò: MANAGER (Sidebar bên trái) & CASHIER (Menu gọn phía trên)
document.addEventListener('DOMContentLoaded', async () => {
  // Đảm bảo icon Bootstrap được tải nếu trang chưa có
  if (!document.querySelector('link[href*="bootstrap-icons"]')) {
    const iconLink = document.createElement('link');
    iconLink.rel = 'stylesheet';
    iconLink.href = 'https://cdn.jsdelivr.net/npm/bootstrap-icons@1.10.0/font/bootstrap-icons.css';
    document.head.appendChild(iconLink);
  }

  // Gọi API xác thực người dùng
  const res = await window.apiFetch('/api/auth/me', { method: 'GET' });
  if (!res || !res.ok) return;

  const user = await res.json();
  const role = user.role;
  const name = user.fullName || user.username || 'Người dùng';
  const roleLabel = role === 'MANAGER' ? 'Quản lý' : (role === 'CASHIER' ? 'Thu ngân' : role);

  // Đường dẫn hiện tại (chuẩn hóa)
  const currentPath = (window.location.pathname || '/').replace(/\/+$/, '') || '/';

  // Xóa navbar/sidebar cũ nếu có
  const oldNav = document.querySelector('nav.navbar');
  if (oldNav) oldNav.remove();
  const oldSidebar = document.querySelector('.pos-manager-sidebar');
  if (oldSidebar) oldSidebar.remove();
  const oldMobileBar = document.querySelector('.pos-manager-mobile-bar');
  if (oldMobileBar) oldMobileBar.remove();

  // Inject CSS cho cả hai layout
  let styleEl = document.getElementById('pos-layout-styles');
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = 'pos-layout-styles';
    styleEl.textContent = `
      /* --- Layout Quản lý: Sidebar bên trái --- */
      body.pos-manager-layout {
        padding-left: 260px !important;
        background-color: #f8fafc;
        min-height: 100vh;
      }
      .pos-manager-sidebar {
        position: fixed;
        top: 0;
        left: 0;
        bottom: 0;
        width: 260px;
        background-color: #1e293b;
        color: #f8fafc;
        display: flex;
        flex-direction: column;
        z-index: 1040;
        box-shadow: 2px 0 10px rgba(0,0,0,0.15);
        overflow-y: auto;
      }
      .pos-manager-sidebar .nav-link {
        color: #cbd5e1;
        border-radius: 6px;
        padding: 0.65rem 1rem;
        margin-bottom: 2px;
        font-size: 0.95rem;
        display: flex;
        align-items: center;
        transition: all 0.15s ease-in-out;
      }
      .pos-manager-sidebar .nav-link:hover {
        background-color: rgba(255, 255, 255, 0.08);
        color: #ffffff;
      }
      .pos-manager-sidebar .nav-link.active {
        background-color: #0d6efd !important;
        color: #ffffff !important;
        font-weight: 600 !important;
        border-radius: 6px !important;
        box-shadow: 0 2px 6px rgba(13, 110, 253, 0.35);
      }
      .pos-manager-mobile-bar {
        display: none;
      }

      /* --- Layout Thu ngân: Menu gọn, tối đa diện tích bán hàng --- */
      body.pos-cashier-layout {
        padding-left: 0 !important;
        background-color: #f8fafc;
      }
      .pos-cashier-nav {
        background-color: #212529 !important;
        padding-top: 0.25rem !important;
        padding-bottom: 0.25rem !important;
        min-height: 48px;
      }
      .pos-cashier-nav .nav-link {
        color: #dee2e6;
        padding: 0.4rem 0.85rem !important;
        border-radius: 6px;
        margin-right: 4px;
        font-size: 0.92rem;
        transition: all 0.15s ease-in-out;
      }
      .pos-cashier-nav .nav-link:hover {
        background-color: rgba(255, 255, 255, 0.1);
        color: #ffffff;
      }
      .pos-cashier-nav .nav-link.active {
        background-color: #0d6efd !important;
        color: #ffffff !important;
        font-weight: 600 !important;
        border-radius: 6px !important;
      }

      /* --- Responsive Mobile cho Manager --- */
      @media (max-width: 991.98px) {
        body.pos-manager-layout {
          padding-left: 0 !important;
        }
        .pos-manager-sidebar {
          transform: translateX(-100%);
          transition: transform 0.3s ease;
        }
        .pos-manager-sidebar.show {
          transform: translateX(0);
        }
        .pos-manager-mobile-bar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          background-color: #1e293b;
          color: #ffffff;
          padding: 0.5rem 1rem;
          margin-bottom: 1rem;
        }
      }

      /* --- Đảm bảo an toàn khi in hóa đơn --- */
      @media print {
        body.pos-manager-layout,
        body.pos-cashier-layout {
          padding-left: 0 !important;
          margin: 0 !important;
          background: #fff !important;
        }
        .pos-manager-sidebar,
        .pos-manager-mobile-bar,
        .pos-cashier-nav {
          display: none !important;
        }
      }
    `;
    document.head.appendChild(styleEl);
  }

  if (role === 'MANAGER') {
    // --- KHU VỰC QUẢN LÝ ---
    document.body.classList.remove('pos-cashier-layout');
    document.body.classList.add('pos-manager-layout');

    // Menu Quản lý (7 mục theo đúng yêu cầu):
    // Tổng quan, Bán hàng, Sản phẩm, Nhập hàng, Tồn kho, Hóa đơn, Tài khoản nhân viên
    const managerNavItems = [
      { title: 'Tổng quan', path: '/', icon: 'bi-speedometer2' },
      { title: 'Bán hàng', path: '/sales', icon: 'bi-cart3' },
      { title: 'Sản phẩm', path: '/products', icon: 'bi-box-seam' },
      { title: 'Nhập hàng', path: '/stock-receipts', icon: 'bi-arrow-down-square' },
      { title: 'Tồn kho', path: '/inventory', icon: 'bi-archive' },
      { title: 'Hóa đơn', path: '/invoices', icon: 'bi-receipt' },
      { title: 'Tài khoản nhân viên', path: '/employees', icon: 'bi-people' }
    ];

    let navListHtml = '';
    managerNavItems.forEach(item => {
      const isActive = (item.path === '/' && currentPath === '/') || (item.path !== '/' && currentPath === item.path);
      navListHtml += `
        <li class="nav-item">
          <a class="nav-link ${isActive ? 'active' : ''}" 
             href="${item.path}" 
             ${isActive ? 'aria-current="page"' : ''}>
            <i class="bi ${item.icon} me-2"></i>
            <span>${item.title}</span>
          </a>
        </li>
      `;
    });

    const sidebarHtml = `
      <div class="pos-manager-mobile-bar d-lg-none">
        <span class="fw-bold">POS Store - Quản lý</span>
        <button class="btn btn-sm btn-outline-light" id="manager-mobile-toggle">
          <i class="bi bi-list"></i> Menu
        </button>
      </div>

      <aside class="pos-manager-sidebar" id="posManagerSidebar">
        <!-- Brand Header -->
        <div class="p-3 border-bottom border-secondary d-flex align-items-center justify-content-between">
          <div>
            <div class="fw-bold fs-5 text-white">POS Store</div>
            <span class="badge bg-primary">Quản lý</span>
          </div>
        </div>

        <!-- Navigation Menu -->
        <nav class="p-3 flex-grow-1">
          <ul class="nav flex-column">
            ${navListHtml}
          </ul>
        </nav>

        <!-- User Greeting & Logout Footer -->
        <div class="p-3 border-top border-secondary mt-auto bg-dark bg-opacity-25">
          <div class="text-white small mb-2 text-truncate" id="manager-user-greeting">
            Xin chào, <strong>${escapeHtml(name)}</strong>
            <div class="text-info mt-1">Vai trò: ${roleLabel}</div>
          </div>
          <a href="/profile" class="btn btn-outline-info btn-sm w-100 mb-2">
            <i class="bi bi-person-circle me-1"></i>Tài khoản của tôi
          </a>
          <button type="button" class="btn btn-outline-danger btn-sm w-100" onclick="logout()">
            <i class="bi bi-box-arrow-right me-1"></i>Đăng xuất
          </button>
        </div>
      </aside>
    `;

    document.body.insertAdjacentHTML('afterbegin', sidebarHtml);

    // Xử lý toggle menu trên mobile
    const toggleBtn = document.getElementById('manager-mobile-toggle');
    const sidebar = document.getElementById('posManagerSidebar');
    if (toggleBtn && sidebar) {
      toggleBtn.addEventListener('click', () => {
        sidebar.classList.toggle('show');
      });
    }

  } else {
    // --- KHU VỰC THU NGÂN ---
    document.body.classList.remove('pos-manager-layout');
    document.body.classList.add('pos-cashier-layout');

    // Menu Thu ngân (4 mục gọn gàng, ưu tiên diện tích bán hàng):
    // Bán hàng, Hóa đơn của tôi, Tra cứu tồn kho, Tài khoản của tôi
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
      <nav class="navbar navbar-expand-lg navbar-dark bg-dark pos-cashier-nav mb-3 shadow-sm">
        <div class="container-fluid px-2">
          <a class="navbar-brand py-0 me-3 fw-bold fs-6" href="/sales">
            POS Store <span class="badge bg-success ms-1">Thu ngân</span>
          </a>
          <button class="navbar-toggler py-1 px-2" type="button" data-bs-toggle="collapse" data-bs-target="#cashierNavCollapse">
            <span class="navbar-toggler-icon"></span>
          </button>
          <div class="collapse navbar-collapse" id="cashierNavCollapse">
            <ul class="navbar-nav me-auto mb-2 mb-lg-0 align-items-lg-center">
              ${navListHtml}
            </ul>
            <div class="d-flex text-white align-items-center py-1">
              <span class="me-3 small" id="cashier-user-greeting">
                Xin chào, <strong>${escapeHtml(name)}</strong>
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
});

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>'"]/g, tag => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[tag] || tag));
}

async function logout() {
  const res = await window.apiFetch('/api/auth/logout', { method: 'POST' });
  if (res && res.ok) {
    localStorage.clear();
    window.location.href = '/login';
  } else {
    alert('Đăng xuất thất bại');
  }
}
