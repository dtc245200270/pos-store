require('dotenv').config();
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEBUG_PORT = 9223;
const USER_DATA_DIR = path.join(__dirname, '..', 'deploy', 'monitoring', 'data', 'chrome_csp_test_profile');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getWsUrl(port) {
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`);
      const list = await res.json();
      const page = list.find(t => t.type === 'page');
      if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch (_) {}
  }
  throw new Error('Timed out waiting for Chrome WebSocket URL');
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

async function evaluate(ws, expression) {
  const res = await sendCdp(ws, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  return res.result ? res.result.value : null;
}

async function runBrowserCspTest() {
  console.log('================================================================');
  console.log('REAL BROWSER CSP & UI VERIFICATION TEST (CHROME HEADLESS)');
  console.log('Testing via Nginx Reverse Proxy at: http://127.0.0.1:8080');
  console.log('================================================================\n');

  if (!fs.existsSync(USER_DATA_DIR)) {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  }

  const chromeProc = spawn(CHROME_PATH, [
    '--headless=new',
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${USER_DATA_DIR}`
  ]);

  chromeProc.on('error', err => {
    console.error('Failed to start Chrome:', err);
  });

  const cspViolations = [];
  const consoleErrors = [];
  const networkBlocked = [];

  try {
    const wsUrl = await getWsUrl(DEBUG_PORT);
    console.log(`[OK] Chrome connected via CDP: ${wsUrl}\n`);

    const WebSocket = global.WebSocket || require('ws');
    const ws = new WebSocket(wsUrl);

    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = rej;
    });

    // Enable CDP domains
    await sendCdp(ws, 'Page.enable');
    await sendCdp(ws, 'Runtime.enable');
    await sendCdp(ws, 'Log.enable');
    await sendCdp(ws, 'Network.enable');

    // Event listener for Log entries (CSP violations)
    ws.addEventListener('message', (evt) => {
      const msg = JSON.parse(evt.data);
      if (msg.method === 'Log.entryAdded') {
        const entry = msg.params.entry;
        const text = entry.text || '';
        if (entry.source === 'security' || text.includes('Content Security Policy') || text.includes('Refused to')) {
          cspViolations.push({
            source: entry.source,
            level: entry.level,
            text: entry.text,
            url: entry.url
          });
        }
        if (entry.level === 'error') {
          consoleErrors.push({ text: entry.text, source: entry.source });
        }
      }
      if (msg.method === 'Network.loadingFailed') {
        const { blockedReason, errorText, canceled } = msg.params;
        if (blockedReason === 'csp' || errorText.includes('CSP')) {
          networkBlocked.push(msg.params);
        }
      }
    });

    // 1. Test Login Page
    console.log('--- STEP 1: Verify Login Page (/login) ---');
    await sendCdp(ws, 'Page.navigate', { url: 'http://127.0.0.1:8080/login' });
    await sleep(1500);

    const loginTitle = await evaluate(ws, 'document.title');
    console.log(`Page Title: "${loginTitle}"`);

    // Check if Bootstrap CSS and JS are loaded
    const bootstrapLoaded = await evaluate(ws, "typeof bootstrap !== 'undefined' || !!document.querySelector('link[href*=\"bootstrap\"]')");
    console.log(`Bootstrap resources present: ${bootstrapLoaded}`);

    // Fill login form and submit
    const managerPass = process.env.INITIAL_MANAGER_PASSWORD || 'password123';
    console.log('Filling login credentials and clicking submit button...');
    await evaluate(ws, `
      document.getElementById('username').value = 'manager';
      document.getElementById('password').value = ${JSON.stringify(managerPass)};
      document.getElementById('login-btn').click();
    `);

    // Wait for redirect to Dashboard
    await sleep(2500);
    const currentUrl = await evaluate(ws, 'window.location.href');
    console.log(`Redirected URL after login: ${currentUrl}`);

    // 2. Test Dashboard UI, Widgets & Modal
    console.log('\n--- STEP 2: Verify Dashboard Page (/) & Modals ---');
    const dashboardTitle = await evaluate(ws, 'document.title');
    console.log(`Dashboard Title: "${dashboardTitle}"`);

    const statCount = await evaluate(ws, "document.getElementById('stat-low-stock-count') ? document.getElementById('stat-low-stock-count').textContent : 'N/A'");
    console.log(`Dashboard Stat Widget (Low stock count): "${statCount}"`);

    // Test opening and closing modal
    const modalTest = await evaluate(ws, `
      (function() {
        const modalEl = document.getElementById('invoice-detail-modal');
        if (!modalEl) return { found: false };
        if (typeof closeInvoiceModal === 'function') {
          closeInvoiceModal();
          return { found: true, functionWorking: true };
        }
        return { found: true, functionWorking: false };
      })()
    `);
    console.log('Invoice Detail Modal test:', JSON.stringify(modalTest));

    // 3. Test Sales Page & VietQR Display
    console.log('\n--- STEP 3: Verify Sales Page (/sales) & VietQR Display ---');
    await sendCdp(ws, 'Page.navigate', { url: 'http://127.0.0.1:8080/sales' });
    await sleep(2000);

    const salesTitle = await evaluate(ws, 'document.title');
    console.log(`Sales Title: "${salesTitle}"`);

    // Test VietQR Image loading under CSP
    const qrImageResult = await evaluate(ws, `
      new Promise((resolve) => {
        const testImg = new Image();
        testImg.onload = () => resolve({ status: 'LOADED', width: testImg.naturalWidth, height: testImg.naturalHeight });
        testImg.onerror = (e) => resolve({ status: 'ERROR', error: 'Image failed to load under CSP' });
        // VietQR sample URL format
        testImg.src = 'https://img.vietqr.io/image/970415-12345678-compact.png?amount=50000&addInfo=TEST_POS_STORE';
      })
    `);
    console.log('VietQR Image Load Result (from https://img.vietqr.io):', JSON.stringify(qrImageResult));

    // 4. Test Navigation to other management pages
    console.log('\n--- STEP 4: Verify Navigation & Management Pages ---');
    const pagesToTest = ['/products', '/employees', '/invoices', '/stock-receipts', '/inventory', '/profile'];
    for (const p of pagesToTest) {
      await sendCdp(ws, 'Page.navigate', { url: `http://127.0.0.1:8080${p}` });
      await sleep(1000);
      const title = await evaluate(ws, 'document.title');
      const tableCount = await evaluate(ws, "document.querySelectorAll('table').length");
      console.log(`Page ${p}: Title="${title}", Tables count=${tableCount}`);
    }

    // 5. Final Evaluation of CSP Violations & Console Errors
    console.log('\n================================================================');
    console.log('CSP & BROWSER CONSOLE REPORT');
    console.log('================================================================');
    console.log(`Total CSP Violations Detected: ${cspViolations.length}`);
    if (cspViolations.length > 0) {
      console.log('CSP Violations Details:');
      cspViolations.forEach((v, idx) => {
        console.log(`  [${idx + 1}] Source: ${v.source} | Level: ${v.level} | ${v.text}`);
      });
    } else {
      console.log('[PASS] ZERO CSP violations reported by Chrome browser.');
    }

    console.log(`Total Network Blocked by CSP: ${networkBlocked.length}`);
    if (networkBlocked.length > 0) {
      console.log('Network Blocked Details:', JSON.stringify(networkBlocked, null, 2));
    } else {
      console.log('[PASS] ZERO network requests blocked by CSP.');
    }

    console.log(`Total Console Errors: ${consoleErrors.length}`);
    if (consoleErrors.length > 0) {
      console.log('Console Errors:', JSON.stringify(consoleErrors, null, 2));
    }

    ws.close();
  } finally {
    try {
      chromeProc.kill();
    } catch (_) {}
  }
}

runBrowserCspTest().catch(err => {
  console.error('Browser CSP Test failed:', err);
  process.exit(1);
});
