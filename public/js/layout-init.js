/**
 * ==============================================================================
 * DỰ ÁN POS STORE - KHỞI TẠO BỐ CỤC TRƯỚC RENDER (EARLY LAYOUT INITIALIZER)
 * ==============================================================================
 * Tệp: public/js/layout-init.js
 * Mục đích:
 *   - Được nhúng trong thẻ <head> của toàn bộ các trang giao diện.
 *   - Đọc trạng thái thu gọn sidebar (pos_sidebar_collapsed) từ localStorage trước khi
 *     trình duyệt vẽ (paint) phần thân trang (DOM Body).
 *   - Thêm class 'sidebar-collapsed' vào thẻ <html> để loại bỏ hoàn toàn hiện tượng
 *     giật khung hình hoặc chớp trắng (FOUC - Flash of Unstyled Content).
 * ==============================================================================
 */

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
