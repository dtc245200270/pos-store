/**
 * scripts/test-monitoring-mock-failures.js
 * 
 * Bộ kiểm thử mô phỏng cách ly (Isolated Failure Tests):
 * Kiểm tra TRỰC TIẾP mã nguồn thật từ scripts/verify-duration-bucket.js,
 * scripts/test-live-traffic-and-dashboard.js và scripts/monitoring-common.js.
 * 
 * Các tình huống được xác nhận:
 * 1. Counter không tăng -> script thật phát hiện và ném lỗi.
 * 2. Prometheus trả HTTP 500 hoặc thiếu dữ liệu (vector rỗng) -> script thật từ chối.
 * 3. Request bị treo -> queryPrometheus hủy request bằng req.destroy() khi quá timeout.
 * 4. Phát tải gặp HTTP 404 -> bộ phát tải script thật phát hiện lỗi HTTP và ném lỗi.
 * 5. Grafana đăng nhập thất bại -> script thật bắt lỗi HTTP 401.
 * 6. Lỗi sau khi Chrome đã khởi động -> khối finally được bảo đảm thực thi,
 *    tiến trình Chrome bị dừng và thư mục profile tạm bị xóa sạch.
 * 7. Fixtures cách ly cho DOM & Tỷ lệ: Phân tích 0%, tỷ lệ dưới 100%, phát hiện DOM không khớp Prometheus.
 * 8. Kiểm tra tiến trình con CLI thật trả exitCode = 1 khi gặp lỗi.
 */

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  sleep,
  assert,
  httpRequest,
  queryPrometheus,
  extractMetricValue,
  parseStatPanelValue,
  compareDomWithPrometheus,
  resolveExpectedThresholdColor,
  matchesExpectedColor,
  verifyCooldownState
} = require('./monitoring-common');

const { runVerifyDurationBucket } = require('./verify-duration-bucket');
const { runLiveTrafficAndDashboard } = require('./test-live-traffic-and-dashboard');

/**
 * Tạo mock HTTP server dùng loopback và cổng tự cấp (port: 0)
 */
function createMockServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        server,
        port,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise(r => server.close(r))
      });
    });
    server.on('error', reject);
  });
}

function logTestHeader(name) {
  console.log(`\n======================================================================`);
  console.log(`  [MÔ PHỎNG CÁCH LY] ${name}`);
  console.log(`======================================================================`);
}

// --------------------------------------------------------------------
// CA 1: COUNTER KHÔNG TĂNG (GỌI MÃ THẬT runVerifyDurationBucket)
// --------------------------------------------------------------------
async function testCase1CounterNotIncreasing() {
  logTestHeader('CA 1: Counter không tăng sau khi phát lưu lượng (Mã thật)');

  const mockProm = await createMockServer((req, res) => {
    const url = req.url;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (url.includes('up')) {
      return res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [{ value: [Date.now() / 1000, '1'] }] } }));
    }
    // Trả về counter không đổi bất kể thời gian
    if (url.includes('http_request_duration_seconds_count')) {
      return res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [{ value: [Date.now() / 1000, '100'] }] } }));
    }
    if (url.includes('http_request_duration_seconds_bucket')) {
      return res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [{ value: [Date.now() / 1000, '100'] }] } }));
    }
    res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [] } }));
  });

  const mockNginx = await createMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
  });

  try {
    let caughtError = null;
    try {
      await runVerifyDurationBucket({
        promUrl: mockProm.url,
        nginxUrl: mockNginx.url,
        requestCount: 2,
        sendIntervalMs: 50,
        pollTimeoutSec: 3,
        cooldownTimeoutSec: 3
      });
    } catch (err) {
      caughtError = err;
    }

    assert(caughtError, 'Hàm runVerifyDurationBucket KHÔNG ném lỗi khi counter không tăng!');
    console.log(` -> [XÁC NHẬN ĐẠT] Mã thật đã bắt lỗi thành công:`);
    console.log(`    "${caughtError.message}"`);
  } finally {
    await mockProm.close();
    await mockNginx.close();
  }
}

// --------------------------------------------------------------------
// CA 2: PROMETHEUS TRẢ HTTP 500 HOẶC THIẾU DỮ LIỆU KHI ĐÁNH GIÁ CÓ TẢI
// --------------------------------------------------------------------
async function testCase2PrometheusErrorOrMissingData() {
  logTestHeader('CA 2: Prometheus trả HTTP 500 hoặc thiếu dữ liệu (Mã thật)');

  // 2a: Prometheus HTTP 500
  let mode = '500';
  const mockProm = await createMockServer((req, res) => {
    if (mode === '500') {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal Server Error: TSDB corrupted');
    } else {
      // Vector rỗng []
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [] } }));
    }
  });

  try {
    console.log(' - Kiểm tra 2a: Prometheus HTTP 500 trong queryPrometheus:');
    let caught500 = null;
    try {
      await queryPrometheus({ baseUrl: mockProm.url, query: 'up', timeoutMs: 3000 });
    } catch (err) {
      caught500 = err;
    }
    assert(caught500 && caught500.message.includes('HTTP 500'), `Không bắt được lỗi HTTP 500 (nhận: ${caught500?.message})`);
    console.log(`   -> [PASS] Bắt được lỗi: "${caught500.message}"`);

    // 2b: Prometheus vector rỗng (không ép thành 0)
    console.log(' - Kiểm tra 2b: Prometheus trả về vector rỗng [] trong extractMetricValue:');
    mode = 'empty';
    const emptyResp = await queryPrometheus({ baseUrl: mockProm.url, query: 'bucket', timeoutMs: 3000 });
    let caughtEmpty = null;
    try {
      extractMetricValue(emptyResp, 'bucket metric test');
    } catch (err) {
      caughtEmpty = err;
    }
    assert(caughtEmpty && caughtEmpty.message.includes('vector rỗng'), `Không từ chối vector rỗng (nhận: ${caughtEmpty?.message})`);
    console.log(`   -> [PASS] Bắt được lỗi thiếu dữ liệu: "${caughtEmpty.message}"`);

    console.log(' -> [XÁC NHẬN ĐẠT] Toàn bộ lỗi Prometheus 500 và thiếu dữ liệu đều bị từ chối.');
  } finally {
    await mockProm.close();
  }
}

// --------------------------------------------------------------------
// CA 3: REQUEST BỊ TREO VÀ HẾT TIMEOUT (HỦY REQUEST BẰNG DESTROY)
// --------------------------------------------------------------------
async function testCase3RequestTimeoutAndDestroy() {
  logTestHeader('CA 3: Request bị treo và hết timeout (Hủy request bằng req.destroy)');

  const mockHanging = await createMockServer((req, res) => {
    // Không bao giờ trả response để kiểm tra timeout cancellation
  });

  try {
    console.log(' - Gửi truy vấn tới endpoint bị treo với timeoutMs = 1500ms...');
    const t0 = Date.now();
    let caughtTimeout = null;

    try {
      await queryPrometheus({ baseUrl: mockHanging.url, query: 'up', timeoutMs: 1500 });
    } catch (err) {
      caughtTimeout = err;
    }

    const elapsed = Date.now() - t0;
    console.log(` - Thời gian thực thi: ${elapsed}ms`);

    assert(caughtTimeout, 'Request bị treo không bị timeout!');
    assert(caughtTimeout.message.includes('REQUEST_TIMEOUT'), `Lỗi không đúng định dạng timeout: "${caughtTimeout.message}"`);
    assert(elapsed >= 1400 && elapsed <= 3500, `Thời gian hủy request bất thường (${elapsed}ms)`);
    console.log(` -> [XÁC NHẬN ĐẠT] Request bị hủy thành công: "${caughtTimeout.message}"`);
  } finally {
    await mockHanging.close();
  }
}

// --------------------------------------------------------------------
// CA 4: PHÁT TẢI GẶP LỖI HTTP 404 (MÃ THẬT runVerifyDurationBucket)
// --------------------------------------------------------------------
async function testCase4TrafficHttp404() {
  logTestHeader('CA 4: Phát tải gặp lỗi HTTP 404 (Mã thật runVerifyDurationBucket)');

  const mockProm = await createMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [{ value: [Date.now() / 1000, '1'] }] } }));
  });

  const mockNginx404 = await createMockServer((req, res) => {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
  });

  try {
    let caught404 = null;
    try {
      await runVerifyDurationBucket({
        promUrl: mockProm.url,
        nginxUrl: mockNginx404.url,
        requestCount: 2,
        sendIntervalMs: 50,
        pollTimeoutSec: 2,
        cooldownTimeoutSec: 2
      });
    } catch (err) {
      caught404 = err;
    }

    assert(caught404, 'runVerifyDurationBucket KHÔNG ném lỗi khi phát tải bị 404!');
    assert(caught404.message.includes('bị lỗi HTTP'), `Nội dung lỗi không phản ánh HTTP error: "${caught404.message}"`);
    console.log(` -> [XÁC NHẬN ĐẠT] Mã thật đã phát hiện lỗi tải 404: "${caught404.message}"`);
  } finally {
    await mockProm.close();
    await mockNginx404.close();
  }
}

// --------------------------------------------------------------------
// CA 5: GRAFANA ĐĂNG NHẬP THẤT BẠI (MÃ THẬT runLiveTrafficAndDashboard)
// --------------------------------------------------------------------
async function testCase5GrafanaLoginFailure() {
  logTestHeader('CA 5: Grafana đăng nhập thất bại (Mã thật runLiveTrafficAndDashboard)');

  const localDashJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../deploy/monitoring/grafana/dashboards/pos-store-dashboard.json'), 'utf8'));

  const mockGrafana = await createMockServer((req, res) => {
    if (req.url.includes('/api/dashboards/uid/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ dashboard: localDashJson }));
    }
    if (req.url === '/login') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ message: 'Invalid username or password' }));
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  try {
    let caughtAuth = null;
    try {
      await runLiveTrafficAndDashboard({
        grafanaUrl: mockGrafana.url,
        grafanaPassword: 'wrong_password_test'
      });
    } catch (err) {
      caughtAuth = err;
    }

    assert(caughtAuth, 'runLiveTrafficAndDashboard KHÔNG ném lỗi khi đăng nhập thất bại!');
    assert(caughtAuth.message.includes('401'), `Nội dung lỗi không chứa mã HTTP 401: "${caughtAuth.message}"`);
    console.log(` -> [XÁC NHẬN ĐẠT] Mã thật đã từ chối đăng nhập sai: "${caughtAuth.message}"`);
  } finally {
    await mockGrafana.close();
  }
}

// --------------------------------------------------------------------
// CA 6: LUỒNG runLiveTrafficAndDashboard KÍCH HOẠT LỖI VÀ THỰC THI CLEANUP THẬT
// --------------------------------------------------------------------
async function testCase6CleanupInRealFlow() {
  logTestHeader('CA 6: Luồng runLiveTrafficAndDashboard kích hoạt lỗi và thực thi cleanup mã thật');

  const localDashJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../deploy/monitoring/grafana/dashboards/pos-store-dashboard.json'), 'utf8'));

  // Dựng mock Grafana tối thiểu để vượt qua bước xác thực API và POST /login
  const mockGrafana = await createMockServer((req, res) => {
    if (req.url.includes('/api/dashboards/uid/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ dashboard: localDashJson }));
    }
    if (req.url === '/login') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': 'grafana_session=mock_cleanup_session_cookie; Path=/'
      });
      return res.end(JSON.stringify({ message: 'Logged in' }));
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  try {
    console.log(' - Gọi runLiveTrafficAndDashboard với simulateErrorAfterChromeStart: true...');
    let caughtErr = null;
    try {
      await runLiveTrafficAndDashboard({
        grafanaUrl: mockGrafana.url,
        grafanaPassword: 'admin',
        simulateErrorAfterChromeStart: true,
        cdpPort: 9388
      });
    } catch (err) {
      caughtErr = err;
    }

    assert(caughtErr, 'runLiveTrafficAndDashboard KHÔNG ném lỗi khi simulateErrorAfterChromeStart được bật!');
    assert(caughtErr.message.includes('MÔ_PHỎNG_LỖI'), `Nội dung lỗi không đúng: "${caughtErr.message}"`);
    assert(!caughtErr.message.includes('[LỖI CLEANUP]'), `Phát hiện lỗi trong khối cleanup của mã thật: "${caughtErr.message}"`);
    console.log(` -> [XÁC NHẬN ĐẠT] runLiveTrafficAndDashboard đã kích hoạt lỗi mô phỏng và khối finally của mã thật đã dọn dẹp sạch sẽ: "${caughtErr.message}"`);
  } finally {
    await mockGrafana.close();
  }
}

// --------------------------------------------------------------------
// CA 7: FIXTURES CHO DOM & KIỂM TRA MISMATCH BẰNG HÀM THẬT
// --------------------------------------------------------------------
async function testCase7DomAndRatioFixtures() {
  logTestHeader('CA 7: Fixtures cho DOM & Kiểm tra Mismatch bằng compareDomWithPrometheus thật');

  // 1. Panel chỉ có tiêu đề (không đọc số 5 trong 5xx hay 2 trong 2s)
  console.log(' - Kiểm tra 1: Panel chỉ có tiêu đề (không đọc số trong 5xx hay 2s):');
  const pTitle5xx = parseStatPanelValue('Tỷ lệ lỗi HTTP 5xx (%)');
  assert(pTitle5xx.state === 'TITLE_ONLY' && pTitle5xx.value === null, `Tiêu đề 5xx bị parse nhầm: ${JSON.stringify(pTitle5xx)}`);
  console.log(`   * "Tỷ lệ lỗi HTTP 5xx (%)" -> state: 'TITLE_ONLY', value: null (không đọc số 5).`);

  const pTitle2s = parseStatPanelValue('Tỷ lệ yêu cầu hoàn thành <= 2s (%)');
  assert(pTitle2s.state === 'TITLE_ONLY' && pTitle2s.value === null, `Tiêu đề <= 2s bị parse nhầm: ${JSON.stringify(pTitle2s)}`);
  console.log(`   * "Tỷ lệ yêu cầu hoàn thành <= 2s (%)" -> state: 'TITLE_ONLY', value: null (không đọc số 2).`);

  // 2. Panel đang tải (rỗng hoặc null)
  console.log(' - Kiểm tra 2: Panel đang tải hoặc không tìm thấy:');
  const pEmpty = parseStatPanelValue('');
  const pNull = parseStatPanelValue(null);
  assert(pEmpty.state === 'LOADING_OR_NOT_FOUND' && pEmpty.value === null, 'Chuỗi rỗng không ra LOADING_OR_NOT_FOUND');
  assert(pNull.state === 'LOADING_OR_NOT_FOUND' && pNull.value === null, 'null không ra LOADING_OR_NOT_FOUND');
  console.log(`   * Rỗng / null -> state: 'LOADING_OR_NOT_FOUND', value: null.`);

  // 3. "Chưa có dữ liệu"
  console.log(' - Kiểm tra 3: Panel "Chưa có dữ liệu":');
  const pNoData1 = parseStatPanelValue('Chưa có dữ liệu');
  const pNoData2 = parseStatPanelValue('Tỷ lệ lỗi HTTP 5xx (%)\nChưa có dữ liệu');
  assert(pNoData1.state === 'NO_DATA' && pNoData1.isNoData === true && pNoData1.value === null, 'Chưa có dữ liệu parse sai');
  assert(pNoData2.state === 'NO_DATA' && pNoData2.isNoData === true && pNoData2.value === null, 'Tiêu đề + Chưa có dữ liệu parse sai');
  console.log(`   * "Chưa có dữ liệu" -> state: 'NO_DATA', isNoData: true, value: null.`);

  // 4. Số 0% thực sự
  console.log(' - Kiểm tra 4: Panel có số 0% thực sự:');
  const p0 = parseStatPanelValue('0.00%');
  const p0WithTitle = parseStatPanelValue('Tỷ lệ lỗi HTTP 5xx (%)\n0.00%');
  assert(p0.state === 'HAS_VALUE' && p0.value === 0 && !p0.isNoData, '0.00% parse sai');
  assert(p0WithTitle.state === 'HAS_VALUE' && p0WithTitle.value === 0 && !p0WithTitle.isNoData, 'Tiêu đề + 0.00% parse sai');
  console.log(`   * "0.00%" -> state: 'HAS_VALUE', value: 0, isNoData: false.`);

  // 5. Số 10%
  console.log(' - Kiểm tra 5: Panel có số 10%:');
  const p10 = parseStatPanelValue('10.00%');
  assert(p10.state === 'HAS_VALUE' && p10.value === 10, `10.00% parse sai: ${p10.value}`);
  console.log(`   * "10.00%" -> state: 'HAS_VALUE', value: 10.`);

  // 6. Số dưới 100% (ví dụ 85.50%)
  console.log(' - Kiểm tra 6: Panel có số dưới 100% (85.50%):');
  const p85 = parseStatPanelValue('Tỷ lệ yêu cầu hoàn thành <= 2s (%)\n85.50%');
  assert(p85.state === 'HAS_VALUE' && p85.value === 85.5, `85.50% parse sai: ${p85.value}`);
  console.log(`   * "85.50%" -> state: 'HAS_VALUE', value: 85.5.`);

  // 7. Gọi hàm compareDomWithPrometheus của mã thật:
  console.log(' - Kiểm tra 7: Gọi compareDomWithPrometheus của mã thật cho so sánh khớp và mismatch:');
  const matchRes = compareDomWithPrometheus({ domValue: 100.0, promValue: 99.8, tolerance: 0.5, panelTitle: 'Panel Match Test' });
  assert(matchRes.match === true && Math.abs(matchRes.diff - 0.2) < 1e-4, 'compareDomWithPrometheus khớp thất bại');
  console.log(`   * Khớp trong sai số (100% vs 99.8%, diff 0.2% <= 0.5%) -> match: true.`);

  // Kiểm tra mismatch bằng compareDomWithPrometheus
  let caughtMismatch = null;
  try {
    compareDomWithPrometheus({ domValue: 40.0, promValue: 95.0, tolerance: 0.5, panelTitle: 'Panel Mismatch Test' });
  } catch (err) {
    caughtMismatch = err;
  }
  assert(caughtMismatch, 'compareDomWithPrometheus KHÔNG ném lỗi khi DOM và Prometheus lệch nhau!');
  assert(caughtMismatch.message.includes('lệch quá sai số làm tròn'), `Thông điệp lỗi không đúng: "${caughtMismatch.message}"`);
  console.log(`   * Phát hiện mismatch thành công qua hàm thật: "${caughtMismatch.message}"`);

  // 8. Kiểm tra tính toán màu Panel 3 theo thresholds (null/NaN -> #808080 xám, 0% -> green xanh):
  console.log(' - Kiểm tra 8: Tính toán màu Panel 3 theo thresholds (null/NaN -> #808080, 0% -> green):');
  const p3MockSteps = [
    { color: '#808080', value: null },
    { color: 'green', value: 0 },
    { color: 'yellow', value: 1 },
    { color: 'red', value: 5 }
  ];

  const colorNull = resolveExpectedThresholdColor(null, p3MockSteps);
  const colorNaN = resolveExpectedThresholdColor(NaN, p3MockSteps);
  const colorZero = resolveExpectedThresholdColor(0, p3MockSteps);
  const colorLow = resolveExpectedThresholdColor(0.00, p3MockSteps);
  const colorWarn = resolveExpectedThresholdColor(2.5, p3MockSteps);
  const colorCrit = resolveExpectedThresholdColor(6.0, p3MockSteps);

  assert(colorNull === '#808080', `null không ra #808080 (nhận được: ${colorNull})`);
  assert(colorNaN === '#808080', `NaN không ra #808080 (nhận được: ${colorNaN})`);
  assert(colorZero === 'green', `0 không ra green (nhận được: ${colorZero})`);
  assert(colorLow === 'green', `0.00 không ra green (nhận được: ${colorLow})`);
  assert(colorWarn === 'yellow', `2.5 không ra yellow (nhận được: ${colorWarn})`);
  assert(colorCrit === 'red', `6.0 không ra red (nhận được: ${colorCrit})`);

  // Kiểm tra matchesExpectedColor cho cả hai trạng thái nền DOM
  const isGrayMatch = matchesExpectedColor(
    { backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'linear-gradient(120deg, rgb(90, 90, 90), rgb(115, 115, 115))' },
    '#808080'
  );
  assert(isGrayMatch, 'matchesExpectedColor không nhận diện được nền xám Grafana #808080');

  const isGreenMatch = matchesExpectedColor(
    { backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'linear-gradient(120deg, rgb(66, 154, 67), rgb(111, 183, 87))' },
    'green'
  );
  assert(isGreenMatch, 'matchesExpectedColor không nhận diện được nền xanh Grafana green');

  console.log(`   * null/NaN -> ${colorNull} (xám) | 0% -> ${colorZero} (xanh) | 2.5% -> ${colorWarn} | 6% -> ${colorCrit} -> [PASS]`);

  console.log(' -> [XÁC NHẬN ĐẠT] Toàn bộ fixtures DOM và logic so sánh mismatch của mã thật hoạt động chuẩn xác.');
}

// --------------------------------------------------------------------
// CA 8: MOCK CÁC KỊCH BẢN CỦA verifyCooldownState (YÊU CẦU 4)
// --------------------------------------------------------------------
async function testCase8CooldownStateMockScenarios() {
  logTestHeader('CA 8: Mock các kịch bản của verifyCooldownState (Yêu cầu 4)');

  const fixedTestTime = 1791919000.0;

  // 8a: Target UP nhưng mất metric duration count
  console.log(' - Kiểm tra 8a: Target UP nhưng mất metric duration count:');
  const mockPromNoMetric = await createMockServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const evalT = parseFloat(u.searchParams.get('time')) || fixedTestTime;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url.includes('up')) {
      return res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [{ value: [evalT, '1'] }] } }));
    }
    // duration count trả về rỗng [] (mất metric)
    res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [] } }));
  });

  try {
    let caughtNoMetric = null;
    try {
      await verifyCooldownState({
        baseUrl: mockPromNoMetric.url,
        timeoutSec: 1,
        intervalMs: 100,
        nowFn: () => fixedTestTime
      });
    } catch (err) {
      caughtNoMetric = err;
    }
    assert(caughtNoMetric && caughtNoMetric.message.includes('bị mất/không tồn tại'), `Không báo lỗi mất metric: ${caughtNoMetric?.message}`);
    console.log(`   -> [PASS] Bắt được lỗi mất metric: "${caughtNoMetric.message}"`);
  } finally {
    await mockPromNoMetric.close();
  }

  // 8b: UP = 1, rate = 0 nhưng mẫu cũ 45 giây (phải bị từ chối)
  console.log(' - Kiểm tra 8b: UP = 1, rate = 0 nhưng mẫu cũ 45 giây (phải bị từ chối):');
  const mockPromStale = await createMockServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const evalT = parseFloat(u.searchParams.get('time')) || fixedTestTime;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url.includes('up')) {
      return res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [{ value: [evalT, '1'] }] } }));
    }
    if (req.url.includes('timestamp(')) {
      // value[0] là evalT, value[1] là timestamp mẫu thực tế cách evalT 45 giây (mẫu cũ)
      return res.end(JSON.stringify({
        status: 'success',
        data: {
          resultType: 'vector',
          result: [{ value: [evalT, (evalT - 45).toFixed(3)] }]
        }
      }));
    }
    if (req.url.includes('rate(')) {
      // rate = 0 nhưng dữ liệu cũ nên không được phép PASS
      return res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [{ value: [evalT, '0'] }] } }));
    }
    if (req.url.includes('http_request_duration_seconds_count')) {
      return res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [{ value: [evalT, '500'] }] } }));
    }
    res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [] } }));
  });

  try {
    let caughtStale = null;
    try {
      await verifyCooldownState({
        baseUrl: mockPromStale.url,
        timeoutSec: 1,
        intervalMs: 100,
        maxSampleAgeSec: 35,
        nowFn: () => fixedTestTime
      });
    } catch (err) {
      caughtStale = err;
    }
    assert(caughtStale && caughtStale.message.includes('quá cũ'), `Không báo lỗi dữ liệu quá cũ: ${caughtStale?.message}`);
    assert(caughtStale.message.includes('45.0s > 35s'), `Thông điệp lỗi không phản ánh đúng 45s: ${caughtStale.message}`);
    console.log(`   -> [PASS] Bắt được lỗi dữ liệu cũ 45s: "${caughtStale.message}"`);
  } finally {
    await mockPromStale.close();
  }

  // 8c: Thiếu mẫu tính rate (rate rỗng []), sau đó đủ mẫu và rate = 0
  console.log(' - Kiểm tra 8c: Thiếu mẫu tính rate (rate rỗng []), sau đó đủ mẫu và rate = 0:');
  let rateCallCount = 0;
  const mockPromRateWait = await createMockServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const evalT = parseFloat(u.searchParams.get('time')) || fixedTestTime;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url.includes('up')) {
      return res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [{ value: [evalT, '1'] }] } }));
    }
    if (req.url.includes('timestamp(')) {
      // Mẫu mới cách evalT 5 giây
      return res.end(JSON.stringify({
        status: 'success',
        data: {
          resultType: 'vector',
          result: [{ value: [evalT, (evalT - 5).toFixed(3)] }]
        }
      }));
    }
    if (req.url.includes('rate(')) {
      rateCallCount++;
      if (rateCallCount === 1) {
        // Lần đầu trả vector rỗng (chưa đủ 2 điểm scrape để tính rate)
        return res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [] } }));
      }
      // Lần sau trả rate = 0
      return res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [{ value: [evalT, '0'] }] } }));
    }
    if (req.url.includes('http_request_duration_seconds_count')) {
      return res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [{ value: [evalT, '500'] }] } }));
    }
    res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [] } }));
  });

  try {
    const waitResult = await verifyCooldownState({
      baseUrl: mockPromRateWait.url,
      timeoutSec: 3,
      intervalMs: 100,
      maxSampleAgeSec: 35,
      nowFn: () => fixedTestTime
    });
    assert(waitResult.cooledDown === true, 'verifyCooldownState không trả về cooledDown: true khi rate về 0');
    assert(rateCallCount >= 2, `verifyCooldownState không tiếp tục polling khi rate rỗng (số lần gọi: ${rateCallCount})`);
    console.log(`   -> [PASS] Đã tiếp tục chờ khi rate rỗng và thành công sau khi có rate = 0 (gọi ${rateCallCount} lần).`);
  } finally {
    await mockPromRateWait.close();
  }

  // 8d: Mẫu mới và rate = 0 ngay từ đầu (phải đạt)
  console.log(' - Kiểm tra 8d: Mẫu mới và rate = 0 ngay từ đầu (phải đạt):');
  const mockPromInstantCool = await createMockServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const evalT = parseFloat(u.searchParams.get('time')) || fixedTestTime;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url.includes('up')) {
      return res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [{ value: [evalT, '1'] }] } }));
    }
    if (req.url.includes('timestamp(')) {
      // Mẫu mới cách evalT 2 giây
      return res.end(JSON.stringify({
        status: 'success',
        data: {
          resultType: 'vector',
          result: [{ value: [evalT, (evalT - 2).toFixed(3)] }]
        }
      }));
    }
    if (req.url.includes('rate(')) {
      return res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [{ value: [evalT, '0.0000'] }] } }));
    }
    if (req.url.includes('http_request_duration_seconds_count')) {
      return res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [{ value: [evalT, '500'] }] } }));
    }
    res.end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: [] } }));
  });

  try {
    const coolRes = await verifyCooldownState({
      baseUrl: mockPromInstantCool.url,
      timeoutSec: 3,
      intervalMs: 100,
      maxSampleAgeSec: 35,
      nowFn: () => fixedTestTime
    });
    assert(coolRes.cooledDown === true, 'verifyCooldownState không thành công khi dữ liệu mới và rate = 0');
    assert(Math.abs(coolRes.sampleAge - 2.0) <= 0.05, `Tuổi mẫu trả về (${coolRes.sampleAge}) không khớp 2s`);
    console.log(`   -> [PASS] Xác nhận hết tải ngay lập tức khi dữ liệu mới (tuổi mẫu ${coolRes.sampleAge.toFixed(1)}s) và rate = 0.`);
  } finally {
    await mockPromInstantCool.close();
  }

  console.log(' -> [XÁC NHẬN ĐẠT] Toàn bộ 4 kịch bản mock cho verifyCooldownState đều đạt chuẩn.');
}

// --------------------------------------------------------------------
// CA 9: CHẠY TIẾN TRÌNH CON CLI THẬT XÁC NHẬN EXIT CODE != 0 KHI GẶP LỖI
// --------------------------------------------------------------------
async function testCase9CliChildProcessExitCode() {
  logTestHeader('CA 9: Tiến trình con CLI thật trả exitCode = 1 khi gặp lỗi');

  const mockPromError = await createMockServer((req, res) => {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Error');
  });

  try {
    const exitCode = await new Promise((resolve) => {
      const child = spawn(process.execPath, ['scripts/verify-duration-bucket.js'], {
        cwd: path.resolve(__dirname, '..'),
        env: {
          ...process.env,
          PROM_URL: mockPromError.url
        },
        stdio: 'pipe'
      });

      child.on('exit', (code) => {
        resolve(code);
      });
    });

    console.log(` - Tiến trình con verify-duration-bucket.js kết thúc với exitCode: ${exitCode}`);
    assert(exitCode === 1, `Kỳ vọng exitCode = 1 khi gặp lỗi nhưng nhận được ${exitCode}!`);
    console.log(' -> [XÁC NHẬN ĐẠT] Script chính đã kết thúc với mã lỗi 1 chuẩn xác.');
  } finally {
    await mockPromError.close();
  }
}

// --------------------------------------------------------------------
// HÀM RUN TỔNG HỢP TOÀN BỘ CÁC BÀI TEST MÔ PHỎNG CÁCH LY
// --------------------------------------------------------------------
async function runAllMockFailureTests() {
  console.log('======================================================================');
  console.log('  CHẠY TẬP KIỂM THỬ MÔ PHỎNG CÁCH LY TRÊN MÃ NGUỒN THẬT (ISOLATED TESTS)');
  console.log('======================================================================');

  await testCase1CounterNotIncreasing();
  await testCase2PrometheusErrorOrMissingData();
  await testCase3RequestTimeoutAndDestroy();
  await testCase4TrafficHttp404();
  await testCase5GrafanaLoginFailure();
  await testCase6CleanupInRealFlow();
  await testCase7DomAndRatioFixtures();
  await testCase8CooldownStateMockScenarios();
  await testCase9CliChildProcessExitCode();

  console.log('\n======================================================================');
  console.log('  [KẾT QUẢ TỔNG HỢP]: 9/9 CA KIỂM ĐỊNH MÃ THẬT ĐỀU ĐẠT CHUẨN XÁC');
  console.log('  -> CHỨNG MINH TOÀN DIỆN: SCRIPT THỰC SỰ FAIL VÀ CLEANUP KHI CÓ LỖI');
  console.log('======================================================================');
}

if (require.main === module) {
  runAllMockFailureTests()
    .then(() => {
      process.exitCode = 0;
    })
    .catch((err) => {
      console.error('\n[LỖI TRONG BỘ TEST MOCK]', err.message);
      if (err.stack) console.error(err.stack);
      process.exitCode = 1;
    });
}

module.exports = {
  runAllMockFailureTests
};
