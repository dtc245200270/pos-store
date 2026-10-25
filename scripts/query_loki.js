/**
 * ==============================================================================
 * DỰ ÁN POS STORE - TIỆN ÍCH TRUY VẤN NHẬT KÝ TỪ GRAFANA LOKI (LOGQL QUERY CLI)
 * ==============================================================================
 * Tệp: scripts/query_loki.js
 * Mục đích:
 *   - Truy vấn nhanh nhật ký có cấu trúc từ dịch vụ Grafana Loki qua HTTP API (/loki/api/v1/query_range).
 *   - Hỗ trợ các bộ lọc cài sẵn:
 *       + 'node': Nhật ký từ Node.js backend ({app="pos_store", source="node_backend"}).
 *       + 'nginx': Nhật ký truy cập Nginx reverse proxy ({app="pos_store", source="nginx_access"}).
 *       + 'nginx_error': Nhật ký lỗi Nginx ({app="pos_store", source="nginx_error"}).
 *       + 'errors_gte_400': Lọc tất cả nhật ký có mã trạng thái HTTP >= 400.
 *       + Chuỗi chứa dấu gạch nối: Tự động tìm kiếm theo requestId (UUID).
 *       + Cú pháp LogQL tùy biến bắt đầu bằng '{'.
 * ==============================================================================
 */

/**
 * Gửi yêu cầu truy vấn khoảng thời gian (query_range) tới máy chủ Loki cục bộ
 * @param {string} logql - Chuỗi truy vấn cú pháp LogQL
 * @param {number} limit - Số lượng dòng nhật ký tối đa trả về (mặc định 50)
 * @returns {Promise<object>} Đối tượng JSON phản hồi từ Loki API
 */
async function queryLoki(logql, limit = 50) {
  const query = encodeURIComponent(logql);
  const url = `http://127.0.0.1:3100/loki/api/v1/query_range?query=${query}&limit=${limit}`;
  const res = await fetch(url);
  const json = await res.json();
  return json;
}

/**
 * Hàm thực thi chính khi chạy từ giao diện dòng lệnh (CLI)
 */
async function main() {
  const arg = process.argv[2] || 'all';
  let logql = '{app="pos_store"}';
  if (arg === 'node') {
    logql = '{app="pos_store", source="node_backend"}';
  } else if (arg === 'nginx') {
    logql = '{app="pos_store", source="nginx_access"}';
  } else if (arg === 'nginx_error') {
    logql = '{app="pos_store", source="nginx_error"}';
  } else if (arg === 'errors_gte_400') {
    // Truy van ca Node va Nginx voi status >= 400
    logql = '{app="pos_store"} | json | statusCode >= 400';
  } else if (arg.startsWith('{')) {
    logql = arg;
  } else if (arg.includes('-')) {
    // Tim kiem theo requestId
    logql = `{app="pos_store"} |= "${arg}"`;
  }
  
  console.log(`Executing LogQL: ${logql}`);
  const json = await queryLoki(logql);
  if (json.status !== 'success') {
    console.error('Error response from Loki:', json);
    return;
  }
  console.log('Status:', json.status);
  const result = json.data?.result || [];
  console.log(`Streams found: ${result.length}`);
  for (const stream of result) {
    console.log('\n--- STREAM ---');
    console.log('Labels:', stream.stream);
    console.log(`Log lines count: ${stream.values.length}`);
    for (let i = 0; i < Math.min(5, stream.values.length); i++) {
      const [ts, line] = stream.values[i];
      console.log(` [${new Date(Number(ts.slice(0, 13))).toISOString()}] ${line}`);
    }
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { queryLoki };
