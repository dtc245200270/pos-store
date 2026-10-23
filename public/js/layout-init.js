// Áp dụng trạng thái sidebar đã lưu trước lần hiển thị đầu tiên (tránh giật bố cục FOUC)
// Tương thích với CSP và an toàn khi localStorage bị chặn
(function() {
  try {
    var isCollapsed = false;
    try {
      if (window.localStorage) {
        isCollapsed = localStorage.getItem('pos_sidebar_collapsed') === 'true';
      }
    } catch (e) {
      // Bỏ qua nếu không truy cập được localStorage
    }
    if (isCollapsed && window.innerWidth >= 992) {
      document.documentElement.classList.add('sidebar-collapsed');
    }
  } catch (err) {}
})();
