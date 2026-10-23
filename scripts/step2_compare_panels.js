const fs = require('fs');
const path = require('path');

const GRAFANA_API_URL = 'http://127.0.0.1:3030/api/dashboards/uid/pos-store-monitoring-dashboard';
const REPO_DASHBOARD_PATH = path.join(__dirname, '../deploy/monitoring/grafana/dashboards/pos-store-dashboard.json');
const PROVISIONING_DASHBOARD_PATH = 'C:\\grafana\\conf\\provisioning\\dashboards\\pos-store-dashboard.json';

async function fetchFromGrafanaApi() {
  const authHeader = 'Basic ' + Buffer.from('admin:admin').toString('base64');
  const res = await fetch(GRAFANA_API_URL, {
    headers: { 'Authorization': authHeader }
  });
  if (!res.ok) {
    throw new Error(`Grafana API error: HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.dashboard;
}

function extractPanelConfig(panel) {
  if (!panel) return null;
  return {
    id: panel.id,
    title: panel.title,
    expr: panel.targets?.[0]?.expr,
    noValue: panel.fieldConfig?.defaults?.noValue,
    mappings: panel.fieldConfig?.defaults?.mappings,
    thresholds: panel.fieldConfig?.defaults?.thresholds
  };
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function main() {
  console.log('=== BƯỚC 2: SO SÁNH CẤU HÌNH PANEL 3 VÀ PANEL 4 ===\n');

  // 1. Nạp từ Repo
  console.log('1. Đọc file JSON từ Repo:', REPO_DASHBOARD_PATH);
  const repoRaw = JSON.parse(fs.readFileSync(REPO_DASHBOARD_PATH, 'utf8'));
  const repoPanel3 = extractPanelConfig(repoRaw.panels.find(p => p.id === 3));
  const repoPanel4 = extractPanelConfig(repoRaw.panels.find(p => p.id === 4));

  // 2. Nạp từ C:\grafana provisioning
  console.log('2. Đọc file JSON từ C:\\grafana provisioning:', PROVISIONING_DASHBOARD_PATH);
  const provRaw = JSON.parse(fs.readFileSync(PROVISIONING_DASHBOARD_PATH, 'utf8'));
  const provPanel3 = extractPanelConfig(provRaw.panels.find(p => p.id === 3));
  const provPanel4 = extractPanelConfig(provRaw.panels.find(p => p.id === 4));

  // 3. Lấy trực tiếp từ Grafana API
  console.log('3. Lấy cấu hình runtime từ Grafana API:', GRAFANA_API_URL);
  const apiRaw = await fetchFromGrafanaApi();
  const apiPanel3 = extractPanelConfig(apiRaw.panels.find(p => p.id === 3));
  const apiPanel4 = extractPanelConfig(apiRaw.panels.find(p => p.id === 4));

  console.log('\n--- CHI TIẾT CẤU HÌNH PANEL 3 (Tỷ lệ lỗi HTTP 5xx (%)) ---');
  console.log('Repo:');
  console.log(JSON.stringify(repoPanel3, null, 2));

  console.log('\n--- CHI TIẾT CẤU HÌNH PANEL 4 (Tỷ lệ yêu cầu hoàn thành <= 2s (%)) ---');
  console.log('Repo:');
  console.log(JSON.stringify(repoPanel4, null, 2));

  console.log('\n--- SO SÁNH ĐỐI CHIẾU ---');

  // So sánh Panel 3
  const p3ExprMatch = (repoPanel3.expr === provPanel3.expr) && (repoPanel3.expr === apiPanel3.expr);
  const p3NoValMatch = (repoPanel3.noValue === provPanel3.noValue) && (repoPanel3.noValue === apiPanel3.noValue);
  const p3MapMatch = deepEqual(repoPanel3.mappings, provPanel3.mappings) && deepEqual(repoPanel3.mappings, apiPanel3.mappings);
  const p3ThreshMatch = deepEqual(repoPanel3.thresholds, provPanel3.thresholds) && deepEqual(repoPanel3.thresholds, apiPanel3.thresholds);

  console.log('Panel 3 (5xx):');
  console.log(`  - Biểu thức (expr): ${p3ExprMatch ? 'KHỚP TUYỆT ĐỐI (PASS)' : 'KHÁC NHAU (FAIL)'}`);
  console.log(`    Repo / Prov / API expr: ${repoPanel3.expr}`);
  console.log(`  - noValue: "${repoPanel3.noValue}" -> ${p3NoValMatch ? 'KHỚP TUYỆT ĐỐI (PASS)' : 'KHÁC NHAU (FAIL)'}`);
  console.log(`  - Mappings: ${p3MapMatch ? 'KHỚP TUYỆT ĐỐI (PASS)' : 'KHÁC NHAU (FAIL)'}`);
  console.log(`  - Thresholds: ${p3ThreshMatch ? 'KHỚP TUYỆT ĐỐI (PASS)' : 'KHÁC NHAU (FAIL)'}`);

  // So sánh Panel 4
  const p4ExprMatch = (repoPanel4.expr === provPanel4.expr) && (repoPanel4.expr === apiPanel4.expr);
  const p4NoValMatch = (repoPanel4.noValue === provPanel4.noValue) && (repoPanel4.noValue === apiPanel4.noValue);
  const p4MapMatch = deepEqual(repoPanel4.mappings, provPanel4.mappings) && deepEqual(repoPanel4.mappings, apiPanel4.mappings);
  const p4ThreshMatch = deepEqual(repoPanel4.thresholds, provPanel4.thresholds) && deepEqual(repoPanel4.thresholds, apiPanel4.thresholds);

  console.log('\nPanel 4 (<= 2s):');
  console.log(`  - Biểu thức (expr): ${p4ExprMatch ? 'KHỚP TUYỆT ĐỐI (PASS)' : 'KHÁC NHAU (FAIL)'}`);
  console.log(`    Repo / Prov / API expr: ${repoPanel4.expr}`);
  console.log(`  - noValue: "${repoPanel4.noValue}" -> ${p4NoValMatch ? 'KHỚP TUYỆT ĐỐI (PASS)' : 'KHÁC NHAU (FAIL)'}`);
  console.log(`  - Mappings: ${p4MapMatch ? 'KHỚP TUYỆT ĐỐI (PASS)' : 'KHÁC NHAU (FAIL)'}`);
  console.log(`  - Thresholds: ${p4ThreshMatch ? 'KHỚP TUYỆT ĐỐI (PASS)' : 'KHÁC NHAU (FAIL)'}`);

  const allPass = p3ExprMatch && p3NoValMatch && p3MapMatch && p3ThreshMatch &&
                  p4ExprMatch && p4NoValMatch && p4MapMatch && p4ThreshMatch;
  console.log(`\n=> KẾT LUẬN BƯỚC 2: ${allPass ? 'PASS (100% đồng nhất giữa Repo, C:\\grafana Provisioning và Grafana API)' : 'FAIL'}`);

  const evidence = {
    comparison_time: new Date().toISOString(),
    panel_3: {
      repo: repoPanel3,
      provisioning: provPanel3,
      grafana_api: apiPanel3,
      matches: { expr: p3ExprMatch, noValue: p3NoValMatch, mappings: p3MapMatch, thresholds: p3ThreshMatch }
    },
    panel_4: {
      repo: repoPanel4,
      provisioning: provPanel4,
      grafana_api: apiPanel4,
      matches: { expr: p4ExprMatch, noValue: p4NoValMatch, mappings: p4MapMatch, thresholds: p4ThreshMatch }
    },
    overall_result: allPass ? 'PASS' : 'FAIL'
  };

  const outPath = path.join(__dirname, 'evidence_step2_comparison.json');
  fs.writeFileSync(outPath, JSON.stringify(evidence, null, 2), 'utf8');
  console.log(`Đã lưu JSON đối chiếu tại: ${outPath}`);

  const artifactDir = 'C:\\Users\\Dell Precision 5550\\.gemini\\antigravity-ide\\brain\\3a7246d0-4d26-4297-a017-2197f1d2ea10';
  if (fs.existsSync(artifactDir)) {
    fs.writeFileSync(path.join(artifactDir, 'evidence_step2_comparison.json'), JSON.stringify(evidence, null, 2), 'utf8');
  }
}

main().catch(err => {
  console.error('Lỗi thực thi:', err);
  process.exit(1);
});
