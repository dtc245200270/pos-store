const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ARTIFACT_DIR = 'C:\\Users\\Dell Precision 5550\\.gemini\\antigravity-ide\\brain\\3a7246d0-4d26-4297-a017-2197f1d2ea10';
const OUTPUT_IMAGE = path.join(ARTIFACT_DIR, 'grafana_dashboard_top_panels.png');
const USER_DATA_DIR = path.join(ARTIFACT_DIR, 'scratch', 'edge_profile');

async function main() {
  // 1. Login to Grafana to get session cookie
  console.log('1. Dang nhap Grafana qua API de lay session cookie...');
  const loginRes = await fetch('http://127.0.0.1:3030/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'admin', email: '', password: 'admin' })
  });
  if (!loginRes.ok) {
    throw new Error(`Login failed with status: ${loginRes.status}`);
  }
  const setCookie = loginRes.headers.get('set-cookie');
  console.log('Cookie nhan duoc:', setCookie);
  const sessionMatch = setCookie.match(/grafana_session=([^;]+)/);
  if (!sessionMatch) {
    throw new Error('Khong tim thay grafana_session cookie!');
  }
  const sessionToken = sessionMatch[1];

  // 2. Launch msedge in headless mode with remote debugging
  console.log('2. Khoi chay Edge headless voi CDP port 9222...');
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  
  const edgeExe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const edgeProc = spawn(edgeExe, [
    '--headless=new',
    '--remote-debugging-port=9222',
    `--user-data-dir=${USER_DATA_DIR}`,
    '--window-size=1600,1000',
    '--disable-gpu',
    'about:blank'
  ]);

  // Cleanup on exit
  const cleanup = () => {
    try { edgeProc.kill(); } catch (e) {}
  };
  process.on('exit', cleanup);
  process.on('SIGINT', cleanup);

  // 3. Wait for CDP port to be open
  console.log('3. Cho CDP 9222 san sang...');
  let versionData = null;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const vRes = await fetch('http://127.0.0.1:9222/json/version');
      if (vRes.ok) {
        versionData = await vRes.json();
        break;
      }
    } catch (e) {}
  }
  if (!versionData) {
    throw new Error('Khong the ket noi den Edge CDP qua port 9222 sau 10 giay');
  }
  console.log('CDP da ket noi:', versionData.webSocketDebuggerUrl);

  // 4. Connect via WebSocket
  const ws = new WebSocket(versionData.webSocketDebuggerUrl);
  let id = 1;
  const callbacks = new Map();

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && callbacks.has(msg.id)) {
      const cb = callbacks.get(msg.id);
      callbacks.delete(msg.id);
      if (msg.error) cb.reject(new Error(msg.error.message));
      else cb.resolve(msg.result);
    }
  };

  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  const send = (method, params = {}) => {
    return new Promise((resolve, reject) => {
      const msgId = id++;
      callbacks.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
  };

  // Create a new target/page
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });

  const sendSession = (method, params = {}) => {
    return new Promise((resolve, reject) => {
      const msgId = id++;
      callbacks.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, sessionId, method, params }));
    });
  };

  await sendSession('Network.enable');
  await sendSession('Page.enable');

  // Set the session cookie
  console.log('4. Thiet lap cookie grafana_session vao trinh duyet...');
  await sendSession('Network.setCookie', {
    name: 'grafana_session',
    value: sessionToken,
    domain: '127.0.0.1',
    path: '/',
    httpOnly: true,
    sameSite: 'Lax'
  });

  // Navigate to dashboard
  const targetUrl = 'http://127.0.0.1:3030/d/pos-store-monitoring-dashboard?from=now-5m&to=now';
  console.log('5. Dieu huong den:', targetUrl);
  await sendSession('Page.navigate', { url: targetUrl });

  // Wait for load and rendering
  console.log('6. Cho dashboard tai va render cac panel (6 giay)...');
  await new Promise(r => setTimeout(r, 6000));

  // Capture screenshot of viewport
  console.log('7. Chup anh man hinh bon panel tren cung...');
  const screenshotRes = await sendSession('Page.captureScreenshot', {
    format: 'png',
    clip: {
      x: 0,
      y: 0,
      width: 1600,
      height: 600,
      scale: 1
    }
  });

  const buffer = Buffer.from(screenshotRes.data, 'base64');
  fs.writeFileSync(OUTPUT_IMAGE, buffer);
  console.log('ANH DA DUOC LUU TAI:', OUTPUT_IMAGE);

  // Close browser
  ws.close();
  cleanup();
  console.log('Hoan tat chup anh thanh cong!');
}

main().catch(err => {
  console.error('Loi:', err);
  process.exit(1);
});
