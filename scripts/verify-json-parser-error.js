const http = require('http');
const assert = require('assert');
const fs = require('fs');

const TEST_PORT = 3000;
const FAKE_MARKER = 'SECRET_MARKER_LEAK_CHECK_987654321';

function httpRequest(options, postData) {
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
          rawBody: data,
          json
        });
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

function isUuid(str) {
  return typeof str === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(str);
}

async function run() {
  console.log('================================================================');
  console.log('KIỂM THỬ XỬ LÝ LỖI JSON PARSER VÀ BẢO MẬT PHẢN HỒI (SERVER.JS)');
  console.log('================================================================\n');

  // Gửi body JSON cố tình bị sai cú pháp và chứa dấu nhận diện giả
  const malformedJsonBody = `{"name": "test", "marker": "${FAKE_MARKER}", "bad_json: `;

  console.log('1. Gửi request POST với body JSON sai cú pháp chứa dấu nhận diện giả...');
  const res = await httpRequest({
    hostname: '127.0.0.1',
    port: TEST_PORT,
    path: '/api/auth/login',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(malformedJsonBody)
    }
  }, malformedJsonBody);

  const reqId = res.headers['x-request-id'];

  console.log('STATUS_CODE:', res.statusCode);
  console.log('X_REQUEST_ID:', reqId);
  console.log('RESPONSE_BODY:', res.rawBody);

  // 1. Kiểm tra status code = 400
  assert.strictEqual(res.statusCode, 400, 'Lỗi JSON phải trả về HTTP 400');

  // 2. Kiểm tra thông báo lỗi an toàn
  assert.strictEqual(res.json?.error, 'Dữ liệu JSON không hợp lệ', 'Thông báo lỗi phải là "Dữ liệu JSON không hợp lệ"');

  // 3. Phản hồi không chứa dấu nhận diện giả
  assert.strictEqual(res.rawBody.includes(FAKE_MARKER), false, 'Phản hồi tuyệt đối không được rò rỉ dấu nhận diện giả');

  // 4. Phản hồi không chứa stack trace hoặc parser message nội bộ
  assert.strictEqual(res.rawBody.includes('SyntaxError'), false, 'Phản hồi không được chứa SyntaxError');
  assert.strictEqual(res.rawBody.includes('Unexpected token'), false, 'Phản hồi không được chứa thông báo lỗi parser mặc định');
  assert.strictEqual(res.rawBody.includes('at '), false, 'Phản hồi không được chứa stack trace');

  // 5. Header X-Request-ID vẫn có và là UUID v4
  assert.ok(isUuid(reqId), 'Header X-Request-ID phải là UUID v4 hợp lệ');

  // 6. Kiểm tra nhật ký máy chủ có mức warn và requestId tương ứng
  console.log('\n2. Kiểm tra nhật ký máy chủ (Server Task Log)...');
  await new Promise(r => setTimeout(r, 200));

  const taskLogPath = 'C:\\Users\\Dell Precision 5550\\.gemini\\antigravity-ide\\brain\\18b59c8e-1bac-46c2-81ca-d6e650c2d45f\\.system_generated\\tasks\\task-317.log';
  let matchedLog = null;
  if (fs.existsSync(taskLogPath)) {
    const lines = fs.readFileSync(taskLogPath, 'utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].includes(reqId)) {
        try {
          matchedLog = JSON.parse(lines[i]);
          break;
        } catch (e) {}
      }
    }
  }

  assert.ok(matchedLog, 'Phải tìm thấy dòng nhật ký khớp với requestId');
  console.log('LOG_RECORD:', JSON.stringify(matchedLog));
  assert.strictEqual(matchedLog.level, 'warn', 'Nhật ký cho lỗi 400 phải ở mức warn');
  assert.strictEqual(matchedLog.statusCode, 400, 'Nhật ký phải ghi nhận statusCode = 400');
  assert.strictEqual(matchedLog.requestId, reqId, 'Nhật ký phải có requestId trùng khớp');
  assert.strictEqual(JSON.stringify(matchedLog).includes(FAKE_MARKER), false, 'Nhật ký không được chứa dấu nhận diện giả');

  console.log('\n================================================================');
  console.log('KẾT QUẢ: TẤT CẢ CÁC ĐIỀU KIỆN KIỂM THỬ ĐÃ ĐẠT 100%!');
  console.log('================================================================');
}

run().catch(err => {
  console.error('\n❌ KIỂM THỬ THẤT BẠI:', err);
  process.exit(1);
});
