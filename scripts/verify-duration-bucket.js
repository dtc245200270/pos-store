/**
 * scripts/verify-duration-bucket.js
 * 
 * Script kiểm tra bucket <= 2s và đối chiếu chênh lệch counter của POS Store.
 * Tuân thủ nghiêm ngặt các yêu cầu:
 * 1. Assertion thực sự: Ném ngoại lệ / trả exitCode khác 0 nếu counter không tăng, thiếu dữ liệu,
 *    truy vấn lỗi hoặc kết quả không khớp. Không ép dữ liệu thiếu thành 0.
 * 2. Timeout thực sự: Hủy request bằng req.destroy() khi quá hạn, không bị treo trong polling.
 * 3. Scrape interval Prometheus (15s): Polling có timeout xác nhận scrape mới, kiểm tra tại cùng thời điểm,
 *    đối chiếu delta trước/sau thành bước riêng, phát hiện counter reset.
 * 4. Không ép buộc tỷ lệ phải là 100% hoặc >= 99%: Phân biệt kiểm tra tính đúng của dashboard với mục tiêu hiệu năng.
 * 5. Xác nhận hết tải bằng truy vấn: Kiểm tra target vẫn UP và rate count trở về 0/rỗng.
 * 6. Hỗ trợ import hoặc chạy trực tiếp bằng process.exitCode.
 */

const {
  sleep,
  assert,
  httpRequest,
  queryPrometheus,
  extractMetricValue,
  verifyCooldownState
} = require('./monitoring-common');

async function runVerifyDurationBucket(options = {}) {
  const promBase = options.promUrl || process.env.PROM_URL || 'http://127.0.0.1:9090';
  const nginxBase = options.nginxUrl || process.env.NGINX_URL || 'http://localhost:8080';
  const targetRequests = options.requestCount || 24;
  const pollTimeoutSec = options.pollTimeoutSec || 45;
  const cooldownTimeoutSec = options.cooldownTimeoutSec || 75;

  console.log('======================================================================');
  console.log('  KIỂM THỬ GIÁM SÁT: ĐỐI CHIẾU BUCKET <= 2S & CHU KỲ SCRAPE PROMETHEUS');
  console.log(`  (Prometheus: ${promBase} | Nginx/POS Store: ${nginxBase})`);
  console.log('======================================================================\n');

  // 0. Kiểm tra Prometheus sẵn sàng & target pos_store UP
  console.log('[BƯỚC 0] Kiểm tra trạng thái Prometheus & Target pos_store...');
  const qUp = await queryPrometheus({ baseUrl: promBase, query: 'up{job="pos_store"}' });
  const upVal = extractMetricValue(qUp, 'up{job="pos_store"}');
  assert(upVal === 1, `Target pos_store không UP (up = ${upVal}).`);
  console.log(' -> [PASS] Target pos_store đang UP (up = 1).\n');

  // 1. Ghi nhận baseline trước khi phát tải tại thời điểm t_before
  const tBefore = (Date.now() / 1000).toFixed(3);
  console.log(`[BƯỚC 1] Ghi nhận số liệu baseline tại thời điểm t_before = ${tBefore}:`);

  const qCountBefore = await queryPrometheus({
    baseUrl: promBase,
    query: 'sum(http_request_duration_seconds_count{job="pos_store"})',
    time: tBefore
  });
  const countBefore = extractMetricValue(qCountBefore, 'count trước tải');

  const qBucketBefore = await queryPrometheus({
    baseUrl: promBase,
    query: 'sum(http_request_duration_seconds_bucket{job="pos_store", le=~"2|2[.]0"})',
    time: tBefore
  });
  const bucketBefore = extractMetricValue(qBucketBefore, 'bucket trước tải');

  console.log(` - Tổng số yêu cầu trước tải (countBefore)  : ${countBefore}`);
  console.log(` - Số bucket <= 2s trước tải (bucketBefore) : ${bucketBefore}`);
  console.log(' -> [PASS] Đã ghi nhận baseline thành công (dữ liệu đầy đủ, kiểm tra Number.isFinite).\n');

  // 2. Phát lưu lượng thử nghiệm an toàn
  // Chỉ dùng GET /login và GET /public/css/style.css, KHÔNG dùng /api/auth/csrf
  console.log(`[BƯỚC 2] Phát lưu lượng thử nghiệm an toàn tới ${nginxBase}:`);
  const trafficUrls = [
    `${nginxBase}/login`,
    `${nginxBase}/public/css/style.css`
  ];

  const stats = { sent: 0, success: 0, errors: 0 };
  console.log(` -> Bắt đầu gửi ${targetRequests} yêu cầu (chỉ GET /login và /public/css/style.css)...`);
  const tSendStart = Date.now();

  for (let i = 0; i < targetRequests; i++) {
    const targetUrl = trafficUrls[i % trafficUrls.length];
    try {
      const res = await httpRequest(targetUrl, null, 5000);
      stats.sent++;
      if (res.ok) {
        stats.success++;
      } else {
        stats.errors++;
        console.error(` [LOI] Yêu cầu ${i + 1} tới ${targetUrl} trả về HTTP ${res.statusCode}`);
      }
    } catch (err) {
      stats.sent++;
      stats.errors++;
      console.error(` [LOI] Yêu cầu ${i + 1} tới ${targetUrl} thất bại: ${err.message}`);
    }

    if (i < targetRequests - 1) {
      await sleep(options.sendIntervalMs !== undefined ? options.sendIntervalMs : 800);
    }
  }

  const tSendElapsed = ((Date.now() - tSendStart) / 1000).toFixed(1);
  console.log(` -> Đã gửi xong ${stats.sent} yêu cầu trong ${tSendElapsed}s:`);
  console.log(`    * Thành công: ${stats.success}`);
  console.log(`    * Lỗi: ${stats.errors}`);

  assert(stats.sent === targetRequests, `Số yêu cầu gửi (${stats.sent}) không khớp số dự kiến (${targetRequests}).`);
  assert(stats.errors === 0, `Có ${stats.errors} yêu cầu bị lỗi HTTP khi phát lưu lượng!`);
  assert(stats.success === stats.sent, `Số yêu cầu thành công (${stats.success}) không bằng số đã gửi (${stats.sent}).`);
  console.log(' -> [PASS] Toàn bộ yêu cầu thử nghiệm đều thành công.\n');

  // 3. Polling có timeout để xác nhận lượt scrape mới từ Prometheus (chu kỳ 15s)
  console.log(`[BƯỚC 3] Polling Prometheus để xác nhận lượt scrape mới (timeout ${pollTimeoutSec}s)...`);
  const pollStart = Date.now();
  let scrapeDetected = false;
  let latestCount = countBefore;

  while ((Date.now() - pollStart) < pollTimeoutSec * 1000) {
    await sleep(2000);
    const qCheck = await queryPrometheus({
      baseUrl: promBase,
      query: 'sum(http_request_duration_seconds_count{job="pos_store"})'
    });
    latestCount = extractMetricValue(qCheck, 'polling counter count');

    // Kiểm tra phát hiện counter reset
    assert(latestCount >= countBefore, `Phát hiện COUNTER RESET! (latest: ${latestCount} < before: ${countBefore}). Lượt kiểm tra không hợp lệ.`);

    if (latestCount >= countBefore + stats.success) {
      scrapeDetected = true;
      const elapsed = ((Date.now() - pollStart) / 1000).toFixed(1);
      console.log(` -> Đã phát hiện scrape mới! Counter hiện tại: ${latestCount} (tăng >= ${stats.success} sau ${elapsed}s).`);
      break;
    } else {
      console.log(`    [Polling] Counter đang là ${latestCount} (chờ >= ${countBefore + stats.success})...`);
    }
  }

  assert(scrapeDetected, `Quá thời gian ${pollTimeoutSec}s mà Prometheus chưa ghi nhận scrape mới với counter tăng!`);
  console.log(' -> [PASS] Đã xác nhận lượt scrape mới thành công.\n');

  // 4. Đối chiếu chênh lệch counter trước/sau thành KIỂM TRA RIÊNG tại cùng thời điểm t_eval
  await sleep(1000);
  const tEval = (Date.now() / 1000).toFixed(3);
  console.log(`[BƯỚC 4] Đối chiếu chênh lệch counter trước/sau tại cùng thời điểm t_eval = ${tEval}:`);

  const qCountAfter = await queryPrometheus({
    baseUrl: promBase,
    query: 'sum(http_request_duration_seconds_count{job="pos_store"})',
    time: tEval
  });
  const countAfter = extractMetricValue(qCountAfter, 'count sau tải');

  const qBucketAfter = await queryPrometheus({
    baseUrl: promBase,
    query: 'sum(http_request_duration_seconds_bucket{job="pos_store", le=~"2|2[.]0"})',
    time: tEval
  });
  const bucketAfter = extractMetricValue(qBucketAfter, 'bucket sau tải');

  const deltaCount = countAfter - countBefore;
  const deltaBucket = bucketAfter - bucketBefore;

  console.log(` - Count sau tải (countAfter)    : ${countAfter} (Δ count: ${deltaCount})`);
  console.log(` - Bucket sau tải (bucketAfter)  : ${bucketAfter} (Δ bucket: ${deltaBucket})`);

  assert(deltaCount >= stats.success, `Δ count (${deltaCount}) nhỏ hơn số yêu cầu thử nghiệm thành công (${stats.success}).`);
  assert(deltaBucket >= 0, `Δ bucket (${deltaBucket}) bị âm, không hợp lệ.`);
  assert(deltaBucket <= deltaCount, `Δ bucket (${deltaBucket}) lớn hơn Δ count (${deltaCount}) - Dữ liệu bất thường.`);

  const actualDeltaRatio = deltaCount > 0 ? (deltaBucket / deltaCount) * 100 : 0;
  assert(Number.isFinite(actualDeltaRatio), `Tỷ lệ delta bucket (${actualDeltaRatio}) không phải số hữu hạn.`);
  console.log(` -> TỶ LỆ HOÀN THÀNH <= 2S TỪ DELTA COUNTER: ${actualDeltaRatio.toFixed(2)}% (${deltaBucket}/${deltaCount})`);
  console.log(' -> [PASS] Đối chiếu counter trước/sau thành công.\n');

  // 5. Kiểm tra biểu thức của Dashboard Grafana trên Prometheus tại cùng thời điểm t_eval
  console.log(`[BƯỚC 5] Đánh giá biểu thức PromQL trên Dashboard Grafana tại thời điểm t_eval = ${tEval}:`);
  const rateBucketExpr = 'sum(rate(http_request_duration_seconds_bucket{job="pos_store", le=~"2|2[.]0"}[1m]))';
  const rateCountExpr = 'sum(rate(http_request_duration_seconds_count{job="pos_store"}[1m]))';
  const dashboardExpr = `(${rateBucketExpr} / (${rateCountExpr} > 0)) * 100`;

  console.log(` - Rate Bucket Expr: ${rateBucketExpr}`);
  console.log(` - Rate Count Expr : ${rateCountExpr}`);
  console.log(` - Dashboard Expr  : ${dashboardExpr}`);

  const qRateBucket = await queryPrometheus({ baseUrl: promBase, query: rateBucketExpr, time: tEval });
  const rateBucketVal = extractMetricValue(qRateBucket, 'rate bucket <= 2s [1m]');

  const qRateCount = await queryPrometheus({ baseUrl: promBase, query: rateCountExpr, time: tEval });
  const rateCountVal = extractMetricValue(qRateCount, 'rate count tổng số yêu cầu [1m]');

  assert(rateCountVal > 0, `Rate count tại thời điểm t_eval (${rateCountVal}) không lớn hơn 0!`);

  const qDash = await queryPrometheus({ baseUrl: promBase, query: dashboardExpr, time: tEval });
  const dashVal = extractMetricValue(qDash, 'biểu thức PromQL Dashboard lúc có tải');

  assert(Number.isFinite(dashVal), `Giá trị biểu thức dashboard (${dashVal}) không phải số hữu hạn.`);

  const expectedDashVal = (rateBucketVal / rateCountVal) * 100;
  assert(Number.isFinite(expectedDashVal), `Giá trị kỳ vọng từ (rateBucket / rateCount) * 100 (${expectedDashVal}) không phải số hữu hạn.`);

  console.log(` - Tốc độ rate bucket <= 2s (rateBucket) : ${rateBucketVal.toFixed(4)} req/s`);
  console.log(` - Tốc độ rate tổng số req (rateCount)   : ${rateCountVal.toFixed(4)} req/s`);
  console.log(` - Tỷ lệ tính từ (rateBucket / rateCount)*100 : ${expectedDashVal.toFixed(2)}%`);
  console.log(` - Giá trị tính từ biểu thức Dashboard       : ${dashVal.toFixed(2)}%`);

  // So sánh kết quả công thức với (rateBucket / rateCount) * 100 tại chính thời điểm đó với sai số số học <= 0.001
  const diff = Math.abs(dashVal - expectedDashVal);
  assert(diff <= 0.001, `Giá trị biểu thức Dashboard (${dashVal.toFixed(4)}%) không khớp kết quả (rateBucket / rateCount)*100 (${expectedDashVal.toFixed(4)}%, diff: ${diff.toFixed(6)}%).`);
  console.log(' -> [PASS] Công thức Dashboard PromQL khớp hoàn toàn với (rateBucket / rateCount) * 100 tại thời điểm đánh giá.\n');

  // 6. Polling xác nhận trạng thái hết tải bằng hàm kiểm tra chuyên biệt
  console.log(`[BƯỚC 6] Polling xác nhận trạng thái hết tải sau khi dừng lưu lượng (timeout ${cooldownTimeoutSec}s)...`);
  const coolResult = await verifyCooldownState({
    baseUrl: promBase,
    timeoutSec: cooldownTimeoutSec,
    intervalMs: 4000
  });
  console.log(` -> Đã xác nhận hết tải thành công sau ${coolResult.elapsedSec}s (Target vẫn UP, count rate trở về ${coolResult.finalRate}).`);
  console.log(' -> [PASS] Trạng thái hết tải được xác nhận bằng truy vấn Prometheus thực tế.\n');

  console.log('======================================================================');
  console.log('       [KẾT QUẢ CUỐI CÙNG] TOÀN BỘ KIỂM THỬ ĐÃ ĐẠT: PASS');
  console.log('======================================================================');

  return {
    success: true,
    countBefore,
    countAfter,
    deltaCount,
    bucketBefore,
    bucketAfter,
    deltaBucket,
    actualDeltaRatio,
    dashVal,
    coolElapsedSec: coolResult.elapsedSec
  };
}

// Chạy trực tiếp qua dòng lệnh nếu được gọi chính thức
if (require.main === module) {
  runVerifyDurationBucket()
    .then(() => {
      process.exitCode = 0;
    })
    .catch((err) => {
      console.error('\n======================================================================');
      console.error(`  [KIỂM THỬ THẤT BẠI: FAIL] ${err.message}`);
      console.error('======================================================================');
      process.exitCode = 1;
    });
}

module.exports = {
  runVerifyDurationBucket
};
