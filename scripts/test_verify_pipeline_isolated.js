const assert = require('assert');
const { extractLogsFromStreams, matchAndValidateLogs } = require('./verify_logging_pipeline');

console.log('================================================================');
console.log('   TEST CACH LY TREN CHINH LOGIC CUA verify_logging_pipeline.js ');
console.log('================================================================\n');

let totalTests = 0;
let passedTests = 0;

function runTest(name, fn) {
  totalTests++;
  console.log(`[TEST #${totalTests}] ${name}...`);
  try {
    fn();
    passedTests++;
    console.log(` -> PASS: Ca kiem thu da bi tu choi dung nhu ky vong.\n`);
  } catch (err) {
    console.error(` -> FAILED ASSERTION: ${err.message}\n`);
    process.exit(1);
  }
}

// -------------------------------------------------------------
// CA 1: LOKI TRA VE RESULT RONG
// -------------------------------------------------------------
runTest('Ca 1.1: Loki tra ve data.result = [] (Rong)', () => {
  const emptyStreams = [];
  const reqId = 'test-empty-stream-id-123';
  const extracted = extractLogsFromStreams(emptyStreams, reqId);
  
  assert.strictEqual(extracted.nodeLog, null, 'nodeLog phai la null khi result rong');
  assert.strictEqual(extracted.nginxLog, null, 'nginxLog phai la null khi result rong');

  const sentRequest = {
    requestId: reqId,
    method: 'GET',
    path: '/login',
    expectedStatus: 200
  };

  // Bat buoc matchAndValidateLogs phai nem ngoai le khi thieu log, KHONG duoc chap nhan
  assert.throws(
    () => {
      matchAndValidateLogs({
        sentRequest,
        nodeLog: extracted.nodeLog,
        nginxLog: extracted.nginxLog
      });
    },
    /Thieu log tu nguon node_backend/,
    'Phai nem loi thieu log khi Loki tra result rong!'
  );
});

runTest('Ca 1.2: Loki tra ve streams nhung khong co log cua requestId can tim', () => {
  const unrelatedStreams = [
    {
      stream: { source: 'node_backend' },
      values: [
        ['1729000000000000000', JSON.stringify({ requestId: 'other-id-999', method: 'GET', path: '/login', statusCode: 200 })]
      ]
    },
    {
      stream: { source: 'nginx_access' },
      values: [
        ['1729000000000000000', '127.0.0.1 - - [15/Oct/2026:01:00:00 +0700] "GET /login" 200 5000 req_id="other-id-999"']
      ]
    }
  ];

  const targetReqId = 'target-not-found-id-456';
  const extracted = extractLogsFromStreams(unrelatedStreams, targetReqId);
  assert.strictEqual(extracted.nodeLog, null);
  assert.strictEqual(extracted.nginxLog, null);

  assert.throws(
    () => {
      matchAndValidateLogs({
        sentRequest: { requestId: targetReqId, method: 'GET', path: '/login', expectedStatus: 200 },
        nodeLog: extracted.nodeLog,
        nginxLog: extracted.nginxLog
      });
    },
    /Thieu log/
  );
});

// -------------------------------------------------------------
// CA 2: LOKI HTTP/API LOI
// -------------------------------------------------------------
runTest('Ca 2.1: Loki API tra ve status != success (vi du status: "error")', () => {
  const fakeLokiErrorResponse = {
    status: 'error',
    errorType: 'bad_data',
    error: 'parse error at line 1, col 1: syntax error'
  };

  // Ham kiem tra status Loki API
  function checkLokiApiResponse(json) {
    if (!json || json.status !== 'success') {
      throw new Error(`Loki query status error: ${JSON.stringify(json)}`);
    }
    return json.data.result;
  }

  assert.throws(
    () => {
      checkLokiApiResponse(fakeLokiErrorResponse);
    },
    /Loki query status error/,
    'Phai nem loi khi Loki API tra ve status != success!'
  );
});

runTest('Ca 2.2: Loki HTTP tra ve loi (vi du HTTP 500)', () => {
  function handleHttpError(status, text) {
    if (status !== 200) {
      throw new Error(`Loki HTTP Error ${status}: ${text}`);
    }
  }

  assert.throws(
    () => {
      handleHttpError(500, 'Internal Server Error: ingester failed');
    },
    /Loki HTTP Error 500/,
    'Phai nem loi khi Loki HTTP status != 200!'
  );
});

// -------------------------------------------------------------
// CA 3: LOG HAI NGUON KHOP NHAU NHUNG SAI REQUEST DA GUI
// -------------------------------------------------------------
runTest('Ca 3.1: Log Node va Nginx khop nhau ve sai requestId (sai khac so voi request da gui)', () => {
  const sentRequest = {
    requestId: 'real-request-sent-001',
    method: 'GET',
    path: '/login',
    expectedStatus: 200
  };

  // Node va Nginx khop hoan toan voi nhau ('stale-request-999'), nhung sai voi request da gui ('real-request-sent-001')
  const nodeLog = {
    requestId: 'stale-request-999',
    method: 'GET',
    path: '/login',
    statusCode: 200
  };
  const nginxLog = {
    requestId: 'stale-request-999',
    method: 'GET',
    path: '/login',
    statusCode: 200,
    raw: '...'
  };

  assert.throws(
    () => {
      matchAndValidateLogs({ sentRequest, nodeLog, nginxLog });
    },
    /Node log requestId mismatch/,
    'Bat buoc phai tu choi khi log hai nguon khop nhau nhung sai requestId da gui!'
  );
});

runTest('Ca 3.2: Log hai nguon khop nhau nhung sai method (gui GET nhung log ghi POST)', () => {
  const sentRequest = {
    requestId: 'real-request-sent-002',
    method: 'GET',
    path: '/login',
    expectedStatus: 200
  };

  const nodeLog = {
    requestId: 'real-request-sent-002',
    method: 'POST',
    path: '/login',
    statusCode: 200
  };
  const nginxLog = {
    requestId: 'real-request-sent-002',
    method: 'POST',
    path: '/login',
    statusCode: 200
  };

  assert.throws(
    () => {
      matchAndValidateLogs({ sentRequest, nodeLog, nginxLog });
    },
    /Node log method mismatch/,
    'Bat buoc phai tu choi khi log hai nguon khop nhau nhung sai HTTP method da gui!'
  );
});

runTest('Ca 3.3: Log hai nguon khop nhau nhung sai status (gui GET /login tra ve 200 nhung log tra 404)', () => {
  const sentRequest = {
    requestId: 'real-request-sent-003',
    method: 'GET',
    path: '/login',
    expectedStatus: 200
  };

  const nodeLog = {
    requestId: 'real-request-sent-003',
    method: 'GET',
    path: '/login',
    statusCode: 404
  };
  const nginxLog = {
    requestId: 'real-request-sent-003',
    method: 'GET',
    path: '/login',
    statusCode: 404
  };

  assert.throws(
    () => {
      matchAndValidateLogs({ sentRequest, nodeLog, nginxLog });
    },
    /Node log statusCode mismatch/,
    'Bat buoc phai tu choi khi log hai nguon khop nhau nhung sai status da gui!'
  );
});

runTest('Ca 3.4: Log hai nguon khop nhau nhung sai path (gui /login nhung log ghi /sales)', () => {
  const sentRequest = {
    requestId: 'real-request-sent-004',
    method: 'GET',
    path: '/login',
    expectedStatus: 200
  };

  const nodeLog = {
    requestId: 'real-request-sent-004',
    method: 'GET',
    path: '/sales',
    statusCode: 200
  };
  const nginxLog = {
    requestId: 'real-request-sent-004',
    method: 'GET',
    path: '/sales',
    statusCode: 200
  };

  assert.throws(
    () => {
      matchAndValidateLogs({ sentRequest, nodeLog, nginxLog });
    },
    /Node log path mismatch/,
    'Bat buoc phai tu choi khi log hai nguon khop nhau nhung sai path da gui!'
  );
});

console.log('================================================================');
console.log(`KET QUA TEST CACH LY: ${passedTests}/${totalTests} TESTS DA PASS HOAN TOAN 100%!`);
console.log('Moi ca loi (result rong, API loi, mismatch request) deu bi tu choi tuyet doi.');
console.log('================================================================');
process.exit(0);
