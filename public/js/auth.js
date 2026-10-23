// Quản lý CSRF và fetch wrapper
let csrfToken = null;

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
