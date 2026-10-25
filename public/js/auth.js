/**
 * ==============================================================================
 * DỰ ÁN POS STORE - TRÌNH BAO BỌC GỌI API PHÍA CLIENT (CLIENT API WRAPPER)
 * ==============================================================================
 * Tệp: public/js/auth.js
 * Mục đích:
 *   - Quản lý và lưu đệm CSRF Token phía trình duyệt.
 *   - Cung cấp hàm `window.apiFetch(url, options)` bọc chuẩn hàm `fetch` gốc:
 *       1. Tự động đính kèm header `Content-Type: application/json`.
 *       2. Tự động đính kèm header `X-CSRF-Token` cho các yêu cầu POST/PUT/DELETE/PATCH.
 *       3. Tự động lấy lại token mới và retry nếu server trả lỗi 403 CSRF mismatch.
 *       4. Tự động điều hướng về trang đăng nhập `/login` khi phiên hết hạn (HTTP 401).
 *   - Cung cấp hàm `window.formatApiError(data)` hiển thị thông báo thân thiện và mã tra cứu Request ID.
 * ==============================================================================
 */

// Bộ đệm lưu trữ CSRF token trong bộ nhớ phiên làm việc của trang
let csrfToken = null;

/**
 * Lấy mã CSRF Token từ máy chủ (/api/auth/csrf)
 * - Đầu vào: `forceRefresh` (boolean - nếu true sẽ bắt buộc gọi API lấy token mới).
 * - Kết quả: Chuỗi mã token hoặc null nếu thất bại.
 */
async function fetchCsrfToken(forceRefresh = false) {
  if (csrfToken && !forceRefresh) return csrfToken;
  try {
    const res = await fetch('/api/auth/csrf');
    const data = await res.json();
    csrfToken = data.csrfToken;
    return csrfToken;
  } catch (err) {
    console.error('Lỗi lấy CSRF Token:', err);
    return null;
  }
}

function formatApiError(data, defaultMsg = 'Đã có lỗi xảy ra') {
  if (data && data.requestId) {
    return `Không thể thực hiện thao tác. Mã tra cứu: ${data.requestId}`;
  }
  return (data && (data.error || data.message)) || defaultMsg;
}
window.formatApiError = formatApiError;

async function apiFetch(url, options = {}) {
  let token = await fetchCsrfToken();
  const headers = new Headers(options.headers || {});
  headers.set('Content-Type', 'application/json');
  
  if (options.method && options.method.toUpperCase() !== 'GET') {
    headers.set('X-CSRF-Token', token);
  }

  let res = await fetch(url, { ...options, headers });
  
  // Xử lý khi token hết hạn hoặc lỗi CSRF (403)
  if (res.status === 403) {
    const text = await res.clone().text();
    if (text.includes('CSRF') || text.includes('token')) {
      token = await fetchCsrfToken(true); // Lấy token mới
      headers.set('X-CSRF-Token', token);
      res = await fetch(url, { ...options, headers }); // Thử lại
    }
  }

  // Tự động redirect nếu 401
  if (res.status === 401) {
    window.location.href = '/login';
    return res;
  }
  
  return res;
}

window.apiFetch = apiFetch;
