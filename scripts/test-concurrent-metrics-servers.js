const assert = require('assert');
const { startMetricsServer, register } = require('../config/metrics');

async function testConcurrentMetricsServers() {
  console.log('========================================================');
  console.log('KIỂM THỬ 2 MÁY CHỦ METRICS TỰ CẤP CỔNG (METRICS_PORT=0)');
  console.log('========================================================\n');

  console.log('1. Khởi động Máy chủ Metrics thứ 1 với cổng 0...');
  const server1 = await startMetricsServer(0, '127.0.0.1');
  const port1 = server1.address().port;
  console.log(`   -> Máy chủ 1 đã được OS cấp cổng thực tế: ${port1}`);

  console.log('2. Khởi động Máy chủ Metrics thứ 2 với cổng 0 (chạy đồng thời)...');
  const server2 = await startMetricsServer(0, '127.0.0.1');
  const port2 = server2.address().port;
  console.log(`   -> Máy chủ 2 đã được OS cấp cổng thực tế: ${port2}`);

  try {
    // 3. Kiểm tra tính độc lập và khác biệt cổng
    assert.ok(port1 > 0, 'Cổng máy chủ 1 phải > 0');
    assert.ok(port2 > 0, 'Cổng máy chủ 2 phải > 0');
    assert.notStrictEqual(port1, port2, 'Hai máy chủ phải được cấp 2 cổng hoàn toàn khác nhau');
    console.log(`✓ Xác nhận: port1 (${port1}) !== port2 (${port2}). Không có xung đột cổng!\n`);

    // 4. Kiểm tra truy vấn HTTP tới cả hai máy chủ
    console.log(`3. Gửi HTTP GET tới http://127.0.0.1:${port1}/metrics...`);
    const res1 = await fetch(`http://127.0.0.1:${port1}/metrics`);
    assert.strictEqual(res1.status, 200, 'Máy chủ 1 phải trả về HTTP 200');
    const text1 = await res1.text();
    assert.ok(text1.includes('# HELP'), 'Máy chủ 1 phải trả về định dạng Prometheus');
    console.log('   ✓ Máy chủ 1 phản hồi 200 OK với đúng định dạng metrics.');

    console.log(`4. Gửi HTTP GET tới http://127.0.0.1:${port2}/metrics...`);
    const res2 = await fetch(`http://127.0.0.1:${port2}/metrics`);
    assert.strictEqual(res2.status, 200, 'Máy chủ 2 phải trả về HTTP 200');
    const text2 = await res2.text();
    assert.ok(text2.includes('# HELP'), 'Máy chủ 2 phải trả về định dạng Prometheus');
    console.log('   ✓ Máy chủ 2 phản hồi 200 OK với đúng định dạng metrics.');

    console.log('\n========================================================');
    console.log('KIỂM THỬ ĐỒNG THỜI 2 MÁY CHỦ METRICS THÀNH CÔNG RỰC RỠ!');
    console.log('========================================================');
  } finally {
    server1.close();
    server2.close();
  }
}

testConcurrentMetricsServers().catch(err => {
  console.error('[LỖI]:', err);
  process.exit(1);
});
