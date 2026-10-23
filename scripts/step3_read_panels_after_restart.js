const fs = require('fs');
const path = require('path');

const DASHBOARD_API_URL = 'http://127.0.0.1:3030/api/dashboards/uid/pos-store-monitoring-dashboard';
const REPO_DASHBOARD_PATH = path.join(__dirname, '../deploy/monitoring/grafana/dashboards/pos-store-dashboard.json');

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
  console.log('=== BƯỚC 3: ĐỌC LẠI PANEL 3 VÀ PANEL 4 QUA GRAFANA API SAU KHI RESTART ===\n');

  // 1. Kiểm tra /api/health
  const healthRes = await fetch('http://127.0.0.1:3030/api/health');
  const healthJson = await healthRes.json();
  console.log('1. Grafana Health:', healthRes.status, healthJson);

  // 2. Lấy Dashboard từ API sau restart
  console.log('2. Đang gọi API lấy dashboard sau restart...');
  const authHeader = 'Basic ' + Buffer.from('admin:admin').toString('base64');
  const dashRes = await fetch(DASHBOARD_API_URL, {
    headers: { 'Authorization': authHeader }
  });
  if (!dashRes.ok) throw new Error(`Dashboard API HTTP ${dashRes.status}`);
  const dashData = await dashRes.json();

  const apiPanel3After = extractPanelConfig(dashData.dashboard.panels.find(p => p.id === 3));
  const apiPanel4After = extractPanelConfig(dashData.dashboard.panels.find(p => p.id === 4));

  console.log('\n--- CẤU HÌNH PANEL 3 ĐỌC TỪ API SAU RESTART ---');
  console.log(JSON.stringify(apiPanel3After, null, 2));

  console.log('\n--- CẤU HÌNH PANEL 4 ĐỌC TỪ API SAU RESTART ---');
  console.log(JSON.stringify(apiPanel4After, null, 2));

  // 3. Đọc từ Repo để so sánh
  const repoRaw = JSON.parse(fs.readFileSync(REPO_DASHBOARD_PATH, 'utf8'));
  const repoPanel3 = extractPanelConfig(repoRaw.panels.find(p => p.id === 3));
  const repoPanel4 = extractPanelConfig(repoRaw.panels.find(p => p.id === 4));

  const p3Match = deepEqual(repoPanel3, apiPanel3After);
  const p4Match = deepEqual(repoPanel4, apiPanel4After);

  console.log('\n--- KẾT QUẢ ĐỐI CHIẾU VỚI REPO SAU RESTART ---');
  console.log(`Panel 3 khớp 100% với Repo: ${p3Match ? 'PASS' : 'FAIL'}`);
  console.log(`Panel 4 khớp 100% với Repo: ${p4Match ? 'PASS' : 'FAIL'}`);

  const pass = p3Match && p4Match && healthRes.ok && (healthJson.database === 'ok');
  console.log(`\n=> KẾT LUẬN BƯỚC 3: ${pass ? 'PASS (Khởi động lại độc lập, Health OK, cấu hình giữ nguyên vẹn 100%)' : 'FAIL'}`);

  const evidence = {
    step: 3,
    timestamp: new Date().toISOString(),
    health: { status: healthRes.status, data: healthJson },
    panel_3_match: p3Match,
    panel_4_match: p4Match,
    panel_3: apiPanel3After,
    panel_4: apiPanel4After,
    overall_result: pass ? 'PASS' : 'FAIL'
  };

  const outPath = path.join(__dirname, 'evidence_step3_after_restart.json');
  fs.writeFileSync(outPath, JSON.stringify(evidence, null, 2), 'utf8');
  console.log(`Đã lưu JSON bằng chứng tại: ${outPath}`);

  const artifactDir = 'C:\\Users\\Dell Precision 5550\\.gemini\\antigravity-ide\\brain\\3a7246d0-4d26-4297-a017-2197f1d2ea10';
  if (fs.existsSync(artifactDir)) {
    fs.writeFileSync(path.join(artifactDir, 'evidence_step3_after_restart.json'), JSON.stringify(evidence, null, 2), 'utf8');
  }
}

main().catch(err => {
  console.error('Lỗi thực thi:', err);
  process.exit(1);
});
