require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const NGINX_PORT = 8080;
const NGINX_HOST = '127.0.0.1';

function httpRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch (e) {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data,
          json
        });
      });
    });

    req.on('error', reject);

    if (postData) {
      req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
    }
    req.end();
  });
}

function parseCookie(setCookieHeaders) {
  if (!setCookieHeaders) return '';
  const cookies = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  return cookies.map(c => c.split(';')[0]).join('; ');
}

async function verifyNginx() {
  console.log('================================================================');
  console.log('KIỂM TRA HOẠT ĐỘNG NGINX REVERSE PROXY -> NODE.JS POS STORE');
  console.log('================================================================\n');

  // 1. Kiểm tra trang đăng nhập
  console.log('1. Kiểm tra tải trang đăng nhập qua Nginx (http://127.0.0.1:8080/login)...');
  const resLogin = await httpRequest({
    hostname: NGINX_HOST,
    port: NGINX_PORT,
    path: '/login',
    method: 'GET'
  });

  assert.strictEqual(resLogin.statusCode, 200, 'Trang login phải trả về status 200');
  assert.ok(resLogin.body.includes('Đăng nhập'), 'Body phải chứa nội dung trang đăng nhập');
  assert.ok(resLogin.headers['x-request-id'], 'Nginx phải giữ nguyên header X-Request-ID từ Node.js');
  assert.ok(resLogin.headers['cache-control']?.includes('no-store'), 'Phải có header chống cache cho trang web');
  console.log(`✓ Trang login OK (200), X-Request-ID=${resLogin.headers['x-request-id']}`);

  // 2. Kiểm tra tài nguyên tĩnh CSS
  console.log('\n2. Kiểm tra tải CSS qua Nginx (http://127.0.0.1:8080/public/css/style.css)...');
  const resCss = await httpRequest({
    hostname: NGINX_HOST,
    port: NGINX_PORT,
    path: '/public/css/style.css',
    method: 'GET'
  });
  assert.strictEqual(resCss.statusCode, 200, 'Tải file CSS phải trả về status 200');
  assert.ok(resCss.headers['content-type']?.includes('text/css'), 'Content-Type phải là text/css');
  console.log(`✓ File CSS tải thành công (length: ${resCss.body.length} bytes, type: ${resCss.headers['content-type']})`);

  // 3. Kiểm tra tài nguyên tĩnh JavaScript
  console.log('\n3. Kiểm tra tải JavaScript qua Nginx (http://127.0.0.1:8080/public/js/auth.js)...');
  const resJs = await httpRequest({
    hostname: NGINX_HOST,
    port: NGINX_PORT,
    path: '/public/js/auth.js',
    method: 'GET'
  });
  assert.strictEqual(resJs.statusCode, 200, 'Tải file JS phải trả về status 200');
  assert.ok(resJs.body.includes('fetchCsrfToken'), 'Body phải chứa mã JavaScript của auth.js');
  console.log(`✓ File JS tải thành công (length: ${resJs.body.length} bytes)`);

  // 4. Lấy CSRF token và Cookie phiên làm việc
  console.log('\n4. Kiểm tra API lấy CSRF token & cookie session qua Nginx (/api/auth/csrf)...');
  const resCsrf = await httpRequest({
    hostname: NGINX_HOST,
    port: NGINX_PORT,
    path: '/api/auth/csrf',
    method: 'GET'
  });
  assert.strictEqual(resCsrf.statusCode, 200);
  assert.ok(resCsrf.json?.csrfToken, 'Phải nhận được csrfToken');
  const cookie1 = parseCookie(resCsrf.headers['set-cookie']);
  assert.ok(cookie1.includes('connect.sid'), 'Phải nhận được cookie connect.sid');
  const csrfToken = resCsrf.json.csrfToken;
  console.log(`✓ API CSRF thành công: csrfToken=${csrfToken.substring(0, 16)}..., Cookie=${cookie1.substring(0, 30)}...`);

  // 5. Kiểm tra Đăng nhập qua Nginx
  console.log('\n5. Kiểm tra đăng nhập tài khoản Quản lý (MANAGER) qua Nginx (/api/auth/login)...');
  const password = process.env.INITIAL_MANAGER_PASSWORD || 'VeryStrongPass123!@#';
  const loginPayload = JSON.stringify({
    username: 'manager',
    password: password
  });

  const resAuthLogin = await httpRequest({
    hostname: NGINX_HOST,
    port: NGINX_PORT,
    path: '/api/auth/login',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(loginPayload),
      'X-CSRF-Token': csrfToken,
      'Cookie': cookie1
    }
  }, loginPayload);

  assert.strictEqual(resAuthLogin.statusCode, 200, `Đăng nhập thất bại: ${JSON.stringify(resAuthLogin.json)}`);
  assert.strictEqual(resAuthLogin.json.role, 'MANAGER', 'Role phải là MANAGER');
  const authCookie = parseCookie(resAuthLogin.headers['set-cookie']) || cookie1;
  const newCsrfToken = resAuthLogin.json.csrfToken;
  console.log(`✓ Đăng nhập thành công qua Nginx: user=manager, role=${resAuthLogin.json.role}`);

  // 6. Kiểm tra tải trang Tổng quan (Dashboard HTML) qua Nginx
  console.log('\n6. Kiểm tra tải trang Tổng quan qua Nginx (GET /)...');
  const resHome = await httpRequest({
    hostname: NGINX_HOST,
    port: NGINX_PORT,
    path: '/',
    method: 'GET',
    headers: { 'Cookie': authCookie }
  });
  assert.strictEqual(resHome.statusCode, 200);
  assert.ok(resHome.body.includes('Tổng quan') || resHome.body.includes('dashboard'), 'Nội dung phải là trang tổng quan');
  console.log(`✓ Tải trang Tổng quan qua Nginx thành công (200 OK)`);

  // 7. Kiểm tra API Tổng quan & Đối chiếu X-Request-ID với nhật ký Node.js
  console.log('\n7. Kiểm tra API Tổng quan (/api/dashboard/stats) và đối chiếu X-Request-ID với Log Node.js...');
  const resStats = await httpRequest({
    hostname: NGINX_HOST,
    port: NGINX_PORT,
    path: '/api/dashboard/stats',
    method: 'GET',
    headers: { 'Cookie': authCookie }
  });

  assert.strictEqual(resStats.statusCode, 200);
  assert.ok(resStats.json?.summary, 'Phải có dữ liệu summary trong response');
  const apiReqId = resStats.headers['x-request-id'];
  assert.ok(apiReqId, 'Phải có header X-Request-ID');
  console.log(`✓ Nhận phản hồi API: statusCode=200, X-Request-ID=${apiReqId}`);

  // Chờ một chút để Node.js hoàn thành ghi log
  await new Promise(r => setTimeout(r, 200));

  // Đọc log của Node.js từ task log
  const taskLogPath = 'C:\\Users\\Dell Precision 5550\\.gemini\\antigravity-ide\\brain\\18b59c8e-1bac-46c2-81ca-d6e650c2d45f\\.system_generated\\tasks\\task-17.log';
  let matchedNodeLog = null;
  if (fs.existsSync(taskLogPath)) {
    const lines = fs.readFileSync(taskLogPath, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (line.includes(apiReqId)) {
        try {
          matchedNodeLog = JSON.parse(line);
          break;
        } catch (e) {}
      }
    }
  }

  assert.ok(matchedNodeLog, `Phải tìm thấy dòng log của Node.js chứa requestId=${apiReqId}`);
  assert.strictEqual(matchedNodeLog.requestId, apiReqId, 'requestId trong Node.js log phải trùng với header X-Request-ID từ Nginx');
  assert.strictEqual(matchedNodeLog.path, '/api/dashboard/stats');
  assert.strictEqual(matchedNodeLog.statusCode, 200);
  console.log(`✓ ĐỐI CHIẾU THÀNH CÔNG:`);
  console.log(`   - Header X-Request-ID qua Nginx: ${apiReqId}`);
  console.log(`   - Node.js log requestId:        ${matchedNodeLog.requestId}`);
  console.log(`   - Node.js durationMs:           ${matchedNodeLog.durationMs}ms`);

  // 8. Kiểm tra chuyển các trang nghiệp vụ khác qua Nginx
  console.log('\n8. Kiểm tra chuyển các trang nghiệp vụ qua Nginx (chỉ xem, không đổi dữ liệu)...');
  const pagesToTest = [
    { path: '/products', name: 'Sản phẩm' },
    { path: '/employees', name: 'Nhân viên' },
    { path: '/sales', name: 'Bán hàng' },
    { path: '/invoices', name: 'Hóa đơn' },
    { path: '/stock-receipts', name: 'Nhập hàng' },
    { path: '/inventory', name: 'Tồn kho' },
    { path: '/profile', name: 'Hồ sơ' }
  ];

  for (const page of pagesToTest) {
    const resPage = await httpRequest({
      hostname: NGINX_HOST,
      port: NGINX_PORT,
      path: page.path,
      method: 'GET',
      headers: { 'Cookie': authCookie }
    });
    assert.strictEqual(resPage.statusCode, 200, `Trang ${page.name} (${page.path}) phải trả về 200 OK`);
    console.log(`   ✓ [200 OK] Chuyển trang thành công: ${page.name} (${page.path})`);
  }

  // 9. Kiểm tra access.log của Nginx
  console.log('\n9. Kiểm tra nhật ký truy cập Nginx (C:\\nginx\\logs\\access.log)...');
  const nginxAccessLog = 'C:\\nginx\\logs\\access.log';
  if (fs.existsSync(nginxAccessLog)) {
    const logContent = fs.readFileSync(nginxAccessLog, 'utf8').trim();
    const lastLines = logContent.split('\n').slice(-3);
    console.log(`✓ 3 dòng log truy cập mới nhất của Nginx:`);
    lastLines.forEach(l => console.log(`   [NGINX ACCESS] ${l}`));
  }

  console.log('\n================================================================');
  console.log('KẾT QUẢ: NGINX REVERSE PROXY HOẠT ĐỘNG HOÀN HẢO 100%!');
  console.log('================================================================');
}

verifyNginx().catch(err => {
  console.error('\n❌ KIỂM TRA THẤT BẠI:', err);
  process.exit(1);
});
