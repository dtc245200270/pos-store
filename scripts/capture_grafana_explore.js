const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ARTIFACT_DIR = 'C:\\Users\\Dell Precision 5550\\.gemini\\antigravity-ide\\brain\\3a7246d0-4d26-4297-a017-2197f1d2ea10';
const LOGGING_ARTIFACTS_DIR = path.resolve(__dirname, '..', 'deploy', 'logging', 'artifacts');
if (!fs.existsSync(LOGGING_ARTIFACTS_DIR)) {
  fs.mkdirSync(LOGGING_ARTIFACTS_DIR, { recursive: true });
}

const OUTPUT_IMAGE_REPO = path.join(LOGGING_ARTIFACTS_DIR, 'grafana_explore_loki.png');
const OUTPUT_IMAGE_BRAIN = path.join(ARTIFACT_DIR, 'grafana_explore_loki.png');
const USER_DATA_DIR = path.join(ARTIFACT_DIR, 'scratch', 'edge_explore_profile');

async function main() {
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
  const sessionMatch = setCookie.match(/grafana_session=([^;]+)/);
  if (!sessionMatch) {
    throw new Error('Khong tim thay grafana_session cookie!');
  }
  const sessionToken = sessionMatch[1];
  console.log('Session token:', sessionToken);

  console.log('2. Khoi chay Edge headless voi CDP port 9223...');
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  
  const edgeExe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const edgeProc = spawn(edgeExe, [
    '--headless=new',
    '--remote-debugging-port=9223',
    `--user-data-dir=${USER_DATA_DIR}`,
    '--window-size=1600,1050',
    '--disable-gpu',
    'about:blank'
  ]);

  const cleanup = () => {
    try { edgeProc.kill(); } catch (e) {}
  };
  process.on('exit', cleanup);
  process.on('SIGINT', cleanup);

  console.log('3. Cho CDP 9223 san sang...');
  let versionData = null;
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const vRes = await fetch('http://127.0.0.1:9223/json/version');
      if (vRes.ok) {
        versionData = await vRes.json();
        break;
      }
    } catch (e) {}
  }
  if (!versionData) {
    throw new Error('Khong the ket noi den Edge CDP qua port 9223 sau 10 giay');
  }
  console.log('CDP da ket noi:', versionData.webSocketDebuggerUrl);

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

  console.log('4. Thiet lap cookie grafana_session...');
  await sendSession('Network.setCookie', {
    name: 'grafana_session',
    value: sessionToken,
    domain: '127.0.0.1',
    path: '/',
    httpOnly: true,
    sameSite: 'Lax'
  });

  // Navigate to Grafana Explore with Loki datasource and query
  const exploreUrl = 'http://127.0.0.1:3030/explore?schemaVersion=1&panes=%7B%22a%22%3A%7B%22datasource%22%3A%22loki-pos-store%22%2C%22queries%22%3A%5B%7B%22refId%22%3A%22A%22%2C%22expr%22%3A%22%7Bapp%3D%5C%22pos_store%5C%22%7D%22%2C%22queryType%22%3A%22range%22%7D%5D%7D%7D&orgId=1';
  console.log('5. Dieu huong den Grafana Explore:', exploreUrl);
  await sendSession('Page.navigate', { url: exploreUrl });

  console.log('6. Cho Explore tai du lieu va render dong log (7 giay)...');
  await new Promise(r => setTimeout(r, 7000));

  console.log('7. Chup anh man hinh Grafana Explore...');
  const screenshotRes = await sendSession('Page.captureScreenshot', {
    format: 'png',
    clip: {
      x: 0,
      y: 0,
      width: 1600,
      height: 950,
      scale: 1
    }
  });

  const buffer = Buffer.from(screenshotRes.data, 'base64');
  fs.writeFileSync(OUTPUT_IMAGE_REPO, buffer);
  fs.writeFileSync(OUTPUT_IMAGE_BRAIN, buffer);
  console.log('ANH DA DUOC LUU TAI:');
  console.log(' - Repo    :', OUTPUT_IMAGE_REPO);
  console.log(' - Artifact:', OUTPUT_IMAGE_BRAIN);

  ws.close();
  cleanup();
  console.log('Hoan tat chup anh Explore thanh cong!');
}

main().catch(err => {
  console.error('Loi:', err);
  process.exit(1);
});
