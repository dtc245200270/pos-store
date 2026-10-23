const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ARTIFACT_DIR = 'C:\\Users\\Dell Precision 5550\\.gemini\\antigravity-ide\\brain\\3a7246d0-4d26-4297-a017-2197f1d2ea10';
const OUTPUT_IMAGE = path.join(ARTIFACT_DIR, 'pos_store_login.png');
const USER_DATA_DIR = path.join(ARTIFACT_DIR, 'scratch', 'edge_profile_web');

async function main() {
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  
  const edgeExe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const edgeProc = spawn(edgeExe, [
    '--headless=new',
    '--remote-debugging-port=9223',
    `--user-data-dir=${USER_DATA_DIR}`,
    '--window-size=1280,800',
    '--disable-gpu',
    'about:blank'
  ]);

  const cleanup = () => {
    try { edgeProc.kill(); } catch (e) {}
  };
  process.on('exit', cleanup);
  process.on('SIGINT', cleanup);

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
    throw new Error('Khong the ket noi Edge CDP port 9223');
  }

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

  await sendSession('Page.enable');
  await sendSession('Page.navigate', { url: 'http://localhost:8080/login' });

  await new Promise(r => setTimeout(r, 2000));

  const screenshotRes = await sendSession('Page.captureScreenshot', {
    format: 'png',
    clip: {
      x: 0,
      y: 0,
      width: 1280,
      height: 800,
      scale: 1
    }
  });

  const buffer = Buffer.from(screenshotRes.data, 'base64');
  fs.writeFileSync(OUTPUT_IMAGE, buffer);
  console.log('SCREENSHOT SAVED:', OUTPUT_IMAGE);

  ws.close();
  cleanup();
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
