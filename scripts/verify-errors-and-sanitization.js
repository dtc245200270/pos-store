require('dotenv').config();
const http = require('http');
const express = require('express');
const assert = require('assert');
const requestIdMiddleware = require('../middleware/request-id');
const httpLoggerMiddleware = require('../middleware/http-logger');
const logger = require('../config/logger');

const TEST_PORT = 3008;

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

async function runTest() {
  console.log('================================================================');
  console.log('KIỂM THỬ ĐỘC LẬP: LỖI 400/403, GIẢ LẬP 500 VÀ BẢO MẬT NHẬT KÝ');
  console.log('================================================================\n');

  // Mảng thu thập log stdout và stderr
  const capturedLogs = [];

  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;

  process.stdout.write = function (str, encoding, cb) {
    if (typeof str === 'string' && str.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(str.trim());
        capturedLogs.push({ stream: 'stdout', ...parsed });
      } catch (e) {}
    }
    return originalStdoutWrite.call(process.stdout, str, encoding, cb);
  };

  process.stderr.write = function (str, encoding, cb) {
    if (typeof str === 'string' && str.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(str.trim());
        capturedLogs.push({ stream: 'stderr', ...parsed });
      } catch (e) {}
    }
    return originalStderrWrite.call(process.stderr, str, encoding, cb);
  };

  // Khởi tạo app test độc lập
  const app = express();
  app.use(requestIdMiddleware);
  app.use(httpLoggerMiddleware);
  app.use(express.json());

  // Route 1: Giả lập lỗi 400 (Bad Request)
  app.post('/test/bad-request', (req, res) => {
    const { name } = req.body || {};
    if (!name) {
      return res.status(400).json({ error: 'Tên sản phẩm không được để trống' });
    }
    res.json({ success: true });
  });

  // Route 2: Giả lập lỗi 403 (Forbidden)
  app.get('/test/forbidden', (req, res) => {
    return res.status(403).json({ error: 'Chỉ Quản lý (MANAGER) mới có quyền truy cập.' });
  });

  // Route 3: Giả lập lỗi 500 (Internal Server Error)
  app.get('/test/server-error', (req, res) => {
    try {
      const err = new Error('Lỗi truy vấn cơ sở dữ liệu giả lập (Connection Timeout)');
      err.code = 'ER_SIMULATED_FAIL';
      throw err;
    } catch (error) {
      return logger.sendServerError(res, req, 'simulated_query_operation', error);
    }
  });

  const server = http.createServer(app);
  await new Promise(r => server.listen(TEST_PORT, '127.0.0.1', r));
  console.log(`[OK] Test server đã khởi động riêng tại cổng ${TEST_PORT} (không ảnh hưởng cổng 3000)`);

  const results = {};

  try {
    // ------------------------------------------------------------------------
    // KIỂM THỬ 1: Lỗi 400
    // ------------------------------------------------------------------------
    console.log('\n--- BÀI TEST 1: Lỗi 400 (Bad Request) ---');
    const res400 = await httpRequest({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/test/bad-request',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, JSON.stringify({})); // Body rỗng gây lỗi 400

    const reqId400 = res400.headers['x-request-id'];
    assert.strictEqual(res400.statusCode, 400, 'Status code phải là 400');
    assert.ok(isUuid(reqId400), 'Header X-Request-ID phải là UUID v4');

    await new Promise(r => setTimeout(r, 60));
    const log400 = capturedLogs.find(l => l.event === 'http_request' && l.requestId === reqId400);
    assert.ok(log400, 'Phải tìm thấy log http_request khớp requestId');
    assert.strictEqual(log400.statusCode, 400, 'statusCode trong log phải là 400');
    assert.strictEqual(log400.level, 'warn', 'Mã lỗi 400 phải ghi ở level warn');

    results.test400 = {
      statusCode: res400.statusCode,
      headerRequestId: reqId400,
      logRequestId: log400.requestId,
      matched: reqId400 === log400.requestId,
      logLevel: log400.level,
      durationMs: log400.durationMs,
      logSample: log400
    };
    console.log(`✓ Lỗi 400 thành công: statusCode=${res400.statusCode}, Header X-Request-ID khớp Log (${reqId400}), log level=${log400.level}`);

    // ------------------------------------------------------------------------
    // KIỂM THỬ 2: Lỗi 403
    // ------------------------------------------------------------------------
    console.log('\n--- BÀI TEST 2: Lỗi 403 (Forbidden) ---');
    const res403 = await httpRequest({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/test/forbidden',
      method: 'GET'
    });

    const reqId403 = res403.headers['x-request-id'];
    assert.strictEqual(res403.statusCode, 403, 'Status code phải là 403');
    assert.ok(isUuid(reqId403), 'Header X-Request-ID phải là UUID v4');

    await new Promise(r => setTimeout(r, 60));
    const log403 = capturedLogs.find(l => l.event === 'http_request' && l.requestId === reqId403);
    assert.ok(log403, 'Phải tìm thấy log http_request khớp requestId');
    assert.strictEqual(log403.statusCode, 403, 'statusCode trong log phải là 403');
    assert.strictEqual(log403.level, 'warn', 'Mã lỗi 403 phải ghi ở level warn');

    results.test403 = {
      statusCode: res403.statusCode,
      headerRequestId: reqId403,
      logRequestId: log403.requestId,
      matched: reqId403 === log403.requestId,
      logLevel: log403.level,
      durationMs: log403.durationMs,
      logSample: log403
    };
    console.log(`✓ Lỗi 403 thành công: statusCode=${res403.statusCode}, Header X-Request-ID khớp Log (${reqId403}), log level=${log403.level}`);

    // ------------------------------------------------------------------------
    // KIỂM THỬ 3: Giả lập Lỗi 500
    // ------------------------------------------------------------------------
    console.log('\n--- BÀI TEST 3: Giả lập lỗi 500 (Internal Server Error) ---');
    const res500 = await httpRequest({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/test/server-error',
      method: 'GET'
    });

    const reqId500Header = res500.headers['x-request-id'];
    const reqId500Body = res500.json?.requestId;
    assert.strictEqual(res500.statusCode, 500, 'Status code phải là 500');
    assert.strictEqual(res500.json?.error, 'Lỗi máy chủ nội bộ', 'Phải ẩn thông tin kỹ thuật, trả lỗi tiếng Việt');
    assert.ok(isUuid(reqId500Header), 'Header X-Request-ID phải là UUID');
    assert.strictEqual(reqId500Header, reqId500Body, 'Header X-Request-ID phải trùng mã tra cứu trong body');

    await new Promise(r => setTimeout(r, 60));
    const errLog500 = capturedLogs.find(l => l.event === 'server_error' && l.requestId === reqId500Header);
    const httpLog500 = capturedLogs.find(l => l.event === 'http_request' && l.requestId === reqId500Header);

    assert.ok(errLog500, 'Phải tìm thấy log server_error trong stderr');
    assert.strictEqual(errLog500.stream, 'stderr');
    assert.strictEqual(errLog500.level, 'error');
    assert.strictEqual(errLog500.errorCode, 'ER_SIMULATED_FAIL');
    assert.strictEqual(errLog500.requestId, reqId500Header, 'requestId trong log lỗi phải khớp mã tra cứu');

    assert.ok(httpLog500, 'Phải tìm thấy log http_request');
    assert.strictEqual(httpLog500.level, 'error');
    assert.strictEqual(httpLog500.statusCode, 500);

    results.test500 = {
      statusCode: res500.statusCode,
      bodyError: res500.json.error,
      bodyRequestId: reqId500Body,
      headerRequestId: reqId500Header,
      serverErrorLogRequestId: errLog500.requestId,
      matched: reqId500Header === reqId500Body && reqId500Header === errLog500.requestId,
      serverErrorLog: errLog500,
      httpLog: httpLog500
    };
    console.log(`✓ Lỗi 500 thành công: statusCode=500, Body requestId=${reqId500Body}, Header=${reqId500Header}, Log=${errLog500.requestId} (Trùng khớp 100%)`);

    // ------------------------------------------------------------------------
    // KIỂM THỬ 4: Kiểm tra loại bỏ thông tin nhạy cảm (Sanitization)
    // ------------------------------------------------------------------------
    console.log('\n--- BÀI TEST 4: Bảo mật - Loại bỏ thông tin nhạy cảm ---');
    const sensitivePayload = {
      event: 'user_action_sensitive_test',
      requestId: 'test-sanitize-999',
      username: 'cashier01',
      // Dữ liệu nhạy cảm bắt buộc phải bị loại bỏ:
      password: 'PlainPassword123!',
      password_hash: '$2a$10$abcdefghijklmnopqrstuvwxyz',
      current_password: 'OldPassword123!',
      token: 'bearer_token_xyz987',
      csrfToken: 'csrf_secret_token_111',
      'x-csrf-token': 'header_csrf_val',
      cookie: 'connect.sid=s%3Aabc123secret',
      session: 'express_session_payload',
      db_password: 'root_password_secret',
      sql: 'SELECT * FROM users WHERE password = "abc"'
    };

    logger.info(sensitivePayload);

    const sanitizeLogEntry = capturedLogs.find(l => l.event === 'user_action_sensitive_test');
    assert.ok(sanitizeLogEntry, 'Phải ghi log');

    // Kiểm tra các trường nhạy cảm
    const sensitiveKeys = [
      'password',
      'password_hash',
      'current_password',
      'token',
      'csrfToken',
      'x-csrf-token',
      'cookie',
      'session',
      'db_password',
      'sql'
    ];

    const leakedKeys = [];
    for (const key of sensitiveKeys) {
      if (sanitizeLogEntry[key] !== undefined) {
        leakedKeys.push(key);
      }
    }

    assert.strictEqual(leakedKeys.length, 0, `Các trường nhạy cảm bị rò rỉ: ${leakedKeys.join(', ')}`);
    assert.strictEqual(sanitizeLogEntry.username, 'cashier01', 'Trường an toàn (username) phải được giữ lại');
    assert.strictEqual(sanitizeLogEntry.requestId, 'test-sanitize-999', 'Trường an toàn (requestId) phải được giữ lại');

    results.testSanitization = {
      testedKeys: sensitiveKeys,
      leakedKeys,
      isCompletelySafe: leakedKeys.length === 0,
      sanitizedLog: sanitizeLogEntry
    };
    console.log(`✓ Bảo mật dữ liệu nhạy cảm thành công: Tất cả các trường (${sensitiveKeys.join(', ')}) đều bị loại bỏ 100%!`);

    console.log('\n=== TẤT CẢ CÁC BÀI KIỂM THỬ ĐÃ HOÀN TẤT VÀ VƯỢT QUA 100% ===');
    console.log('JSON_RESULTS_START');
    console.log(JSON.stringify(results, null, 2));
    console.log('JSON_RESULTS_END');

  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    await new Promise(r => server.close(r));
    console.log(`\n[OK] Đã đóng test server cổng ${TEST_PORT} an toàn.`);
  }
}

runTest().catch(err => {
  console.error('[FAIL] Kiểm thử thất bại:', err);
  process.exit(1);
});
