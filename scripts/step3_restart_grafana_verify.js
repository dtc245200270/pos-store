const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const GRAFANA_DIR = 'C:\\grafana';
const GRAFANA_EXE = 'C:\\grafana\\bin\\grafana.exe';
const GRAFANA_CONFIG = 'C:\\grafana\\conf\\custom.ini';
const HEALTH_URL = 'http://127.0.0.1:3030/api/health';
const DASHBOARD_API_URL = 'http://127.0.0.1:3030/api/dashboards/uid/pos-store-monitoring-dashboard';

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
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

async function getHealth() {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function getDashboardPanels() {
  const authHeader = 'Basic ' + Buffer.from('admin:admin').toString('base64');
  const res = await fetch(DASHBOARD_API_URL, {
    headers: { 'Authorization': authHeader }
  });
  if (!res.ok) throw new Error(`Dashboard API HTTP ${res.status}`);
  const data = await res.json();
  return {
    panel3: extractPanelConfig(data.dashboard.panels.find(p => p.id === 3)),
    panel4: extractPanelConfig(data.dashboard.panels.find(p => p.id === 4))
  };
}

async function main() {
  console.log('=== BƯỚC 3: KHỞI ĐỘNG LẠI RIÊNG GRAFANA VÀ XÁC NHẬN CẤU HÌNH ===\n');

  // 1. Đọc cấu hình trước khi restart
  console.log('1. Đọc cấu hình Panel 3 & 4 hiện tại qua Grafana API...');
  const beforePanels = await getDashboardPanels();
  console.log('Cấu hình Panel 3 trước restart:');
  console.log(JSON.stringify(beforePanels.panel3, null, 2));
  console.log('Cấu hình Panel 4 trước restart:');
  console.log(JSON.stringify(beforePanels.panel4, null, 2));

  // 2. Tìm PID Grafana đang chạy
  console.log('\n2. Tìm tiến trình Grafana đang chạy...');
  let grafanaPids = [];
  try {
    const out = execSync('powershell -Command "Get-Process -Name grafana,grafana-server -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id"').toString().trim();
    if (out) {
      grafanaPids = out.split(/\r?\n/).map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
    }
  } catch (e) {}

  console.log('Danh sách PID Grafana tìm thấy:', grafanaPids);

  // 3. Dừng riêng Grafana
  console.log('\n3. Dừng tiến trình Grafana...');
  for (const pid of grafanaPids) {
    try {
      execSync(`powershell -Command "Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue"`);
      console.log(`Đã dừng tiến trình PID: ${pid}`);
    } catch (e) {
      console.log(`Lỗi khi dừng PID ${pid}:`, e.message);
    }
  }

  // Chờ cổng 3030 giải phóng hoàn toàn
  console.log('Chờ cổng 3030 giải phóng...');
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 600));
    try {
      const conn = execSync('powershell -Command "Get-NetTCPConnection -LocalPort 3030 -State Listen -ErrorAction SilentlyContinue"').toString().trim();
      if (!conn) {
        console.log('Cổng 3030 đã được giải phóng hoàn toàn.');
        break;
      }
    } catch (e) {
      break;
    }
  }

  // 4. Khởi động lại riêng Grafana dùng Invoke-CimMethod Win32_Process
  console.log('\n4. Khởi động lại riêng Grafana Server...');
  const cmdLine = `cmd.exe /c "cd /d \\"${GRAFANA_DIR}\\" && \\"${GRAFANA_EXE}\\" server --config=\\"${GRAFANA_CONFIG}\\""`;
  const startPs = `Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${cmdLine}'; CurrentDirectory = '${GRAFANA_DIR}' }`;
  const startOut = execSync(`powershell -Command "${startPs}"`).toString();
  console.log('Kết quả khởi động:', startOut.trim());

  // 5. Polling kiểm tra /api/health
  console.log('\n5. Kiểm tra /api/health (HTTP 200, database = ok)...');
  let healthResult = null;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 1000));
    healthResult = await getHealth();
    if (healthResult && healthResult.database && healthResult.database.toLowerCase() === 'ok') {
      console.log(`Grafana đã sẵn sàng tại lần thử thứ ${i + 1}!`);
      break;
    }
    process.stdout.write('.');
  }

  if (!healthResult || healthResult.database?.toLowerCase() !== 'ok') {
    throw new Error('Grafana không phản hồi /api/health hợp lệ sau 20 giây!');
  }

  console.log('\nKết quả /api/health:');
  console.log(JSON.stringify(healthResult, null, 2));

  // Lấy PID mới
  let newPid = 'Unknown';
  try {
    const connCheck = execSync('powershell -Command "Get-NetTCPConnection -LocalPort 3030 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique"').toString().trim();
    if (connCheck) newPid = connCheck;
  } catch (e) {}
  console.log(`PID Grafana mới đang lắng nghe tại cổng 3030: ${newPid}`);

  // 6. Đọc lại cấu hình Panel 3 & 4 sau restart
  console.log('\n6. Đọc lại cấu hình Panel 3 & 4 qua Grafana API sau khi khởi động lại...');
  const afterPanels = await getDashboardPanels();
  console.log('Cấu hình Panel 3 sau restart:');
  console.log(JSON.stringify(afterPanels.panel3, null, 2));
  console.log('Cấu hình Panel 4 sau restart:');
  console.log(JSON.stringify(afterPanels.panel4, null, 2));

  // 7. So sánh đối chiếu trước và sau restart
  console.log('\n--- ĐỐI CHIẾU CẤU HÌNH TRƯỚC VÀ SAU KHI RESTART ---');
  const p3Preserved = deepEqual(beforePanels.panel3, afterPanels.panel3);
  const p4Preserved = deepEqual(beforePanels.panel4, afterPanels.panel4);

  console.log(`Panel 3 giữ nguyên 100%: ${p3Preserved ? 'PASS' : 'FAIL'}`);
  console.log(`Panel 4 giữ nguyên 100%: ${p4Preserved ? 'PASS' : 'FAIL'}`);

  const pass = p3Preserved && p4Preserved && (healthResult.database === 'ok');
  console.log(`\n=> KẾT LUẬN BƯỚC 3: ${pass ? 'PASS (Khởi động lại an toàn, /api/health OK, cấu hình giữ nguyên)' : 'FAIL'}`);

  const evidence = {
    step: 3,
    timestamp: new Date().toISOString(),
    grafana_new_pid: newPid,
    health: healthResult,
    panel_3_preserved: p3Preserved,
    panel_4_preserved: p4Preserved,
    panel_3_config_after: afterPanels.panel3,
    panel_4_config_after: afterPanels.panel4,
    result: pass ? 'PASS' : 'FAIL'
  };

  const outPath = path.join(__dirname, 'evidence_step3_restart.json');
  fs.writeFileSync(outPath, JSON.stringify(evidence, null, 2), 'utf8');
  console.log(`Đã lưu JSON bằng chứng tại: ${outPath}`);

  const artifactDir = 'C:\\Users\\Dell Precision 5550\\.gemini\\antigravity-ide\\brain\\3a7246d0-4d26-4297-a017-2197f1d2ea10';
  if (fs.existsSync(artifactDir)) {
    fs.writeFileSync(path.join(artifactDir, 'evidence_step3_restart.json'), JSON.stringify(evidence, null, 2), 'utf8');
  }
}

main().catch(err => {
  console.error('Lỗi thực thi:', err);
  process.exit(1);
});
