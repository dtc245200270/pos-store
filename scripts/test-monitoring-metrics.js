const http = require('http');
const express = require('express');
const assert = require('assert');
const { register, httpRequestsTotal, httpRequestDurationSeconds, metricsMiddleware, normalizeRoute } = require('../config/metrics');

async function testMetricsInIsolation() {
  console.log('====================================================');
  console.log('KIỂM THỬ ĐỘC LẬP METRICS VỚI 4XX VÀ 5XX (CÁCH LY)');
  console.log('====================================================\n');

  // 1. Kiểm tra hàm chuẩn hóa đường dẫn (normalizeRoute)
  console.log('1. Kiểm tra chuẩn hóa route...');
  assert.strictEqual(normalizeRoute({ route: { path: '/:id' }, baseUrl: '/api/products' }), '/api/products/:id');
  assert.strictEqual(normalizeRoute({ route: { path: '/:id/status' }, baseUrl: '/api/employees' }), '/api/employees/:id/status');
  assert.strictEqual(normalizeRoute({ originalUrl: '/api/invoices/999?query=secret' }), '/api/invoices/:id');
  assert.strictEqual(normalizeRoute({ originalUrl: '/random-unknown-path-123' }), 'UNMATCHED');
  console.log('   -> Chuẩn hóa route đạt chuẩn: không lộ query, không bùng nổ nhãn.\n');

  // 2. Tạo một app Express thử nghiệm độc lập trên cổng tạm 3999
  const testApp = express();
  testApp.use(metricsMiddleware);
  testApp.use(express.json());

  // Định nghĩa route giả lập 4xx
  testApp.get('/test-400', (req, res) => {
    res.status(400).json({ error: 'Yêu cầu không hợp lệ' });
  });

  // Định nghĩa route giả lập 500
  testApp.get('/test-500', (req, res) => {
    res.status(500).json({ error: 'Lỗi máy chủ nội bộ giả lập' });
  });

  const testServer = http.createServer(testApp);
  await new Promise((resolve) => testServer.listen(3999, '127.0.0.1', resolve));

  try {
    // 3. Gửi yêu cầu 400
    console.log('2. Gửi yêu cầu thử nghiệm 400 Bad Request...');
    await fetch('http://127.0.0.1:3999/test-400');

    // 4. Gửi yêu cầu 500
    console.log('3. Gửi yêu cầu thử nghiệm 500 Internal Server Error...');
    await fetch('http://127.0.0.1:3999/test-500');

    // 5. Kiểm tra giá trị metrics trong Registry
    console.log('4. Kiểm tra dữ liệu metrics trong Registry...');
    const metricsText = await register.metrics();

    assert.ok(metricsText.includes('status_code="400"'), 'Phải ghi nhận nhãn status_code="400"');
    assert.ok(metricsText.includes('status_code="500"'), 'Phải ghi nhận nhãn status_code="500"');

    console.log('   -> Đã ghi nhận chính xác cả mã 400 và 500 trong Prometheus Registry!');
    console.log('\n====================================================');
    console.log('KIỂM THỬ METRICS CÁCH LY THÀNH CÔNG RỰC RỠ!');
    console.log('====================================================');
  } finally {
    testServer.close();
  }
}

testMetricsInIsolation().catch(err => {
  console.error('Lỗi kiểm thử:', err);
  process.exit(1);
});
