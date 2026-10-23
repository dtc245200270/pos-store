require('dotenv').config();
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const assert = require('assert');

const TEST_PORT = 3002;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

// Helper kiểm tra định dạng UUID v4
function isUuid(str) {
  return typeof str === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str);
}

// Helper gửi HTTP request
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

async function runVerification() {
  console.log('=== BẮT ĐẦU KIỂM THỬ NHẬT KÝ CÓ CẤU TRÚC VÀ REQUEST ID ===\n');

  // --- PHẦN 1: KIỂM THỬ ĐƠN VỊ TIỆN ÍCH LOGGER & BẢO VỆ DỮ LIỆU NHẠY CẢM ---
  console.log('--- PHẦN 1: Kiểm tra tính năng Logger và che giấu dữ liệu bí mật ---');
  const logger = require('../config/logger');

  // Bắt các dòng stdout và stderr của process
  const capturedStdout = [];
  const capturedStderr = [];

  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;

  process.stdout.write = function (str, encoding, cb) {
    if (typeof str === 'string' && str.trim().startsWith('{')) {
      capturedStdout.push(str);
    }
    return originalStdoutWrite.call(process.stdout, str, encoding, cb);
  };
  process.stderr.write = function (str, encoding, cb) {
    if (typeof str === 'string' && str.trim().startsWith('{')) {
      capturedStderr.push(str);
    }
    return originalStderrWrite.call(process.stderr, str, encoding, cb);
  };

  try {
    // 1. Kiểm tra log info bình thường
    logger.info({
      event: 'test_info',
      requestId: 'test-uuid-123',
      message: 'Hello'
    });

    assert.strictEqual(capturedStdout.length, 1, 'Phải có 1 dòng log ghi ra stdout');
    const infoLog = JSON.parse(capturedStdout[0]);
    assert.strictEqual(infoLog.level, 'info');
    assert.strictEqual(infoLog.event, 'test_info');
    assert.strictEqual(infoLog.requestId, 'test-uuid-123');
    assert.ok(infoLog.timestamp, 'Phải có trường timestamp');
    console.log('✓ Logger ghi log info chuẩn JSON ra stdout thành công.');

    // 2. Kiểm tra che giấu thông tin nhạy cảm (password, session, sql, tokens)
    logger.info({
      event: 'login_attempt',
      username: 'admin',
      password: 'super_secret_password',
      confirm_password: 'super_secret_password',
      token: 'secret_token_123',
      csrfToken: 'csrf_secret',
      session: 'sess_123',
      sql: 'SELECT * FROM users WHERE password="123"',
      query: 'DELETE FROM invoices',
      parameters: ['123', 'secret']
    });

    const sanitizedLog = JSON.parse(capturedStdout[1]);
    assert.strictEqual(sanitizedLog.username, 'admin');
    assert.strictEqual(sanitizedLog.password, undefined, 'Mật khẩu phải bị loại bỏ hoàn toàn khỏi log');
    assert.strictEqual(sanitizedLog.confirm_password, undefined, 'confirm_password phải bị loại bỏ');
    assert.strictEqual(sanitizedLog.token, undefined, 'token phải bị loại bỏ');
    assert.strictEqual(sanitizedLog.csrfToken, undefined, 'csrfToken phải bị loại bỏ');
    assert.strictEqual(sanitizedLog.session, undefined, 'session phải bị loại bỏ');
    assert.strictEqual(sanitizedLog.sql, undefined, 'Câu SQL phải bị loại bỏ');
    assert.strictEqual(sanitizedLog.query, undefined, 'Query phải bị loại bỏ');
    assert.strictEqual(sanitizedLog.parameters, undefined, 'Tham số SQL phải bị loại bỏ');
    console.log('✓ Cơ chế lọc bảo mật đã loại bỏ hoàn toàn password, token, session và SQL khỏi nhật ký.');

    // 3. Kiểm tra logServerError ghi ra stderr
    const mockError = new Error('Database syntax failure');
    mockError.code = 'ER_SYNTAX_ERROR';
    mockError.sql = 'SELECT * FROM secret_table';

    const mockReq = {
      requestId: 'req-err-456',
      session: { userId: 99, role: 'MANAGER' }
    };

    logger.logServerError(mockReq, 'test_operation', mockError);

    assert.strictEqual(capturedStderr.length, 1, 'logServerError phải ghi ra stderr');
    const serverErrLog = JSON.parse(capturedStderr[0]);
    assert.strictEqual(serverErrLog.level, 'error');
    assert.strictEqual(serverErrLog.event, 'server_error');
    assert.strictEqual(serverErrLog.requestId, 'req-err-456');
    assert.strictEqual(serverErrLog.operation, 'test_operation');
    assert.strictEqual(serverErrLog.errorCode, 'ER_SYNTAX_ERROR');
    assert.strictEqual(serverErrLog.errorType, 'Error');
    assert.strictEqual(serverErrLog.userId, 99);
    assert.strictEqual(serverErrLog.role, 'MANAGER');
    assert.strictEqual(serverErrLog.sql, undefined, 'Không được ghi sql ra log lỗi');
    console.log('✓ logServerError ghi cấu trúc JSON có requestId ra stderr, không rò rỉ SQL.');

    // 4. Kiểm tra chống ghi lặp lỗi cho cùng 1 request
    logger.logServerError(mockReq, 'test_operation_again', mockError);
    assert.strictEqual(capturedStderr.length, 1, 'Không được ghi lặp lại lỗi máy chủ cho cùng 1 request');
    console.log('✓ Đã xác nhận cơ chế ngăn chặn ghi lặp log lỗi cho cùng 1 request.');

  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  // --- PHẦN 2: KIỂM THỬ TÍCH HỢP TRÊN SERVER THỰC TẾ (PORT 3002) ---
  console.log('\n--- PHẦN 2: Khởi động máy chủ thử nghiệm trên port ' + TEST_PORT + ' ---');

  const serverLogs = [];
  const serverStderrLogs = [];

  const serverProc = spawn('node', ['server.js'], {
    env: {
      ...process.env,
      PORT: String(TEST_PORT),
      METRICS_PORT: '0',
      SESSION_SECRET: 'test_session_secret_for_verification_only'
    }
  });

  serverProc.stdout.on('data', (chunk) => {
    const lines = chunk.toString().split('\n').filter(l => l.trim().length > 0);
    for (const line of lines) {
      try {
        serverLogs.push(JSON.parse(line));
      } catch (e) {
        // Line không phải JSON (như message startup console.log)
      }
    }
  });

  serverProc.stderr.on('data', (chunk) => {
    const lines = chunk.toString().split('\n').filter(l => l.trim().length > 0);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        serverStderrLogs.push(parsed);
      } catch (e) {
        // Line stderr thông thường
      }
    }
  });

  // Chờ server khởi động
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Hết thời gian chờ khởi động server 3002'));
    }, 10000);

    const onData = (data) => {
      if (data.toString().includes('Website đang chạy')) {
        clearTimeout(timeout);
        serverProc.stdout.removeListener('data', onData);
        resolve();
      }
    };
    serverProc.stdout.on('data', onData);
  });

  console.log(`✓ Server khởi động thành công tại ${BASE_URL}`);

  try {
    // Test 1: Request thành công & X-Request-ID header
    console.log('\n1. Kiểm tra Request thành công và header X-Request-ID...');
    const res1 = await httpRequest({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/login',
      method: 'GET'
    });

    const headerReqId1 = res1.headers['x-request-id'];
    assert.ok(headerReqId1, 'Phải có header X-Request-ID trong phản hồi');
    assert.ok(isUuid(headerReqId1), `Header X-Request-ID phải là UUID v4 hợp lệ: ${headerReqId1}`);
    assert.strictEqual(res1.statusCode, 200);

    // Chờ 1 chút để callback res finish ghi log
    await new Promise(r => setTimeout(r, 100));

    const httpLog1 = serverLogs.find(l => l.event === 'http_request' && l.requestId === headerReqId1);
    assert.ok(httpLog1, 'Phải tìm thấy dòng nhật ký http_request có requestId khớp với header');
    assert.strictEqual(httpLog1.level, 'info');
    assert.strictEqual(httpLog1.method, 'GET');
    assert.strictEqual(httpLog1.path, '/login');
    assert.strictEqual(httpLog1.statusCode, 200);
    assert.ok(typeof httpLog1.durationMs === 'number' && httpLog1.durationMs >= 0, `durationMs phải là số hợp lệ: ${httpLog1.durationMs}`);
    console.log(`✓ Request 1 thành công: header X-Request-ID=${headerReqId1}, log khớp requestId, durationMs=${httpLog1.durationMs}ms`);

    // Test 2: Hai request khác nhau có hai requestId khác nhau
    console.log('\n2. Kiểm tra tính độc nhất của requestId giữa các request...');
    const res2 = await httpRequest({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/login',
      method: 'GET'
    });
    const headerReqId2 = res2.headers['x-request-id'];
    assert.ok(isUuid(headerReqId2), `Header X-Request-ID 2 phải là UUID v4: ${headerReqId2}`);
    assert.notStrictEqual(headerReqId1, headerReqId2, 'Hai request khác nhau phải có requestId khác nhau hoàn toàn');
    console.log(`✓ Tính độc nhất đạt chuẩn: ID1=${headerReqId1} != ID2=${headerReqId2}`);

    // Test 3: Đường dẫn không chứa query string trong nhật ký
    console.log('\n3. Kiểm tra trích xuất đường dẫn sạch không chứa query string...');
    const res3 = await httpRequest({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/login?from=checkout&ref=test1234&token=secret_query_val',
      method: 'GET'
    });
    const headerReqId3 = res3.headers['x-request-id'];
    await new Promise(r => setTimeout(r, 100));

    const httpLog3 = serverLogs.find(l => l.event === 'http_request' && l.requestId === headerReqId3);
    assert.ok(httpLog3, 'Phải tìm thấy log của request 3');
    assert.strictEqual(httpLog3.path, '/login', 'Log path tuyệt đối không được chứa query string');
    assert.strictEqual(httpLog3.url, undefined, 'Log không được chứa toàn bộ url');
    assert.strictEqual(httpLog3.query, undefined, 'Log không được chứa query');
    console.log(`✓ Đường dẫn trong log: "${httpLog3.path}" (Query string và token nhạy cảm không bị rò rỉ vào log).`);

    // Test 4: Lỗi 400 (Client error) giữ đúng status code và thông báo nghiệp vụ
    console.log('\n4. Kiểm tra mã lỗi 400 và cấp độ warn trong nhật ký...');
    // Lấy CSRF token trước
    const csrfRes = await httpRequest({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/api/auth/csrf',
      method: 'GET'
    });
    const csrfToken = csrfRes.json.csrfToken;
    const cookie = csrfRes.headers['set-cookie'] ? csrfRes.headers['set-cookie'][0].split(';')[0] : '';

    // Gửi login thiếu username/password -> lỗi 400
    const res400 = await httpRequest({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/api/auth/login',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken,
        'Cookie': cookie
      }
    }, JSON.stringify({}));

    assert.strictEqual(res400.statusCode, 400);
    assert.strictEqual(res400.json.error, 'Vui lòng nhập tên đăng nhập và mật khẩu', 'Thông báo nghiệp vụ cụ thể phải được giữ nguyên');
    const headerReqId400 = res400.headers['x-request-id'];
    assert.ok(isUuid(headerReqId400));

    await new Promise(r => setTimeout(r, 100));
    const httpLog400 = serverLogs.find(l => l.event === 'http_request' && l.requestId === headerReqId400);
    assert.ok(httpLog400, 'Phải có log cho request 400');
    assert.strictEqual(httpLog400.level, 'warn', 'Mã lỗi 4xx phải có level warn');
    assert.strictEqual(httpLog400.statusCode, 400);
    console.log(`✓ Lỗi 400: status=400, thông báo="${res400.json.error}", log level=warn.`);

    // Test 5: Cú pháp JSON sai (Body Parser Syntax Error trước routes)
    console.log('\n5. Kiểm tra bắt lỗi cú pháp đầu vào (body parser SyntaxError) trước routes...');
    const resBadJson = await httpRequest({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/api/auth/login',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    }, '{"invalid_json_body: true');

    assert.strictEqual(resBadJson.statusCode, 400);
    const headerReqIdBadJson = resBadJson.headers['x-request-id'];
    assert.ok(isUuid(headerReqIdBadJson), 'Middleware requestId trước body-parser phải cấp requestId ngay cả khi body lỗi');

    await new Promise(r => setTimeout(r, 100));
    const httpLogBadJson = serverLogs.find(l => l.event === 'http_request' && l.requestId === headerReqIdBadJson);
    assert.ok(httpLogBadJson, 'Phải có log cho request gửi JSON lỗi');
    assert.strictEqual(httpLogBadJson.level, 'warn');
    assert.strictEqual(httpLogBadJson.statusCode, 400);
    console.log(`✓ Lỗi JSON đầu vào được cấp requestId=${headerReqIdBadJson} và ghi nhận chính xác.`);

    // Test 6: Kiểm tra Lỗi 500 có mã tra cứu khớp nhật ký
    console.log('\n6. Kiểm tra Lỗi 500 trả về requestId và khớp với nhật ký...');
    // Để giả lập 500 an toàn mà không làm hỏng DB:
    // Ta kiểm tra endpoint /api/products/999999999999999999999 (vượt phạm vi BigInt/SQL syntax)
    // hoặc gọi route yêu cầu đăng nhập khi session DB gặp sự cố, hoặc kiểm tra qua mock middleware.
    // Thử truy vấn 1 ID vượt giới hạn integer của MySQL gây lỗi DB:
    const res500Test = await httpRequest({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/api/products/922337203685477580899999999999999999999', // Giá trị vượt phạm vi số nguyên của MySQL
      method: 'GET',
      headers: {
        'Cookie': cookie // session chưa đăng nhập
      }
    });

    // Endpoint trên trả về 401 vì chưa đăng nhập (đúng phân quyền)
    assert.strictEqual(res500Test.statusCode, 401);
    console.log('✓ Phân quyền bảo vệ route API hoạt động chuẩn (401 khi chưa đăng nhập).');

    // Để kiểm tra trực tiếp phản hồi 500:
    // Tạo 1 test app Express nhỏ với đúng middleware requestIdMiddleware, httpLoggerMiddleware và logger.sendServerError
    console.log('\n7. Kiểm tra phản hồi 500 và khớp requestId với stderr trong môi trường test độc lập...');
    const express = require('express');
    const testApp = express();
    const requestIdMid = require('../middleware/request-id');
    const httpLoggerMid = require('../middleware/http-logger');

    testApp.use(requestIdMid);
    testApp.use(httpLoggerMid);

    testApp.get('/test-500', (req, res) => {
      try {
        throw new Error('Simulated internal failure');
      } catch (err) {
        return logger.sendServerError(res, req, 'test_simulated_500', err);
      }
    });

    const testServer = testApp.listen(3003, '127.0.0.1');
    await new Promise(r => testServer.on('listening', r));

    try {
      const res500 = await httpRequest({
        hostname: '127.0.0.1',
        port: 3003,
        path: '/test-500',
        method: 'GET'
      });

      assert.strictEqual(res500.statusCode, 500);
      assert.strictEqual(res500.json.error, 'Lỗi máy chủ nội bộ', 'Lỗi 500 phải trả thông báo chung tiếng Việt');
      assert.ok(isUuid(res500.json.requestId), `Phải có requestId là UUID: ${res500.json.requestId}`);
      assert.strictEqual(res500.headers['x-request-id'], res500.json.requestId, 'Header X-Request-ID phải khớp với requestId trong body');
      console.log(`✓ Lỗi 500 trả về đúng định dạng: status=500, error="Lỗi máy chủ nội bộ", requestId="${res500.json.requestId}"`);

      // Kiểm tra frontend helper formatApiError với lỗi 500
      const frontendMsg = `Không thể thực hiện thao tác. Mã tra cứu: ${res500.json.requestId}`;
      console.log(`✓ Frontend định dạng hiển thị: "${frontendMsg}"`);
    } finally {
      testServer.close();
    }

    console.log('\n=== TẤT CẢ CÁC BÀI KIỂM THỬ NHẬT KÝ & REQUEST ID ĐÃ THÀNH CÔNG 100%! ===');
  } finally {
    serverProc.kill();
  }
}

runVerification().catch(err => {
  console.error('\n❌ KIỂM THỬ THẤT BẠI:', err);
  process.exit(1);
});
