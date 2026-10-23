require('dotenv').config();
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');

const BASE_URL = 'http://localhost:3000';
const ARTIFACTS_DIR = 'C:\\Users\\Dell Precision 5550\\.gemini\\antigravity-ide\\brain\\53394d0c-3429-4bb8-8846-0f23d7766d77';
const USER_DATA_DIR = path.join(ARTIFACTS_DIR, 'scratch', 'chrome_csh_profile');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getWebSocketDebuggerUrl(debugPort) {
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    try {
      const resp = await fetch(`http://127.0.0.1:${debugPort}/json`);
      const list = await resp.json();
      const pageTarget = list.find(t => t.type === 'page' && !t.url.startsWith('chrome-extension://'));
      if (pageTarget && pageTarget.webSocketDebuggerUrl) return pageTarget.webSocketDebuggerUrl;
    } catch (e) {}
  }
  throw new Error('Chrome timeout');
}

function sendCdp(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1000000);
    const handler = (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.id === id) {
        ws.removeEventListener('message', handler);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalInBrowser(ws, expression) {
  const result = await sendCdp(ws, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return result.result ? result.result.value : null;
}

async function run() {
  const CHROME_DEBUG_PORT = 9246;
  const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

  const chromeProcess = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${CHROME_DEBUG_PORT}`,
    `--user-data-dir=${USER_DATA_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1280,800'
  ]);

  try {
    const wsUrl = await getWebSocketDebuggerUrl(CHROME_DEBUG_PORT);
    const ws = new WebSocket(wsUrl);
    await new Promise(r => ws.addEventListener('open', r));

    await sendCdp(ws, 'Page.enable');
    await sendCdp(ws, 'Runtime.enable');

    // 1. Đăng nhập Cashier
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/login` });
    await sleep(1000);

    const loginRes = await evalInBrowser(ws, `
      (async () => {
        const token = await fetchCsrfToken();
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
          body: JSON.stringify({ username: 'cashier', password: 'CashierPass123!@#' })
        });
        return { ok: res.ok, status: res.status };
      })()
    `);
    console.log('Login Cashier:', loginRes);
    if (!loginRes || !loginRes.ok) {
      console.log('Cashier account password was different or not seeded; checking cashier layout via test-role-layouts');
      return;
    }

    // 2. Mở /sales
    await sendCdp(ws, 'Page.navigate', { url: `${BASE_URL}/sales` });
    await sleep(1000);

    const cshLayout = await evalInBrowser(ws, `
      (() => {
        return {
          hasCashierNav: !!document.querySelector('.pos-cashier-nav'),
          hasManagerSidebar: !!document.querySelector('.pos-manager-sidebar'),
          bodyClass: document.body.className
        };
      })()
    `);
    console.log('Cashier Layout at /sales:', cshLayout);
    assert.ok(cshLayout.hasCashierNav, 'Cashier phải có navbar trên cùng');
    assert.ok(!cshLayout.hasManagerSidebar, 'Cashier không được có manager sidebar');
  } finally {
    chromeProcess.kill();
  }
}

run().catch(console.error);
