require('dotenv').config();
const http = require('http');
const assert = require('assert');
const mysql = require('mysql2/promise');

const BASE_URL = 'http://127.0.0.1:8080';

async function fetchHttp(urlPath, options = {}) {
  const url = new URL(urlPath, BASE_URL);
  const headers = options.headers || {};

  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: options.method || 'GET',
      headers: headers
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (_) {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          rawHeaders: res.rawHeaders,
          body: data,
          json: json
        });
      });
    });

    req.on('error', reject);
    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

function extractCookie(headers) {
  const setCookie = headers['set-cookie'];
  if (!setCookie) return null;
  const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  const match = cookieStr.match(/connect\.sid=([^;]+)/);
  return {
    full: cookieStr,
    sid: match ? match[1] : null,
    cookieHeader: cookieStr.split(';')[0]
  };
}

async function runTests() {
  console.log('================================================================');
  console.log('HARDENING VERIFICATION SUITE - POS STORE (DOCKER COMPOSE)');
  console.log('================================================================\n');

  let passedTests = 0;
  let totalTests = 0;

  function record(desc, ok, details = '') {
    totalTests++;
    if (ok) {
      passedTests++;
      console.log(`[PASS] ${desc}`);
    } else {
      console.log(`[FAIL] ${desc} - ${details}`);
    }
  }

  // TEST 1: Security Headers on Nginx Port 8080
  console.log('--- TEST 1: Security Headers on Port 8080 ---');
  const resLogin = await fetchHttp('/login');
  
  // 1.1 Server header
  const serverHeader = resLogin.headers['server'] || '';
  record('Server header does not expose Nginx version', serverHeader === 'nginx', `Server: ${serverHeader}`);

  // 1.2 X-Powered-By
  record('X-Powered-By header is stripped', !resLogin.headers['x-powered-by'], `Found: ${resLogin.headers['x-powered-by']}`);

  // 1.3 X-Content-Type-Options
  record('X-Content-Type-Options is nosniff', resLogin.headers['x-content-type-options'] === 'nosniff');

  // 1.4 X-Frame-Options
  record('X-Frame-Options is SAMEORIGIN', resLogin.headers['x-frame-options'] === 'SAMEORIGIN');

  // 1.5 Referrer-Policy
  record('Referrer-Policy is strict-origin-when-cross-origin', resLogin.headers['referrer-policy'] === 'strict-origin-when-cross-origin');

  // 1.6 Content-Security-Policy
  const csp = resLogin.headers['content-security-policy'] || '';
  const cspOk = csp.includes("default-src 'self'") &&
                csp.includes('https://cdn.jsdelivr.net') &&
                csp.includes('https://img.vietqr.io') &&
                csp.includes("frame-ancestors 'self'");
  record('Content-Security-Policy configured with actual resources (Bootstrap, VietQR, self)', cspOk, csp);

  // 1.7 HSTS should NOT be present on HTTP
  record('HSTS is NOT present on HTTP localhost (as required)', !resLogin.headers['strict-transport-security']);

  // 1.8 Cache-Control uniqueness
  const rawHeaders = resLogin.rawHeaders;
  let cacheControlCount = 0;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() === 'cache-control') cacheControlCount++;
  }
  record('Cache-Control is not duplicated in response headers', cacheControlCount === 1, `Count: ${cacheControlCount}`);

  // TEST 2: CSRF Protection
  console.log('\n--- TEST 2: CSRF Protection ---');
  // 2.1 Missing CSRF Token on POST
  const resCsrfMissing = await fetchHttp('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { username: 'dummy', password: 'bad' }
  });
  record('POST /api/auth/login without CSRF token returns 403 Forbidden', resCsrfMissing.statusCode === 403);

  // 2.2 Invalid CSRF Token on POST
  const resCsrfBad = await fetchHttp('/api/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': 'invalid_csrf_token_12345'
    },
    body: { username: 'dummy', password: 'bad' }
  });
  record('POST /api/auth/login with invalid CSRF token returns 403 Forbidden', resCsrfBad.statusCode === 403);

  // TEST 3: Login Rate Limiting (Isolated dummy username)
  console.log('\n--- TEST 3: Login Rate Limiting (Isolated Account Probe) ---');
  // Get valid CSRF token & session
  const resCsrfInit = await fetchHttp('/api/auth/csrf');
  const initialCookie = extractCookie(resCsrfInit.headers);
  const initialCsrfToken = resCsrfInit.json.csrfToken;

  const probeUser = 'isolated_lockout_probe_' + Date.now();
  let got429 = false;
  let retryAfterSeconds = 0;

  for (let attempt = 1; attempt <= 6; attempt++) {
    const resProbe = await fetchHttp('/api/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': initialCsrfToken,
        'Cookie': initialCookie.cookieHeader
      },
      body: { username: probeUser, password: 'wrongpassword' }
    });

    if (attempt <= 5) {
      if (resProbe.statusCode !== 401) {
        console.log(`Probe attempt ${attempt} returned unexpected status ${resProbe.statusCode}`);
      }
    } else {
      // 6th attempt should be rate limited (429)
      if (resProbe.statusCode === 429) {
        got429 = true;
        retryAfterSeconds = Number(resProbe.headers['retry-after'] || 0);
      }
    }
  }

  record('Exceeding 5 failed login attempts triggers 429 Too Many Requests', got429);
  record('Rate limiting includes Retry-After header (> 0 seconds)', retryAfterSeconds > 0, `Retry-After: ${retryAfterSeconds}`);

  // TEST 4: Login Flow, Session ID Regeneration & Cookie Attributes
  console.log('\n--- TEST 4: Login Flow & Session Security ---');
  // Obtain fresh session for manager login
  const resCsrfFresh = await fetchHttp('/api/auth/csrf');
  const preLoginCookie = extractCookie(resCsrfFresh.headers);
  const preLoginCsrf = resCsrfFresh.json.csrfToken;

  const managerPassword = process.env.INITIAL_MANAGER_PASSWORD || 'password123';
  const resLoginSuccess = await fetchHttp('/api/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': preLoginCsrf,
      'Cookie': preLoginCookie.cookieHeader
    },
    body: { username: 'manager', password: managerPassword }
  });

  record('Manager login succeeds with 200 OK', resLoginSuccess.statusCode === 200);

  const postLoginCookie = extractCookie(resLoginSuccess.headers);
  const sidRegenerated = postLoginCookie && preLoginCookie && (postLoginCookie.sid !== preLoginCookie.sid);
  record('Session ID regenerated upon login (Session Fixation defense)', sidRegenerated);

  const cookieHeader = postLoginCookie ? postLoginCookie.full : '';
  record('Cookie has HttpOnly attribute', cookieHeader.toLowerCase().includes('httponly'));
  record('Cookie has SameSite=Lax attribute', cookieHeader.toLowerCase().includes('samesite=lax'));
  record('Cookie has appropriate Secure attribute for HTTP localhost', !cookieHeader.toLowerCase().includes('secure;'));

  // Test accessing authenticated API /api/auth/me
  const resMe = await fetchHttp('/api/auth/me', {
    headers: { 'Cookie': postLoginCookie.cookieHeader }
  });
  record('Authenticated /api/auth/me returns MANAGER role', resMe.statusCode === 200 && resMe.json && resMe.json.role === 'MANAGER');

  // Test accessing protected page /dashboard
  const resDashboard = await fetchHttp('/', {
    headers: { 'Cookie': postLoginCookie.cookieHeader }
  });
  record('Authenticated access to dashboard (/) returns 200 OK', resDashboard.statusCode === 200);

  // TEST 5: Logout Flow & Session Destruction
  console.log('\n--- TEST 5: Logout Flow & Session Invalidation ---');
  const loggedInCsrf = resLoginSuccess.json.csrfToken;
  const resLogout = await fetchHttp('/api/auth/logout', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': loggedInCsrf,
      'Cookie': postLoginCookie.cookieHeader
    }
  });

  record('Logout succeeds with 200 OK', resLogout.statusCode === 200);

  const logoutCookie = resLogout.headers['set-cookie'];
  const logoutCookieExpired = logoutCookie && (
    logoutCookie[0].includes('Expires=Thu, 01 Jan 1970') || 
    logoutCookie[0].includes('Max-Age=0') ||
    logoutCookie[0].includes('connect.sid=;')
  );
  record('Logout clears session cookie (Expires in past or Max-Age=0)', Boolean(logoutCookieExpired));

  // Request /api/auth/me with the old session cookie
  const resMeAfterLogout = await fetchHttp('/api/auth/me', {
    headers: { 'Cookie': postLoginCookie.cookieHeader }
  });
  record('Old session cookie rejected with 401 Unauthorized after logout', resMeAfterLogout.statusCode === 401);

  // TEST 6: MySQL Privilege Hardening Verification
  console.log('\n--- TEST 6: MySQL Privilege Hardening (Least Privilege) ---');
  const appPool = mysql.createPool({
    host: '127.0.0.1',
    port: Number(process.env.HOST_MYSQL_PORT || 3307),
    user: process.env.DB_USER || 'pos_app',
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || 'pos_store'
  });

  try {
    // 6.1 CRUD operations (SELECT, INSERT, UPDATE, DELETE) should succeed
    const [selectRes] = await appPool.query('SELECT COUNT(*) AS total FROM products');
    record('pos_app can execute SELECT queries', selectRes && selectRes[0].total >= 0);

    // 6.2 DDL operations (CREATE TABLE, DROP TABLE) MUST be denied
    let createDenied = false;
    try {
      await appPool.query('CREATE TABLE hardening_test_fail (id INT)');
    } catch (createErr) {
      if (createErr.code === 'ER_TABLEACCESS_DENIED_ERROR' || createErr.code === 'ER_DBACCESS_DENIED_ERROR') {
        createDenied = true;
      }
    }
    record('pos_app is DENIED CREATE TABLE privileges', createDenied);

    let dropDenied = false;
    try {
      await appPool.query('DROP TABLE products');
    } catch (dropErr) {
      if (dropErr.code === 'ER_TABLEACCESS_DENIED_ERROR' || dropErr.code === 'ER_DBACCESS_DENIED_ERROR') {
        dropDenied = true;
      }
    }
    record('pos_app is DENIED DROP TABLE privileges', dropDenied);

  } finally {
    await appPool.end();
  }

  console.log('\n================================================================');
  console.log(`TOTAL TESTS: ${totalTests} | PASSED: ${passedTests} | FAILED: ${totalTests - passedTests}`);
  console.log('================================================================');
}

runTests().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
