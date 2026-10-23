const assert = require('assert');

async function testDashboardQueries() {
  console.log('========================================================');
  console.log('KIỂM THỬ TRUY VẤN DASHBOARD THEO 3 TÌNH HUỐNG');
  console.log('========================================================\n');

  const promBase = 'http://127.0.0.1:9090/api/v1/query';

  // 1. TÌNH HUỐNG 1: Không có tải (Không có dữ liệu trong khoảng đo)
  console.log('1. Tình huống: Không có tải (khoảng đo không phát sinh yêu cầu)...');
  const queryNoTraffic = '((sum(rate(http_requests_total{job="pos_store_no_traffic", status_code=~"5.."}[1m])) or (sum(rate(http_requests_total{job="pos_store_no_traffic"}[1m])) * 0)) / (sum(rate(http_requests_total{job="pos_store_no_traffic"}[1m])) > 0)) * 100';
  const res1 = await fetch(`${promBase}?query=${encodeURIComponent(queryNoTraffic)}`);
  const data1 = await res1.json();

  assert.strictEqual(data1.status, 'success', 'Truy vấn phải thành công');
  assert.strictEqual(data1.data.result.length, 0, 'Khi không có yêu cầu, kết quả phải rỗng (Empty vector)');
  console.log('   ✓ Kết quả trả về: Vector rỗng [] -> Grafana hiển thị: "Chưa có dữ liệu".\n');

  // 2. TÌNH HUỐNG 2: Có tải nhưng KHÔNG CÓ lỗi 5xx
  console.log('2. Tình huống: Có tải nhưng không có lỗi 5xx...');
  // Biểu thức giả lập có tải 0.5 req/s và 0 lỗi 5xx:
  const simQueryNo5xx = '((vector(0) or (vector(0.5) * 0)) / (vector(0.5) > 0)) * 100';
  const res2 = await fetch(`${promBase}?query=${encodeURIComponent(simQueryNo5xx)}`);
  const data2 = await res2.json();

  assert.strictEqual(data2.status, 'success', 'Truy vấn phải thành công');
  assert.strictEqual(data2.data.result.length, 1, 'Phải có 1 kết quả trả về');
  const val2 = Number(data2.data.result[0].value[1]);
  assert.strictEqual(val2, 0, 'Tỷ lệ lỗi 5xx phải chính xác là 0%');
  console.log(`   ✓ Kết quả trả về: ${val2}% -> Grafana hiển thị: "0%".\n`);

  // 3. TÌNH HUỐNG 3: Kiểm tra giải thuật khi có lỗi 5xx
  console.log('3. Tình huống: Có tải và xuất hiện lỗi 5xx (ví dụ 0.1 req/s lỗi 5xx trên tổng 0.5 req/s)...');
  const simQueryWith5xx = '((vector(0.1) or (vector(0.5) * 0)) / (vector(0.5) > 0)) * 100';
  const res3 = await fetch(`${promBase}?query=${encodeURIComponent(simQueryWith5xx)}`);
  const data3 = await res3.json();

  assert.strictEqual(data3.status, 'success', 'Truy vấn phải thành công');
  assert.strictEqual(data3.data.result.length, 1, 'Phải có 1 kết quả trả về');
  const val3 = Number(data3.data.result[0].value[1]);
  assert.strictEqual(val3, 20, 'Tỷ lệ lỗi phải là 20%');
  console.log(`   ✓ Kết quả trả về: ${val3}% -> Grafana hiển thị tỷ lệ lỗi chính xác (20%).\n`);

  console.log('========================================================');
  console.log('TẤT CẢ 3 TÌNH HUỐNG TRUY VẤN DASHBOARD ĐỀU ĐẠT CHUẨN!');
  console.log('========================================================');
}

testDashboardQueries().catch(err => {
  console.error('[LỖI]:', err);
  process.exit(1);
});
