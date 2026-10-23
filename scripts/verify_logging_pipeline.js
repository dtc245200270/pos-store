const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const LOKI_URL = 'http://127.0.0.1:3100';
const ALLOY_URL = 'http://127.0.0.1:12345';
const NGINX_URL = 'http://127.0.0.1:8080';
const REPO_ROOT = path.resolve(__dirname, '..');

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function queryLoki(logql, limit = 50, startTime = null, endTime = null, retries = 5) {
  const query = encodeURIComponent(logql);
  let url = `${LOKI_URL}/loki/api/v1/query_range?query=${query}&limit=${limit}`;
  if (startTime) url += `&start=${startTime}`;
  if (endTime) url += `&end=${endTime}`;
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          'Connection': 'close',
          'Cache-Control': 'no-cache'
        }
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Loki HTTP Error ${res.status}: ${errText}`);
      }
      const json = await res.json();
      if (json.status !== 'success') {
        throw new Error(`Loki query status error: ${JSON.stringify(json)}`);
      }
      return json;
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(500);
    }
  }
}

function extractLogsFromStreams(streams, reqId) {
  let nodeLog = null;
  let nginxLog = null;

  for (const s of streams) {
    const source = s.stream?.source;
    if (source === 'node_backend') {
      for (const [ts, line] of s.values || []) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.requestId === reqId) {
            nodeLog = parsed;
            break;
          }
        } catch (_) {}
      }
    } else if (source === 'nginx_access') {
      for (const [ts, line] of s.values || []) {
        if (line.includes(reqId)) {
          // Nginx main log format: $remote_addr - $remote_user [$time_local] "$request_method $uri" $status $body_bytes_sent req_id="..." ...
          const match = line.match(/"([A-Z]+)\s+([^"]+)"\s+(\d+)\s+\d+\s+req_id="([^"]+)"/);
          if (match) {
            nginxLog = {
              raw: line,
              method: match[1],
              path: match[2],
              statusCode: Number(match[3]),
              requestId: match[4]
            };
            break;
          }
        }
      }
    }
  }

  return { nodeLog, nginxLog };
}

function matchAndValidateLogs({ sentRequest, nodeLog, nginxLog }) {
  if (!sentRequest || !sentRequest.requestId) {
    throw new Error('Yeu cau gui khong hop le hoac requestId bi rong!');
  }
  if (!nodeLog) {
    throw new Error(`Thieu log tu nguon node_backend cho request ${sentRequest.requestId}!`);
  }
  if (!nginxLog) {
    throw new Error(`Thieu log tu nguon nginx_access cho request ${sentRequest.requestId}!`);
  }

  // 1. Kiem tra tinh dong nhat cua Node log voi request da gui
  if (nodeLog.requestId !== sentRequest.requestId) {
    throw new Error(`Node log requestId mismatch: log co '${nodeLog.requestId}', yeu cau gui la '${sentRequest.requestId}'`);
  }
  if (nodeLog.method !== sentRequest.method) {
    throw new Error(`Node log method mismatch: log co '${nodeLog.method}', yeu cau gui la '${sentRequest.method}'`);
  }
  if (nodeLog.path !== sentRequest.path) {
    throw new Error(`Node log path mismatch: log co '${nodeLog.path}', yeu cau gui la '${sentRequest.path}'`);
  }
  if (nodeLog.statusCode !== sentRequest.expectedStatus) {
    throw new Error(`Node log statusCode mismatch: log co '${nodeLog.statusCode}', yeu cau gui la '${sentRequest.expectedStatus}'`);
  }

  // 2. Kiem tra tinh dong nhat cua Nginx log voi request da gui
  if (nginxLog.requestId !== sentRequest.requestId) {
    throw new Error(`Nginx log requestId mismatch: log co '${nginxLog.requestId}', yeu cau gui la '${sentRequest.requestId}'`);
  }
  if (nginxLog.method !== sentRequest.method) {
    throw new Error(`Nginx log method mismatch: log co '${nginxLog.method}', yeu cau gui la '${sentRequest.method}'`);
  }
  if (nginxLog.path !== sentRequest.path) {
    throw new Error(`Nginx log path mismatch: log co '${nginxLog.path}', yeu cau gui la '${sentRequest.path}'`);
  }
  if (nginxLog.statusCode !== sentRequest.expectedStatus) {
    throw new Error(`Nginx log statusCode mismatch: log co '${nginxLog.statusCode}', yeu cau gui la '${sentRequest.expectedStatus}'`);
  }

  return {
    matched: true,
    requestId: sentRequest.requestId,
    method: sentRequest.method,
    path: sentRequest.path,
    statusCode: sentRequest.expectedStatus
  };
}

async function pollLokiForLogs(reqId, timeoutMs = 12000, intervalMs = 300) {
  const start = Date.now();
  let lastStreamsCount = 0;

  while (Date.now() - start < timeoutMs) {
    const lokiRes = await queryLoki(`{app="pos_store"} |= "${reqId}"`);
    const streams = lokiRes.data?.result || [];
    lastStreamsCount = streams.length;

    const { nodeLog, nginxLog } = extractLogsFromStreams(streams, reqId);
    if (nodeLog && nginxLog) {
      return {
        nodeLog,
        nginxLog,
        streamsCount: streams.length,
        elapsedMs: Date.now() - start
      };
    }

    await sleep(intervalMs);
  }

  throw new Error(`Polling timeout (${timeoutMs}ms) cho request ${reqId}: Khong tim thay du ca hai nguon (Node va Nginx) trong Loki! (Streams tim thay: ${lastStreamsCount})`);
}

async function runPipelineVerification() {
  console.log('================================================================');
  console.log('   KIEM TRA NGHIEP THU TOAN DIEN PIPELINE LOKI + GRAFANA ALLOY  ');
  console.log('================================================================\n');

  const report = {
    executedAt: new Date().toISOString(),
    componentsHealth: {},
    requestsVerification: [],
    queriesDemonstration: {},
    restartPersistenceTest: {},
    status: 'PENDING'
  };

  const outDir = path.resolve(REPO_ROOT, 'deploy', 'logging', 'artifacts');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  const reportFile = path.join(outDir, 'loki_query_verification.json');

  const saveReportAndExit = (isSuccess, errMsg = null) => {
    report.status = isSuccess ? 'SUCCESS' : 'FAIL';
    if (errMsg) report.error = errMsg;
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf8');
    console.log(`\n[KET XUAT] Da ghi nhan bao cao (${report.status}) vao: ${reportFile}`);
    if (!isSuccess) {
      console.error('\n[THAT BAI] Pipeline verification gap loi assertion!');
      process.exit(1);
    } else {
      console.log('\n[PASS] Pipeline verification hoan tat va dat 100% assertions!');
      process.exit(0);
    }
  };

  try {
    // -------------------------------------------------------------
    // BƯỚC 1: KIỂM TRA SỨC KHỎE CỦA LOKI VÀ ALLOY
    // -------------------------------------------------------------
    console.log('[1/5] Kiem tra Loki /ready va Alloy health...');
    const lokiReadyRes = await fetch(`${LOKI_URL}/ready`);
    const lokiReadyText = await lokiReadyRes.text();
    const lokiIsReady = lokiReadyRes.status === 200 && lokiReadyText.trim() === 'ready';
    console.log(` - Loki /ready: HTTP ${lokiReadyRes.status} (${lokiReadyText.trim()})`);
    report.componentsHealth.loki = {
      status: lokiIsReady ? 'OK' : 'FAIL',
      statusCode: lokiReadyRes.status,
      response: lokiReadyText.trim()
    };
    if (!lokiIsReady) {
      throw new Error(`Loki khong o trang thai ready (Status: ${lokiReadyRes.status}, Body: ${lokiReadyText.trim()})`);
    }

    const alloyRes = await fetch(`${ALLOY_URL}/`);
    const alloyOk = alloyRes.status === 200;
    console.log(` - Alloy UI   : HTTP ${alloyRes.status}`);
    report.componentsHealth.alloy = {
      status: alloyOk ? 'OK' : 'FAIL',
      statusCode: alloyRes.status
    };
    if (!alloyOk) {
      throw new Error(`Alloy khong phan hoi HTTP 200 (Status: ${alloyRes.status})`);
    }

    // -------------------------------------------------------------
    // BƯỚC 2: GỬI 3 REQUEST GET /login QUA NGINX VÀ ĐỐI CHIẾU
    // -------------------------------------------------------------
    console.log('\n[2/5] Gui 3 request GET /login qua Nginx va doi chieu log theo tung request...');
    for (let i = 1; i <= 3; i++) {
      const res = await fetch(`${NGINX_URL}/login`, {
        headers: { 'Cache-Control': 'no-cache' }
      });
      const reqId = res.headers.get('x-request-id');
      const status = res.status;
      
      console.log(`\n -> Request #${i}:`);
      console.log(`    URL          : ${NGINX_URL}/login`);
      console.log(`    HTTP Status  : ${status}`);
      console.log(`    X-Request-ID : ${reqId}`);

      // Assertion: Status phai la 200 va requestId khong duoc rong
      if (status !== 200) {
        throw new Error(`Request #${i} GET /login tra ve HTTP status ${status} (ky vong: 200)`);
      }
      if (!reqId || reqId.trim() === '') {
        throw new Error(`Request #${i} GET /login khong co X-Request-ID hoac X-Request-ID bi rong!`);
      }

      // Polling co timeout qua Loki
      console.log(`    Dang polling Loki cho requestId: ${reqId}...`);
      const { nodeLog, nginxLog, elapsedMs } = await pollLokiForLogs(reqId, 10000, 300);
      console.log(`    [POLLING OK] Tim thay du ca 2 nguon log trong ${elapsedMs}ms.`);

      // Assertion doi chieu chat che voi chinh request da gui
      const sentRequest = {
        requestId: reqId,
        method: 'GET',
        path: '/login',
        expectedStatus: 200
      };

      const validation = matchAndValidateLogs({ sentRequest, nodeLog, nginxLog });
      console.log(`    [ASSERTION PASS] Log Node.js va Nginx khop 100% voi request da gui:`);
      console.log(`     * Node.js: method=${nodeLog.method}, path=${nodeLog.path}, status=${nodeLog.statusCode}, reqId=${nodeLog.requestId}`);
      console.log(`     * Nginx  : method=${nginxLog.method}, path=${nginxLog.path}, status=${nginxLog.statusCode}, reqId=${nginxLog.requestId}`);

      report.requestsVerification.push({
        requestIndex: i,
        sentRequest,
        elapsedMs,
        nodeLog,
        nginxLog,
        validation
      });
    }

    // -------------------------------------------------------------
    // BƯỚC 3: KIỂM TRA CA THỰC TẾ TRẢ VỀ 404 VÀ TRUY VẤN LỖI >= 400
    // -------------------------------------------------------------
    console.log('\n[3/5] Kiem tra ca thuc te tra ve HTTP 404 va doi chieu log loi >= 400...');
    
    // De tao mot request 404 thuc su trong routing hien co cua POS Store ma khong sua nghiep vu:
    // Nguoi dung dang nhap (Manager) truy cap san pham khong ton tai /api/products/99999999
    // Routing thuc te cua POS Store tra ve dung HTTP 404: { error: 'Không tìm thấy sản phẩm' }
    console.log(' - Lay CSRF token va dang nhap Manager qua API...');
    const csrfRes = await fetch(`${NGINX_URL}/api/auth/csrf`);
    const sessionCookie = csrfRes.headers.get('set-cookie');
    const csrfData = await csrfRes.json();
    if (!csrfData.csrfToken || !sessionCookie) {
      throw new Error('Khong the lay CSRF token hoac session cookie!');
    }

    const loginRes = await fetch(`${NGINX_URL}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-csrf-token': csrfData.csrfToken,
        'Cookie': sessionCookie
      },
      body: JSON.stringify({ username: 'manager', password: process.env.INITIAL_MANAGER_PASSWORD || 'ChangeThisStrongPass123!' })
    });
    if (loginRes.status !== 200) {
      throw new Error(`Dang nhap Manager that bai voi status: ${loginRes.status}`);
    }
    const authCookie = loginRes.headers.get('set-cookie') || sessionCookie;

    console.log(' - Gui GET /api/products/99999999 de sinh ma loi 404 tu nhien...');
    const path404 = '/api/products/99999999';
    const res404 = await fetch(`${NGINX_URL}${path404}`, {
      headers: { 'Cookie': authCookie }
    });
    const status404 = res404.status;
    const req404Id = res404.headers.get('x-request-id');
    console.log(`   HTTP Status : ${status404}`);
    console.log(`   X-Request-ID: ${req404Id}`);

    // Assertion bat buoc: Phai la phan hoi 404 thuc su va co reqId
    if (status404 !== 404) {
      throw new Error(`Ca 404 that bai: Phan hoi thuc te la HTTP ${status404} (ky vong: 404)`);
    }
    if (!req404Id || req404Id.trim() === '') {
      throw new Error('Ca 404 khong tra ve X-Request-ID!');
    }

    // Polling tim dung req404Id vua sinh trong Loki tren ca 2 nguon
    console.log(`   Dang polling Loki cho request 404 vua sinh: ${req404Id}...`);
    const poll404Result = await pollLokiForLogs(req404Id, 10000, 300);
    const sent404Request = {
      requestId: req404Id,
      method: 'GET',
      path: path404,
      expectedStatus: 404
    };
    const validation404 = matchAndValidateLogs({
      sentRequest: sent404Request,
      nodeLog: poll404Result.nodeLog,
      nginxLog: poll404Result.nginxLog
    });
    console.log(`   [ASSERTION PASS] Log 404 moi sinh da duoc doi chieu khop tren ca Node.js va Nginx!`);

    // Thuc hien truy van LogQL loc loi >= 400 va xac nhan chua req404Id moi nay
    const errorsQueryNode = '{app="pos_store", source="node_backend"} | json | statusCode >= 400';
    const errorsNodeRes = await queryLoki(errorsQueryNode, 50);
    const errorsQueryNginx = '{app="pos_store", source="nginx_access"} |~ " (4[0-9]{2}|5[0-9]{2}) "';
    const errorsNginxRes = await queryLoki(errorsQueryNginx, 50);

    const nodeContains404 = (errorsNodeRes.data?.result || []).some(stream => 
      (stream.values || []).some(v => v[1].includes(req404Id))
    );
    const nginxContains404 = (errorsNginxRes.data?.result || []).some(stream => 
      (stream.values || []).some(v => v[1].includes(req404Id))
    );

    if (!nodeContains404 || !nginxContains404) {
      throw new Error(`Truy van LogQL >= 400 khong chua requestId ${req404Id} moi sinh (Node: ${nodeContains404}, Nginx: ${nginxContains404})!`);
    }
    console.log(`   [ASSERTION PASS] Truy van LogQL >= 400 da xac thuc chua dung request 404 vua sinh tren ca hai nguon.`);

    const nodeSamples = [];
    for (const s of errorsNodeRes.data?.result || []) {
      for (const v of s.values || []) {
        nodeSamples.push(v[1]);
        if (nodeSamples.length >= 2) break;
      }
      if (nodeSamples.length >= 2) break;
    }

    const nginxSamples = [];
    for (const s of errorsNginxRes.data?.result || []) {
      for (const v of s.values || []) {
        nginxSamples.push(v[1]);
        if (nginxSamples.length >= 2) break;
      }
      if (nginxSamples.length >= 2) break;
    }

    report.queriesDemonstration.filterErrorsGte400 = {
      logqlNode: errorsQueryNode,
      logqlNginx: errorsQueryNginx,
      description: 'Loc cac phan hoi co HTTP status >= 400',
      testedRequest: sent404Request,
      nodeContainsTestedRequest: nodeContains404,
      nginxContainsTestedRequest: nginxContains404,
      nodeSample: nodeSamples,
      nginxSample: nginxSamples
    };

    // -------------------------------------------------------------
    // BƯỚC 4: TRUY VẤN MẪU XEM LOG NODE VÀ NGINX
    // -------------------------------------------------------------
    console.log('\n[4/5] Truy van LogQL mau xem toan bo log Node.js va Nginx...');
    const nodeQuery = '{app="pos_store", source="node_backend"}';
    const nodeRes = await queryLoki(nodeQuery, 20);
    const nodeSamplesAll = [];
    let nodeTotal = 0;
    for (const s of nodeRes.data?.result || []) {
      nodeTotal += (s.values || []).length;
      for (const v of s.values || []) {
        if (nodeSamplesAll.length < 2) nodeSamplesAll.push(v[1]);
      }
    }
    report.queriesDemonstration.viewNodeBackend = {
      logql: nodeQuery,
      description: 'Xem log he thong Node.js JSON',
      resultCount: nodeTotal,
      sampleValues: nodeSamplesAll
    };

    const nginxQuery = '{app="pos_store", source="nginx_access"}';
    const nginxRes = await queryLoki(nginxQuery, 20);
    const nginxSamplesAll = [];
    let nginxTotal = 0;
    for (const s of nginxRes.data?.result || []) {
      nginxTotal += (s.values || []).length;
      for (const v of s.values || []) {
        if (nginxSamplesAll.length < 2) nginxSamplesAll.push(v[1]);
      }
    }
    report.queriesDemonstration.viewNginxAccess = {
      logql: nginxQuery,
      description: 'Xem log truy cap Nginx Reverse Proxy',
      resultCount: nginxTotal,
      sampleValues: nginxSamplesAll
    };

    // -------------------------------------------------------------
    // BƯỚC 5: KIỂM TRA TÍNH BỀN VỮNG KHI RESTART (PERSISTENCE TEST)
    // -------------------------------------------------------------
    console.log('\n[5/5] Kiem tra tinh ben vung cua log khi restart Loki & Alloy...');
    
    // 5.1. Tao request truoc restart, luu requestId va khoang thoi gian truy van co dinh
    const preTimeStartNano = String(Date.now() - 5000) + '000000';
    const preRes = await fetch(`${NGINX_URL}/login`);
    const preReqId = preRes.headers.get('x-request-id');
    if (preRes.status !== 200 || !preReqId) {
      throw new Error(`Tao request truoc restart that bai: Status=${preRes.status}, reqId=${preReqId}`);
    }
    console.log(` - Request truoc restart: HTTP ${preRes.status}, X-Request-ID = ${preReqId}`);
    
    // Polling xac nhan da luu vao Loki truoc khi restart
    const prePoll = await pollLokiForLogs(preReqId, 10000, 300);
    const preTimeEndNano = String(Date.now() + 5000) + '000000';
    console.log(`   [OK] Log truoc restart da luu vao Loki. Khoang thoi gian nano: [${preTimeStartNano}, ${preTimeEndNano}]`);

    // 5.2. Restart he thong logging
    console.log(' - Dang dung he thong logging bang stop-logging.ps1...');
    execSync('powershell -ExecutionPolicy Bypass -File deploy\\logging\\stop-logging.ps1', {
      cwd: REPO_ROOT,
      stdio: 'inherit'
    });

    console.log(' - Dang khoi dong lai he thong logging bang start-logging.ps1...');
    execSync('powershell -ExecutionPolicy Bypass -File deploy\\logging\\start-logging.ps1', {
      cwd: REPO_ROOT,
      stdio: 'inherit'
    });

    // Cho he thong ket noi HTTP listener on dinh sau restart
    await sleep(2000);

    // 5.3. Sau restart: truy van lai dung khoang thoi gian va xac nhan dung source, dung noi dung cu
    console.log(` - Truy van lai du lieu log cu (${preReqId}) trong khoang thoi gian co dinh...`);
    const oldQueryRes = await queryLoki(`{app="pos_store"} |= "${preReqId}"`, 20, preTimeStartNano, preTimeEndNano);
    const oldStreams = oldQueryRes.data?.result || [];
    const oldExtracted = extractLogsFromStreams(oldStreams, preReqId);
    
    if (!oldExtracted.nodeLog || !oldExtracted.nginxLog) {
      throw new Error(`PERSISTENCE FAILED: Sau khi restart khong tim thay du log cu (Node: ${Boolean(oldExtracted.nodeLog)}, Nginx: ${Boolean(oldExtracted.nginxLog)})!`);
    }

    const preSentRequest = {
      requestId: preReqId,
      method: 'GET',
      path: '/login',
      expectedStatus: 200
    };
    matchAndValidateLogs({
      sentRequest: preSentRequest,
      nodeLog: oldExtracted.nodeLog,
      nginxLog: oldExtracted.nginxLog
    });
    console.log('   [ASSERTION PASS] Log cu van ton tai tren ca 2 stream node_backend va nginx_access sau khi restart!');

    // 5.4. Tao request moi sau restart va xac nhan tiep tuc thu thap
    console.log(' - Gui request moi sau restart de xac nhan tiep tuc thu thap...');
    const postRes = await fetch(`${NGINX_URL}/login`);
    const postReqId = postRes.headers.get('x-request-id');
    if (postRes.status !== 200 || !postReqId) {
      throw new Error(`Tao request sau restart that bai: Status=${postRes.status}, reqId=${postReqId}`);
    }
    console.log(`   Request moi sau restart: HTTP ${postRes.status}, X-Request-ID = ${postReqId}`);

    const postPoll = await pollLokiForLogs(postReqId, 10000, 300);
    const postSentRequest = {
      requestId: postReqId,
      method: 'GET',
      path: '/login',
      expectedStatus: 200
    };
    matchAndValidateLogs({
      sentRequest: postSentRequest,
      nodeLog: postPoll.nodeLog,
      nginxLog: postPoll.nginxLog
    });
    console.log('   [ASSERTION PASS] Log moi sau restart duoc thu thap va day vao Loki thanh cong 100%!');

    report.restartPersistenceTest = {
      status: 'PASS',
      preRestart: {
        requestId: preReqId,
        timeWindowNano: { start: preTimeStartNano, end: preTimeEndNano },
        nodeLogVerified: true,
        nginxLogVerified: true,
        nodeLog: oldExtracted.nodeLog,
        nginxLog: oldExtracted.nginxLog
      },
      postRestartOldLogVerification: {
        queriedTimeWindowNano: { start: preTimeStartNano, end: preTimeEndNano },
        streamsFound: oldStreams.length,
        verifiedSources: ['node_backend', 'nginx_access'],
        isContentMatched: true
      },
      postRestartNewLogIngestion: {
        requestId: postReqId,
        elapsedMs: postPoll.elapsedMs,
        streamsFound: postPoll.streamsCount,
        verifiedSources: ['node_backend', 'nginx_access'],
        nodeLog: postPoll.nodeLog,
        nginxLog: postPoll.nginxLog
      }
    };

    saveReportAndExit(true);

  } catch (err) {
    console.error('\n[EXCEPTION XAY RA]:', err.message);
    saveReportAndExit(false, err.message);
  }
}

// Cho phep import ham validate phuc vu test cach ly
module.exports = {
  extractLogsFromStreams,
  matchAndValidateLogs,
  queryLoki,
  pollLokiForLogs,
  runPipelineVerification
};

if (require.main === module) {
  runPipelineVerification();
}
