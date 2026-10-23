/**
 * scripts/monitoring-common.js
 * 
 * Module dùng chung cho bộ kiểm thử monitoring của POS Store:
 * 1. HTTP Client có timeout thực sự (hủy request bằng req.destroy khi hết hạn, dọn listener/timer).
 * 2. Prometheus Client với kiểm tra Number.isFinite và xử lý vector rỗng / thiếu dữ liệu.
 * 3. Phân tích giá trị và màu sắc stat panel Grafana (phân biệt 0% và "Chưa có dữ liệu", phân tích threshold).
 * 4. Xác nhận trạng thái hết tải chính xác (bảo đảm target vẫn UP và rate count bằng 0/rỗng).
 */

const http = require('http');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) {
    const err = new Error(`[ASSERTION FAILED] ${message}`);
    err.isAssertion = true;
    throw err;
  }
}

/**
 * Thực hiện HTTP request có timeout thực sự.
 * Khi timeout, request sẽ bị hủy ngay lập tức bằng req.destroy() và reject lỗi.
 */
function httpRequest(options, postData = null, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let urlObj;
    if (typeof options === 'string') {
      try {
        urlObj = new URL(options);
      } catch (e) {
        return reject(new Error(`Invalid URL: ${options}`));
      }
    } else if (options instanceof URL) {
      urlObj = options;
    } else if (options && typeof options === 'object' && options.url) {
      try {
        urlObj = new URL(options.url);
      } catch (e) {
        return reject(new Error(`Invalid URL: ${options.url}`));
      }
    }

    const reqOpts = urlObj ? {
      protocol: urlObj.protocol,
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: (options && options.method) || (postData ? 'POST' : 'GET'),
      agent: false,
      headers: {
        'Connection': 'close',
        ...(options && options.headers ? options.headers : {})
      }
    } : { agent: false, ...options };

    if (!reqOpts.headers) {
      reqOpts.headers = {};
    }
    if (!reqOpts.headers['Connection'] && !reqOpts.headers['connection']) {
      reqOpts.headers['Connection'] = 'close';
    }

    if (postData) {
      reqOpts.method = reqOpts.method || 'POST';
      if (!reqOpts.headers['Content-Length'] && !reqOpts.headers['content-length']) {
        reqOpts.headers['Content-Length'] = Buffer.byteLength(postData);
      }
    }

    let settled = false;
    let timer = null;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const req = http.request(reqOpts, (res) => {
      let data = '';
      res.on('data', chunk => {
        data += chunk;
      });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data,
          ok: res.statusCode >= 200 && res.statusCode < 400
        });
      });
      res.on('error', (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`HTTP Response error: ${err.message}`));
      });
    });

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const targetStr = urlObj ? urlObj.href : `${reqOpts.hostname || 'localhost'}:${reqOpts.port || 80}${reqOpts.path || ''}`;
      req.destroy(new Error(`REQUEST_TIMEOUT: Quá thời gian chờ ${timeoutMs}ms khi kết nối tới ${targetStr}`));
      reject(new Error(`REQUEST_TIMEOUT: Quá thời gian chờ ${timeoutMs}ms khi kết nối tới ${targetStr}`));
    }, timeoutMs);

    req.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

/**
 * Truy vấn Prometheus API với timeout thực sự và parse kết quả an toàn.
 * Hỗ trợ retry tự động khi gặp lỗi socket tức thời (ECONNRESET / socket hang up).
 */
async function queryPrometheus({ baseUrl = 'http://127.0.0.1:9090', query, time = null, timeoutMs = 10000, retries = 2 }) {
  assert(query, 'Truy vấn PromQL không được để trống.');
  let url = `${baseUrl.replace(/\/+$/, '')}/api/v1/query?query=${encodeURIComponent(query)}`;
  if (time !== null) {
    url += `&time=${encodeURIComponent(time)}`;
  }

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await httpRequest(url, null, timeoutMs);
      if (res.statusCode !== 200) {
        throw new Error(`Prometheus HTTP ${res.statusCode}: ${res.data}`);
      }

      let parsed;
      try {
        parsed = JSON.parse(res.data);
      } catch (e) {
        throw new Error(`Prometheus response parse error: ${e.message} - Data: ${res.data}`);
      }

      if (parsed.status !== 'success') {
        throw new Error(`Prometheus query status "${parsed.status}": ${parsed.error || res.data}`);
      }

      return parsed;
    } catch (err) {
      lastErr = err;
      // Nếu là timeout hoặc lỗi cố ý giả lập thì không retry
      if (err.message && err.message.includes('REQUEST_TIMEOUT')) {
        throw err;
      }
      if (err.message && (err.message.includes('HTTP 500') || err.message.includes('status "error"'))) {
        throw err;
      }
      // Retry nếu gặp ECONNRESET hoặc network transient error
      if (attempt < retries && (err.message.includes('ECONNRESET') || err.message.includes('socket hang up') || err.code === 'ECONNRESET')) {
        await sleep(300);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/**
 * Trích xuất một giá trị số từ kết quả Prometheus và kiểm tra Number.isFinite().
 * Không ép dữ liệu thiếu thành 0.
 */
function extractMetricValue(promResponse, desc) {
  assert(promResponse && promResponse.data, `Dữ liệu Prometheus cho "${desc}" không hợp lệ.`);
  const result = promResponse.data.result;
  assert(Array.isArray(result) && result.length > 0, `Không có dữ liệu cho "${desc}" (vector rỗng). Không ép thiếu thành 0.`);
  
  const valEntry = result[0].value;
  assert(Array.isArray(valEntry) && valEntry.length >= 2, `Cấu trúc value cho "${desc}" không hợp lệ.`);
  
  const valStr = valEntry[1];
  assert(valStr !== undefined && valStr !== null && valStr !== '', `Giá trị cho "${desc}" bị thiếu trong kết quả Prometheus.`);
  
  const num = Number(valStr);
  assert(Number.isFinite(num), `Giá trị "${valStr}" cho "${desc}" không phải là số hữu hạn hợp lệ (nhận được ${num}).`);
  
  return num;
}

/**
 * Phân tích giá trị hiển thị từ Stat Panel DOM của Grafana.
 * Phân biệt chính xác giữa:
 * - Không tìm thấy / đang tải: { state: 'LOADING_OR_NOT_FOUND', value: null }
 * - Tiêu đề (không đọc số 5 trong 5xx hay 2 trong 2s): { state: 'TITLE_ONLY', value: null }
 * - "Chưa có dữ liệu" (isNoData: true, value: null)
 * - Giá trị số thực sự 0% hoặc 0.00% (state: 'HAS_VALUE', isNoData: false, value: 0)
 * - Các giá trị số khác (state: 'HAS_VALUE', isNoData: false, value: number)
 */
function parseStatPanelValue(rawText) {
  if (rawText === null || rawText === undefined || typeof rawText !== 'string') {
    return { state: 'LOADING_OR_NOT_FOUND', isNoData: false, value: null, rawText: '' };
  }

  let trimmed = rawText.trim();
  if (!trimmed) {
    return { state: 'LOADING_OR_NOT_FOUND', isNoData: false, value: null, rawText: '' };
  }

  // Chuẩn hóa trường hợp số và đơn vị % bị tách dòng trong DOM Grafana (ví dụ "0.00\n%" -> "0.00%")
  trimmed = trimmed.replace(/([-+]?[0-9]*\.?[0-9]+)\s*\n\s*%/g, '$1%');

  // Tách các dòng để xử lý
  const lines = trimmed.split('\n').map(l => l.trim()).filter(Boolean);

  // Định nghĩa kiểm tra tiêu đề hoặc nhãn mô tả
  const isTitleLine = (line) => {
    return line.includes('Tỷ lệ lỗi HTTP') ||
           line.includes('Tỷ lệ yêu cầu hoàn thành') ||
           line.includes('Target pos_store') ||
           line.includes('RPS hiện tại') ||
           line.includes('Ghi chú') ||
           line === '5xx (%)' ||
           line === '<= 2s (%)';
  };

  // Kiểm tra "Chưa có dữ liệu" hoặc "No data"
  if (trimmed === 'Chưa có dữ liệu' || trimmed === 'No data' ||
      lines[lines.length - 1] === 'Chưa có dữ liệu' || lines[lines.length - 1] === 'No data') {
    return { state: 'NO_DATA', isNoData: true, value: null, rawText: trimmed };
  }

  // Lọc các dòng không phải là tiêu đề
  const contentLines = lines.filter(l => !isTitleLine(l));

  // Nếu không còn dòng nào sau khi loại trừ tiêu đề -> Chỉ có tiêu đề, chưa có giá trị
  if (contentLines.length === 0) {
    return { state: 'TITLE_ONLY', isNoData: false, value: null, rawText: trimmed };
  }

  // Lấy dòng ứng viên cuối cùng
  const candidate = contentLines[contentLines.length - 1];

  // Kiểm tra định dạng phần trăm chặt chẽ: ^[-+]?[0-9]*\.?[0-9]+\s*%$
  const percentMatch = candidate.match(/^([-+]?[0-9]*\.?[0-9]+)\s*%$/);
  if (percentMatch) {
    const num = parseFloat(percentMatch[1]);
    if (Number.isFinite(num)) {
      return { state: 'HAS_VALUE', isNoData: false, value: num, rawText: trimmed };
    }
  }

  // Kiểm tra định dạng số đơn thuần chặt chẽ: ^[-+]?[0-9]*\.?[0-9]+$
  const numberMatch = candidate.match(/^([-+]?[0-9]*\.?[0-9]+)$/);
  if (numberMatch) {
    const num = parseFloat(numberMatch[1]);
    if (Number.isFinite(num)) {
      return { state: 'HAS_VALUE', isNoData: false, value: num, rawText: trimmed };
    }
  }

  // Nếu chứa từ khóa tiêu đề mà không khớp định dạng số
  if (lines.some(isTitleLine)) {
    return { state: 'TITLE_ONLY', isNoData: false, value: null, rawText: trimmed };
  }

  return { state: 'INVALID', isNoData: false, value: null, rawText: trimmed };
}

/**
 * So sánh giá trị DOM của Grafana với giá trị Prometheus với sai số làm tròn cho phép.
 * Hàm dùng chung cho cả kịch bản chính và mock test để tránh sao chép logic.
 */
function compareDomWithPrometheus({ domValue, promValue, tolerance = 0.5, panelTitle = '' }) {
  assert(Number.isFinite(domValue), `Giá trị DOM của "${panelTitle}" (${domValue}) không phải số hữu hạn hợp lệ!`);
  assert(Number.isFinite(promValue), `Giá trị Prometheus của "${panelTitle}" (${promValue}) không phải số hữu hạn hợp lệ!`);
  const diff = Math.abs(domValue - promValue);
  assert(diff <= tolerance, `Giá trị Grafana Panel "${panelTitle}" (${domValue}%) lệch quá sai số làm tròn ${tolerance}% so với Prometheus (${promValue}%, diff: ${diff.toFixed(2)}%).`);
  return { match: true, diff };
}

/**
 * Tính toán màu kỳ vọng dựa vào cấu hình thresholds của Grafana panel.
 */
function resolveExpectedThresholdColor(value, thresholdSteps = []) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    // Trạng thái thiếu dữ liệu (no value)
    const nullStep = thresholdSteps.find(s => s.value === null || s.value === undefined);
    return nullStep ? nullStep.color : '#808080';
  }

  // Sắp xếp các bước có số tăng dần
  const numericSteps = thresholdSteps
    .filter(s => s.value !== null && s.value !== undefined && Number.isFinite(Number(s.value)))
    .map(s => ({ ...s, value: Number(s.value) }))
    .sort((a, b) => a.value - b.value);

  if (numericSteps.length === 0) {
    return '#808080';
  }

  // Tìm bước có value <= value đánh giá với value lớn nhất
  let matchedColor = numericSteps[0].color;
  for (const step of numericSteps) {
    if (value >= step.value) {
      matchedColor = step.color;
    } else {
      break;
    }
  }

  return matchedColor;
}

/**
 * Kiểm tra màu sắc thực tế từ window.getComputedStyle() trên phần tử stat panel.
 * Hỗ trợ cả backgroundColor đơn thuần và backgroundImage linear-gradient của Grafana.
 */
function matchesExpectedColor(computedStyle, expectedColorNameOrHex) {
  if (!computedStyle) return false;

  const bg = computedStyle.backgroundColor || '';
  const bgImg = computedStyle.backgroundImage || '';
  const combined = `${bg} ${bgImg}`.toLowerCase();

  const exp = (expectedColorNameOrHex || '').toLowerCase();

  // 1. Kiểm tra màu xám (#808080 / gray)
  if (exp === '#808080' || exp === 'gray' || exp === 'grey') {
    if (combined.includes('808080') || combined.includes('gray') || combined.includes('grey')) {
      return true;
    }
    // Grafana dark mode thường tạo gradient từ #808080 thành rgb(90, 90, 90) -> rgb(115, 115, 115) hoặc rgb(128, 128, 128)
    if (combined.includes('90, 90, 90') || combined.includes('115, 115, 115') || combined.includes('128, 128, 128')) {
      return true;
    }
    // Trích xuất các kênh RGB để kiểm tra tính trung tính (R, G, B xấp xỉ nhau)
    const rgbMatches = combined.matchAll(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/g);
    for (const m of rgbMatches) {
      const r = parseInt(m[1]), g = parseInt(m[2]), b = parseInt(m[3]);
      if (Math.abs(r - g) <= 10 && Math.abs(g - b) <= 10 && r >= 40 && r <= 210) {
        return true;
      }
    }
    return false;
  }

  // 2. Kiểm tra màu xanh lá (green)
  if (exp === 'green' || exp === '#73bf69' || exp === '#56a64b') {
    if (combined.includes('green') || combined.includes('73bf69')) {
      return true;
    }
    // Các dải gradient green của Grafana (rgb(66, 154, 67), rgb(111, 183, 87), rgb(115, 191, 105))
    if (combined.includes('66, 154, 67') || combined.includes('111, 183, 87') || combined.includes('115, 191, 105') || combined.includes('115, 192, 105')) {
      return true;
    }
    const rgbMatches = combined.matchAll(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/g);
    for (const m of rgbMatches) {
      const r = parseInt(m[1]), g = parseInt(m[2]), b = parseInt(m[3]);
      if (g > r + 15 && g > b + 15 && g >= 100) {
        return true;
      }
    }
    return false;
  }

  // 3. Kiểm tra màu vàng (yellow)
  if (exp === 'yellow' || exp === '#fade2a' || exp === '#f2cc0c') {
    if (combined.includes('yellow') || combined.includes('fade2a')) {
      return true;
    }
    const rgbMatches = combined.matchAll(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/g);
    for (const m of rgbMatches) {
      const r = parseInt(m[1]), g = parseInt(m[2]), b = parseInt(m[3]);
      if (r >= 150 && g >= 150 && b <= 120) {
        return true;
      }
    }
    return false;
  }

  // 4. Kiểm tra màu đỏ (red)
  if (exp === 'red' || exp === '#f2495c' || exp === '#e02f44') {
    if (combined.includes('red') || combined.includes('f2495c') || combined.includes('e02f44')) {
      return true;
    }
    const rgbMatches = combined.matchAll(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/g);
    for (const m of rgbMatches) {
      const r = parseInt(m[1]), g = parseInt(m[2]), b = parseInt(m[3]);
      if (r > g + 30 && r > b + 30 && r >= 140) {
        return true;
      }
    }
    return false;
  }

  return combined.includes(exp);
}

/**
 * Xác nhận trạng thái hết tải thực tế.
 * Tuân thủ quy cách Prometheus:
 * 1. Cố định cùng thời điểm T cho mọi truy vấn (UP, metric, timestamp, rate) trong mỗi vòng polling.
 * 2. Target pos_store vẫn UP (up == 1) tại thời điểm T.
 * 3. Metric duration count tồn tại tại thời điểm T.
 * 4. Truy vấn timestamp(http_request_duration_seconds_count{job="pos_store"}) đọc timestamp mẫu thực tế từ value[1] (không dùng value[0]).
 *    Tính sampleAge = T - sampleTimestamp, kiểm tra hữu hạn, không âm và <= maxSampleAgeSec (35s). Kiểm tra toàn bộ series.
 * 5. Tốc độ count rate trong cửa sổ 1m tại thời điểm T có giá trị hữu hạn, không âm và <= 1e-4.
 * 6. Nếu rate rỗng do thiếu mẫu, tiếp tục chờ trong timeout; nếu metric mất hoặc dữ liệu quá cũ thì báo lỗi, không ép thành 0.
 */
async function verifyCooldownState({
  baseUrl = 'http://127.0.0.1:9090',
  maxSampleAgeSec = 35,
  timeoutSec = 75,
  intervalMs = 4000,
  nowFn = () => Date.now() / 1000
}) {
  const startTime = Date.now();
  const upExpr = 'up{job="pos_store"}';
  const countExpr = 'http_request_duration_seconds_count{job="pos_store"}';
  const timestampExpr = 'timestamp(http_request_duration_seconds_count{job="pos_store"})';
  const rateExpr = 'sum(rate(http_request_duration_seconds_count{job="pos_store"}[1m]))';

  while ((Date.now() - startTime) < timeoutSec * 1000) {
    await sleep(intervalMs);

    // Cố định cùng một thời điểm T cho các truy vấn trong vòng polling này
    const T = typeof nowFn === 'function' ? nowFn() : (Date.now() / 1000);
    assert(Number.isFinite(T), `Thời điểm đánh giá T (${T}) không phải số hữu hạn!`);

    // 1. Kiểm tra target pos_store UP tại thời điểm T
    const qUp = await queryPrometheus({ baseUrl, query: upExpr, time: T });
    const upVal = extractMetricValue(qUp, 'up{job="pos_store"}');
    assert(upVal === 1, `Target pos_store không UP (up = ${upVal}) trong quá trình chờ hết tải!`);

    // 2. Xác nhận metric duration count vẫn tồn tại tại thời điểm T
    const qCount = await queryPrometheus({ baseUrl, query: countExpr, time: T });
    const countResults = qCount.data?.result || [];
    assert(countResults.length > 0, 'Metric http_request_duration_seconds_count bị mất/không tồn tại trên Prometheus!');

    // 3. Truy vấn timestamp(...) đọc timestamp mẫu thực tế từ value[1] tại thời điểm T
    const qTimestamp = await queryPrometheus({ baseUrl, query: timestampExpr, time: T });
    const tsResults = qTimestamp.data?.result || [];
    assert(tsResults.length > 0, 'Truy vấn timestamp(http_request_duration_seconds_count) trả về vector rỗng!');

    let maxSampleAge = 0;
    let actualSampleTimestamp = null;

    // Kiểm tra tất cả series trả về
    for (const series of tsResults) {
      const valEntry = series.value;
      assert(Array.isArray(valEntry) && valEntry.length >= 2, 'Cấu trúc value của kết quả timestamp không hợp lệ!');

      // valEntry[0] là thời điểm đánh giá T, valEntry[1] là timestamp mẫu thực tế từ Prometheus TSDB
      const sampleTs = parseFloat(valEntry[1]);
      assert(Number.isFinite(sampleTs), `Giá trị timestamp mẫu "${valEntry[1]}" không phải số hữu hạn hợp lệ!`);

      let sampleAge = T - sampleTs;
      assert(Number.isFinite(sampleAge), `Tuổi mẫu scrape (${sampleAge}) không phải số hữu hạn!`);

      // Cho phép dung sai vi sai làm tròn dấu chấm động
      if (sampleAge < 0 && sampleAge >= -1e-4) {
        sampleAge = 0;
      }
      assert(sampleAge >= 0, `Tuổi mẫu scrape bị âm bất thường (${sampleAge}s < 0, T: ${T}, sampleTs: ${sampleTs})!`);
      assert(sampleAge <= maxSampleAgeSec, `Dữ liệu scrape quá cũ (${sampleAge.toFixed(1)}s > ${maxSampleAgeSec}s)! Scrape có thể đã dừng hoặc mất kết nối.`);

      if (sampleAge > maxSampleAge) {
        maxSampleAge = sampleAge;
      }
      actualSampleTimestamp = sampleTs;
    }

    // 4. Kiểm tra tốc độ count rate trong cửa sổ 1m tại thời điểm T
    const qRate = await queryPrometheus({ baseUrl, query: rateExpr, time: T });
    const rateResults = qRate.data?.result || [];

    // Nếu rate rỗng do thiếu mẫu, tiếp tục chờ trong timeout (không ép thành 0)
    if (rateResults.length === 0) {
      console.log('    [Cooldown] Chưa đủ mẫu tính rate [1m], tiếp tục chờ...');
      continue;
    }

    const currentRate = parseFloat(rateResults[0].value[1]);
    assert(Number.isFinite(currentRate), `Giá trị rate count "${rateResults[0].value[1]}" không phải số hữu hạn!`);
    assert(currentRate >= 0, `Giá trị rate count bị âm bất thường (${currentRate})!`);

    // Chỉ xác nhận hết tải khi rate count có giá trị hợp lệ bằng 0 (trong sai số số học hợp lý <= 1e-4)
    if (currentRate <= 1e-4) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      return {
        cooledDown: true,
        elapsedSec: parseFloat(elapsed),
        finalRate: currentRate,
        sampleAge: maxSampleAge,
        sampleTimestamp: actualSampleTimestamp,
        evalTimeT: T
      };
    } else {
      console.log(`    [Cooldown] Vẫn còn rate (${currentRate.toFixed(3)} req/s), tiếp tục chờ...`);
    }
  }

  throw new Error(`Quá thời gian ${timeoutSec}s mà lưu lượng chưa về trạng thái hết tải (rate count không về 0)!`);
}

module.exports = {
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
};
