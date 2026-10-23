const fs = require('fs');
const path = require('path');

const PROMETHEUS_URL = 'http://127.0.0.1:9090';

async function queryPrometheus(expr, time) {
  const url = `${PROMETHEUS_URL}/api/v1/query?time=${encodeURIComponent(time)}&query=${encodeURIComponent(expr)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from Prometheus for query: ${expr}`);
  }
  return await res.json();
}

async function main() {
  const T = Math.floor(Date.now() / 1000);
  const tIso = new Date(T * 1000).toISOString();
  const tLocal = new Date(T * 1000).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

  console.log(`=== BƯỚC 1: TRUY VẤN PROMETHEUS TẠI THỜI ĐIỂM T ===`);
  console.log(`Thời điểm đánh giá T: ${T} (Unix timestamp)`);
  console.log(`Thời gian ISO: ${tIso}`);
  console.log(`Thời gian Việt Nam (+07:00): ${tLocal}\n`);

  const queries = {
    target_up: {
      name: 'Target pos_store UP',
      expr: 'up{job="pos_store"}'
    },
    duration_count_value: {
      name: 'Metric duration count giá trị',
      expr: 'http_request_duration_seconds_count{job="pos_store"}'
    },
    duration_count_timestamp: {
      name: 'Timestamp mẫu metric duration count',
      expr: 'timestamp(http_request_duration_seconds_count{job="pos_store"})'
    },
    duration_count_rate_1m: {
      name: 'Rate duration count [1m]',
      expr: 'sum(rate(http_request_duration_seconds_count{job="pos_store"}[1m]))'
    },
    panel_3_http_5xx_rate: {
      name: 'Panel 3: Tỷ lệ lỗi HTTP 5xx (%)',
      expr: '((sum(rate(http_requests_total{job="pos_store", status_code=~"5.."}[1m])) or (sum(rate(http_requests_total{job="pos_store"}[1m])) * 0)) / (sum(rate(http_requests_total{job="pos_store"}[1m])) > 0)) * 100'
    },
    panel_4_latency_under_2s: {
      name: 'Panel 4: Tỷ lệ hoàn thành <= 2s (%)',
      expr: '(sum(rate(http_request_duration_seconds_bucket{job="pos_store", le=~"2|2[.]0"}[1m])) / (sum(rate(http_request_duration_seconds_count{job="pos_store"}[1m])) > 0)) * 100'
    }
  };

  const results = {
    evaluation_time: {
      unix_timestamp: T,
      iso_timestamp: tIso,
      local_time_vietnam: tLocal
    },
    queries: {}
  };

  for (const [key, q] of Object.entries(queries)) {
    console.log(`Đang truy vấn [${q.name}]: ${q.expr}`);
    const data = await queryPrometheus(q.expr, T);
    results.queries[key] = {
      name: q.name,
      expr: q.expr,
      response: data
    };
  }

  // Phân tích kết quả
  const upVal = results.queries.target_up.response.data.result?.[0]?.value?.[1];
  const countSamples = results.queries.duration_count_value.response.data.result;
  const countSampleTs = results.queries.duration_count_timestamp.response.data.result?.[0]?.value?.[1];
  const rateCountVal = results.queries.duration_count_rate_1m.response.data.result?.[0]?.value?.[1];
  const p3Result = results.queries.panel_3_http_5xx_rate.response.data.result;
  const p4Result = results.queries.panel_4_latency_under_2s.response.data.result;

  console.log('\n--- KẾT QUẢ ĐỐI CHIẾU ---');
  console.log(`1. Target UP: ${upVal} (${upVal === '1' ? 'PASS: UP = 1' : 'FAIL'})`);

  if (countSampleTs) {
    const sampleTsSec = parseFloat(countSampleTs);
    const ageSec = (T - sampleTsSec).toFixed(3);
    console.log(`2. Metric duration count:`);
    console.log(`   - Số chuỗi metric tồn tại: ${countSamples.length}`);
    console.log(`   - Timestamp mẫu gần nhất: ${sampleTsSec} (${new Date(sampleTsSec * 1000).toISOString()})`);
    console.log(`   - Độ trễ mẫu so với T: ${ageSec}s (Chu kỳ scrape là 15s => ${ageSec <= 15 ? 'PASS: Mẫu còn mới' : 'Chú ý'})`);
  } else {
    console.log('2. Metric duration count: KHÔNG TÌM THẤY');
  }

  console.log(`3. Rate duration count [1m]: ${rateCountVal} (${parseFloat(rateCountVal) === 0 ? 'PASS: = 0' : 'FAIL'})`);
  console.log(`4. Panel 3 (5xx %): Vector rỗng: ${p3Result.length === 0} (Số phần tử: ${p3Result.length}) => ${p3Result.length === 0 ? 'PASS' : 'FAIL'}`);
  console.log(`5. Panel 4 (<= 2s %): Vector rỗng: ${p4Result.length === 0} (Số phần tử: ${p4Result.length}) => ${p4Result.length === 0 ? 'PASS' : 'FAIL'}`);

  const outPath = path.join(__dirname, 'evidence_step1_prometheus_T.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf8');
  console.log(`\nĐã lưu toàn bộ JSON kết quả tại: ${outPath}`);

  // Lưu bản copy vào artifacts
  const artifactDir = 'C:\\Users\\Dell Precision 5550\\.gemini\\antigravity-ide\\brain\\3a7246d0-4d26-4297-a017-2197f1d2ea10';
  if (fs.existsSync(artifactDir)) {
    fs.writeFileSync(path.join(artifactDir, 'evidence_step1_prometheus_T.json'), JSON.stringify(results, null, 2), 'utf8');
  }
}

main().catch(err => {
  console.error('Lỗi thực thi:', err);
  process.exit(1);
});
