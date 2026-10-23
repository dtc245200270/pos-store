/**
 * scripts/test-live-traffic-and-dashboard.js
 * 
 * Script kiểm thử trực tiếp lưu lượng thực tế và đối chiếu giao diện Dashboard Grafana.
 * Tuân thủ nghiêm ngặt các yêu cầu:
 * 1. Cleanup bảo đảm luôn chạy: Sử dụng process.exitCode thay vì process.exit(),
 *    dọn dẹp Chrome process đúng PID, dọn WebSocket, dọn temp profile trong block finally.
 * 2. Timeout thực sự: Hủy request bằng req.destroy() cho HTTP, timeout cho WebSocket và từng lệnh CDP.
 * 3. Cấu hình an toàn: Không hardcode mật khẩu hay đường dẫn cá nhân. Báo lỗi ngay nếu thiếu GRAFANA_PASSWORD.
 * 4. Phân tích DOM chính xác: Đọc đúng phần tử giá trị stat, parse thành số (không dùng includes('0')/('100')).
 * 5. Kiểm tra computedStyle: Đọc đúng phần tử hiển thị background (backgroundImage/backgroundColor),
 *    đối chiếu màu theo thresholds thực tế.
 * 6. Polling có timeout chờ panel tải và chờ cooldown (xác nhận target vẫn UP và rate count bằng 0/rỗng).
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  sleep,
  assert,
  httpRequest,
  queryPrometheus,
  extractMetricValue,
  parseStatPanelValue,
  compareDomWithPrometheus,
  resolveExpectedThresholdColor,
  matchesExpectedColor,
  verifyCooldownState
} = require('./monitoring-common');

async function runLiveTrafficAndDashboard(options = {}) {
  // 1. Kiểm tra cấu hình và biến môi trường
  const grafanaPass = options.grafanaPassword !== undefined ? options.grafanaPassword : process.env.GRAFANA_PASSWORD;
  if (!grafanaPass) {
    throw new Error('CẤU HÌNH CÒN THIẾU: Biến môi trường GRAFANA_PASSWORD chưa được thiết lập. Vui lòng thiết lập biến môi trường trước khi chạy!');
  }

  const grafanaUser = options.grafanaUser || process.env.GRAFANA_USER || 'admin';
  const grafanaBase = (options.grafanaUrl || process.env.GRAFANA_URL || 'http://127.0.0.1:3030').replace(/\/+$/, '');
  const promBase = (options.promUrl || process.env.PROM_URL || 'http://127.0.0.1:9090').replace(/\/+$/, '');
  const nginxBase = (options.nginxUrl || process.env.NGINX_URL || 'http://localhost:8080').replace(/\/+$/, '');
  const chromePath = options.chromePath || process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  
  const artifactDir = options.artifactDir || process.env.ARTIFACT_DIR || path.resolve(__dirname, '../deploy/monitoring/artifacts');
  fs.mkdirSync(artifactDir, { recursive: true });

  const dashboardUid = options.dashboardUid || 'pos-store-monitoring-dashboard';

  console.log('========================================================================');
  console.log(' KIỂM THỬ TRỰC TIẾP LƯU LƯỢNG & DASHBOARD GRAFANA (CHROME CDP & DOM)');
  console.log(` (Grafana: ${grafanaBase} | Prometheus: ${promBase} | POS Store: ${nginxBase})`);
  console.log('========================================================================\n');

  let chromeProc = null;
  let ws = null;
  let tempProfileDir = null;
  let keepTrafficRunning = false;
  let trafficPromise = null;
  let cleanupDone = false;
  let originalError = null;

  try {
    // BƯỚC 1: XÁC THỰC DASHBOARD GRAFANA API ĐỐI CHIẾU FILE LOCAL
    console.log('[BƯỚC 1] Đối chiếu biểu thức Dashboard giữa Grafana API và file repo...');
    const localDashPath = path.resolve(__dirname, '../deploy/monitoring/grafana/dashboards/pos-store-dashboard.json');
    assert(fs.existsSync(localDashPath), `Không tìm thấy file dashboard tại: ${localDashPath}`);
    const localDashJson = JSON.parse(fs.readFileSync(localDashPath, 'utf8'));

    // Gọi Grafana API bằng Basic Auth
    const basicAuth = Buffer.from(`${grafanaUser}:${grafanaPass}`).toString('base64');
    const apiRes = await httpRequest({
      url: `${grafanaBase}/api/dashboards/uid/${dashboardUid}`,
      headers: { 'Authorization': `Basic ${basicAuth}` }
    }, null, 10000);
    if (apiRes.statusCode === 401 || apiRes.statusCode === 403) {
      throw new Error(`Đăng nhập Grafana API thất bại (HTTP ${apiRes.statusCode}). Sai tài khoản hoặc mật khẩu!`);
    }
    if (apiRes.statusCode !== 200) {
      throw new Error(`Grafana API HTTP ${apiRes.statusCode}: ${apiRes.data}`);
    }

    let apiDashData;
    try {
      apiDashData = JSON.parse(apiRes.data);
    } catch (e) {
      throw new Error(`Lỗi parse dữ liệu từ Grafana API: ${e.message}`);
    }

    const apiPanels = apiDashData.dashboard?.panels || [];
    const localPanels = localDashJson.panels || [];

    const apiP3 = apiPanels.find(p => p.id === 3);
    const localP3 = localPanels.find(p => p.id === 3);
    assert(apiP3 && localP3, 'Không tìm thấy Panel 3 trong Grafana API hoặc file local.');

    const apiP4 = apiPanels.find(p => p.id === 4);
    const localP4 = localPanels.find(p => p.id === 4);
    assert(apiP4 && localP4, 'Không tìm thấy Panel 4 trong Grafana API hoặc file local.');

    console.log(' - Kiểm tra Panel 3: "Tỷ lệ lỗi HTTP 5xx (%)":');
    console.log(`   * Expr API  : ${apiP3.targets?.[0]?.expr}`);
    console.log(`   * Expr Local: ${localP3.targets?.[0]?.expr}`);
    assert(apiP3.targets?.[0]?.expr === localP3.targets?.[0]?.expr, 'Biểu thức Panel 3 trên Grafana API KHÔNG khớp với file local!');

    console.log(' - Kiểm tra Panel 4: "Tỷ lệ yêu cầu hoàn thành <= 2s (%)":');
    console.log(`   * Expr API  : ${apiP4.targets?.[0]?.expr}`);
    console.log(`   * Expr Local: ${localP4.targets?.[0]?.expr}`);
    assert(apiP4.targets?.[0]?.expr === localP4.targets?.[0]?.expr, 'Biểu thức Panel 4 trên Grafana API KHÔNG khớp với file local!');
    assert(apiP4.targets?.[0]?.expr.includes('le=~"2|2[.]0"'), 'Biểu thức Panel 4 không chứa bộ lọc le=~"2|2[.]0"!');
    assert(apiP4.targets?.[0]?.expr.includes('> 0'), 'Biểu thức Panel 4 không có điều kiện mẫu số > 0!');

    const p3ThresholdSteps = apiP3.fieldConfig?.defaults?.thresholds?.steps || [];
    const p4ThresholdSteps = apiP4.fieldConfig?.defaults?.thresholds?.steps || [];

    // Kiểm tra cấu hình thresholds và mappings của Panel 3:
    const p3BaseStep = p3ThresholdSteps.find(s => s.value === null || s.value === undefined);
    assert(p3BaseStep && (p3BaseStep.color === '#808080' || p3BaseStep.color === 'gray'),
      `Panel 3 trên Grafana API có Base threshold không phải #808080 (nhận được: ${p3BaseStep?.color})!`);
    const p3ZeroStep = p3ThresholdSteps.find(s => s.value === 0);
    assert(p3ZeroStep && p3ZeroStep.color === 'green',
      `Panel 3 trên Grafana API không có step value = 0 màu green (nhận được: ${p3ZeroStep?.color})!`);
    assert(apiP3.fieldConfig?.defaults?.noValue === 'Chưa có dữ liệu',
      'Panel 3 trên Grafana API không có noValue: "Chưa có dữ liệu"!');
    console.log(' -> [PASS] Đối chiếu biểu thức và cấu hình Panel 3 & 4 hoàn toàn trùng khớp.\n');

    // BƯỚC 2: ĐĂNG NHẬP GRAFANA VÀ KHỞI ĐỘNG CHROME HEADLESS
    console.log('[BƯỚC 2] Đăng nhập Grafana và kết nối Chrome CDP...');
    console.log(` - Đăng nhập tài khoản: "${grafanaUser}" (mật khẩu được bảo vệ an toàn, không ghi ra log)...`);
    
    // Đăng nhập session qua POST /login với timeout thực sự
    const loginPostData = JSON.stringify({ user: grafanaUser, password: grafanaPass });
    const grafanaUrlObj = new URL(grafanaBase);
    const loginRes = await httpRequest({
      protocol: grafanaUrlObj.protocol,
      hostname: grafanaUrlObj.hostname,
      port: grafanaUrlObj.port || (grafanaUrlObj.protocol === 'https:' ? 443 : 80),
      path: '/login',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    }, loginPostData, 10000);

    if (loginRes.statusCode !== 200) {
      throw new Error(`Đăng nhập Grafana thất bại với HTTP ${loginRes.statusCode}: ${loginRes.data}`);
    }

    const setCookies = loginRes.headers['set-cookie'] || [];
    let sessionCookie = '';
    for (const c of setCookies) {
      if (c.includes('grafana_session=')) {
        sessionCookie = c.split(';')[0].split('=')[1];
      }
    }
    assert(sessionCookie, 'Không tìm thấy grafana_session cookie trong phản hồi đăng nhập!');
    console.log(' -> Đã nhận grafana_session cookie thành công.');

    // Khởi tạo thư mục profile tạm thời cho Chrome
    tempProfileDir = path.join(os.tmpdir(), `chrome_pos_test_${Date.now()}_${Math.floor(Math.random() * 10000)}`);
    fs.mkdirSync(tempProfileDir, { recursive: true });

    // Chọn cổng CDP tự động hoặc ngẫu nhiên an toàn
    const cdpPort = options.cdpPort || (9300 + Math.floor(Math.random() * 500));
    console.log(` - Khởi chạy Chrome headless trên remote-debugging-port=${cdpPort}...`);

    chromeProc = spawn(chromePath, [
      '--headless=new',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${tempProfileDir}`,
      '--window-size=1680,1050',
      '--disable-gpu',
      'about:blank'
    ]);

    // Bắt sự kiện thoát bất ngờ của Chrome
    let chromeExitedPrematurely = false;
    chromeProc.on('exit', (code) => {
      chromeExitedPrematurely = true;
    });

    // Chờ Chrome mở cổng debugging
    await sleep(2000);
    assert(!chromeExitedPrematurely, 'Tiến trình Chrome đã thoát bất ngờ sau khi khởi chạy!');

    // Lấy danh sách pages từ CDP endpoint
    const versionRes = await httpRequest(`http://127.0.0.1:${cdpPort}/json/list`, null, 10000);
    assert(versionRes.statusCode === 200, `Không thể kết nối Chrome debugging port ${cdpPort}`);
    const pages = JSON.parse(versionRes.data);
    const targetPage = pages.find(p => p.type === 'page');
    assert(targetPage && targetPage.webSocketDebuggerUrl, 'Không tìm thấy trang web hợp lệ từ Chrome CDP!');

    // Kết nối WebSocket với timeout thực sự
    ws = await new Promise((resolve, reject) => {
      const sock = new globalThis.WebSocket(targetPage.webSocketDebuggerUrl);
      const timer = setTimeout(() => {
        try { sock.close(); } catch (e) {}
        reject(new Error('WEBSOCKET_TIMEOUT: Quá thời gian 10s khi kết nối tới Chrome CDP WebSocket.'));
      }, 10000);

      sock.onopen = () => {
        clearTimeout(timer);
        resolve(sock);
      };
      sock.onerror = (err) => {
        clearTimeout(timer);
        reject(err);
      };
    });

    let msgId = 1;
    function sendCdp(method, params = {}, timeoutMs = 15000) {
      return new Promise((resolve, reject) => {
        const curId = msgId++;
        let timer = null;

        const onMsg = (event) => {
          let res;
          try {
            res = JSON.parse(event.data);
          } catch (e) { return; }

          if (res.id === curId) {
            clearTimeout(timer);
            ws.removeEventListener('message', onMsg);
            if (res.error) {
              return reject(new Error(`CDP ${method} error: ${JSON.stringify(res.error)}`));
            }
            resolve(res.result);
          }
        };

        timer = setTimeout(() => {
          ws.removeEventListener('message', onMsg);
          reject(new Error(`CDP_TIMEOUT: Lệnh CDP ${method} quá hạn sau ${timeoutMs}ms.`));
        }, timeoutMs);

        ws.addEventListener('message', onMsg);
        ws.send(JSON.stringify({ id: curId, method, params }));
      });
    }

    // Thiết lập cookie grafana_session trên browser
    await sendCdp('Network.setCookie', {
      name: 'grafana_session',
      value: sessionCookie,
      domain: grafanaUrlObj.hostname,
      path: '/',
      httpOnly: true
    });

    // Hỗ trợ kiểm thử cô lập (Ca 6): Kích hoạt lỗi ngay sau khi Chrome mở và kết nối CDP thành công
    if (options.simulateErrorAfterChromeStart) {
      console.log(' [MÔ PHỎNG KIỂM THỬ] Kích hoạt lỗi giả lập ngay sau khi Chrome đã khởi động và kết nối CDP...');
      throw new Error('MÔ_PHỎNG_LỖI: Kích hoạt lỗi sau khi Chrome đã khởi động');
    }

    /**
     * Hàm trích xuất thông tin Stat Panel trên trình duyệt.
     * Tách biệt đúng phần tử chứa giá trị của ô stat khỏi tiêu đề và chú thích.
     * Chỉ trả kết quả khi phần tử giá trị đã tải xong (parseStatPanelValue không phải TITLE_ONLY / LOADING).
     */
    async function extractStatPanelDom(panelId, timeoutMs = 15000) {
      const startTime = Date.now();
      let lastVal = null;
      let lastParsed = null;

      while ((Date.now() - startTime) < timeoutMs) {
        const evalRes = await sendCdp('Runtime.evaluate', {
          expression: `(() => {
            const url = window.location.href;
            const isLoginPage = url.includes('/login') || document.querySelector('input[name="user"]') !== null;
            const isErrorPage = url.includes('/404') || url.includes('/500') || document.title.includes('Page not found');

            const section = document.querySelector('[data-panelid="${panelId}"]') ||
                            Array.from(document.querySelectorAll('section')).find(s => {
                              const t = s.innerText || '';
                              return ${panelId} === 3 ? t.includes('5xx') : t.includes('<= 2s');
                            });

            if (!section) {
              return { found: false, isLoginPage, isErrorPage, reason: 'Panel section not found' };
            }

            // Tách phần tử tiêu đề và chú thích
            const headerEl = section.querySelector('header') || section.querySelector('h2') || section.querySelector('h3') || section.querySelector('.panel-header');
            const title = headerEl ? (headerEl.innerText || '').trim() : '';

            // Xác định vùng nội dung panel
            const panelContent = section.querySelector('[data-testid="data-testid panel content"]') || section.querySelector('.panel-content') || section;

            // Tìm phần tử hiển thị nền của ô stat
            let bgElement = null;
            const divs = Array.from(panelContent.querySelectorAll('div'));
            for (const d of divs) {
              const st = d.getAttribute('style') || '';
              if (st.includes('background:') || st.includes('background-color:')) {
                bgElement = d;
                break;
              }
            }
            if (!bgElement && divs.length > 0) {
              bgElement = divs[divs.length - 1];
            }
            if (!bgElement) bgElement = section;

            const computed = window.getComputedStyle(bgElement);
            const computedBg = computed.backgroundColor || '';
            const computedBgImage = computed.backgroundImage || '';

            // Tách phần tử giá trị của ô stat từ panelContent (tách khỏi tiêu đề)
            let valueText = '';
            if (panelContent && panelContent !== section) {
              let cText = (panelContent.innerText || '').trim();
              if (title && cText.includes(title)) {
                cText = cText.replace(title, '').trim();
              }
              valueText = cText;
            } else {
              let sText = (section.innerText || '').trim();
              if (title && sText.includes(title)) {
                sText = sText.replace(title, '').trim();
              }
              valueText = sText;
            }

            return {
              found: true,
              isLoginPage,
              isErrorPage,
              url,
              title,
              valueText,
              fullSectionText: (section.innerText || '').trim(),
              computedBg,
              computedBgImage
            };
          })()`,
          returnByValue: true
        });

        const val = evalRes?.result?.value;
        if (val?.isLoginPage) {
          throw new Error('Trình duyệt bị kẹt ở trang đăng nhập Grafana!');
        }
        if (val?.isErrorPage) {
          throw new Error(`Trình duyệt hiển thị trang lỗi: ${val.url}`);
        }

        if (val?.found) {
          lastVal = val;
          // Thử phân tích valueText từ panelContent trước, nếu chưa có thì thử fullSectionText
          let parsed = parseStatPanelValue(val.valueText);
          if (parsed.state === 'LOADING_OR_NOT_FOUND' || parsed.state === 'TITLE_ONLY' || parsed.state === 'INVALID') {
            const fallbackParsed = parseStatPanelValue(val.fullSectionText);
            if (fallbackParsed.state === 'HAS_VALUE' || fallbackParsed.state === 'NO_DATA') {
              parsed = fallbackParsed;
            }
          }
          lastParsed = parsed;

          // Chỉ trả kết quả khi phần tử giá trị đã tải xong (không phải TITLE_ONLY, không phải LOADING_OR_NOT_FOUND)
          if (parsed.state === 'HAS_VALUE' || parsed.state === 'NO_DATA') {
            return {
              ...val,
              parsed
            };
          }
          // Nếu chỉ là TITLE_ONLY hoặc LOADING, tiếp tục polling
        }

        await sleep(1000);
      }

      if (lastParsed?.state === 'TITLE_ONLY') {
        throw new Error(`Quá thời gian ${timeoutMs}ms chờ tải Panel ${panelId}: Panel chỉ hiển thị tiêu đề ("${lastVal?.title}"), chưa tải xong phần tử giá trị!`);
      }

      throw new Error(`Quá thời gian ${timeoutMs}ms chờ tải Panel ${panelId} trên DOM trình duyệt!`);
    }

    async function captureAndSaveScreenshot(filename) {
      const snap = await sendCdp('Page.captureScreenshot', { format: 'png' });
      assert(snap && snap.data, 'Không nhận được dữ liệu ảnh chụp từ Chrome CDP!');
      const outPath = path.join(artifactDir, filename);
      fs.writeFileSync(outPath, Buffer.from(snap.data, 'base64'));
      const stat = fs.statSync(outPath);
      assert(stat.size > 10000, `Ảnh chụp ${filename} quá nhỏ (${stat.size} bytes), có thể bị lỗi render.`);
      console.log(`[SNAPSHOT] Đã lưu ảnh kiểm chứng: ${outPath} (${(stat.size / 1024).toFixed(1)} KB)`);
      return outPath;
    }

    console.log(' -> [PASS] Khởi tạo Chrome và kết nối CDP thành công.\n');

    // BƯỚC 3: GIAI ĐOẠN 1 - PHÁT LƯU LƯỢNG THỰC TẾ & ĐỐI CHIẾU KHI CÓ TẢI
    console.log('>>> GIAI ĐOẠN 1: PHÁT LƯU LƯỢNG THỰC TẾ & ĐỐI CHIẾU DASHBOARD KHI CÓ TẢI <<<');
    keepTrafficRunning = true;
    const trafficStats = { sent: 0, success: 0, errors: 0 };
    const trafficUrls = [
      `${nginxBase}/login`,
      `${nginxBase}/public/css/style.css`
    ];

    trafficPromise = (async () => {
      while (keepTrafficRunning) {
        const u = trafficUrls[trafficStats.sent % trafficUrls.length];
        try {
          const res = await httpRequest(u, null, 5000);
          trafficStats.sent++;
          if (res.ok) trafficStats.success++; else trafficStats.errors++;
        } catch (e) {
          trafficStats.sent++;
          trafficStats.errors++;
        }
        await sleep(150);
      }
    })();

    console.log(' - Đang phát lưu lượng liên tục tới Nginx (~6.6 req/s, chỉ GET /login và /public/css/style.css)...');
    console.log(' - Polling Prometheus cập nhật thời điểm đánh giá mỗi lần lặp cho đến khi đủ dữ liệu rate [1m]...');

    const p4Expr = apiP4.targets[0].expr;
    const p3Expr = apiP3.targets[0].expr;

    let rateReady = false;
    let promP4Val = null;
    let promP3Val = null;
    let fixedT = null;

    // Polling Prometheus: cập nhật thời điểm đánh giá mỗi lần polling; không dùng mãi mốc cũ
    const pollRateStart = Date.now();
    while ((Date.now() - pollRateStart) < 60000) {
      await sleep(3000);
      const currentT = Math.floor(Date.now() / 1000);
      try {
        const q4 = await queryPrometheus({ baseUrl: promBase, query: p4Expr, time: currentT });
        const q3 = await queryPrometheus({ baseUrl: promBase, query: p3Expr, time: currentT });
        if (q4.data?.result?.length > 0 && q3.data?.result?.length > 0) {
          const v4 = extractMetricValue(q4, 'Panel 4 PromQL rate');
          const v3 = extractMetricValue(q3, 'Panel 3 PromQL rate');
          if (Number.isFinite(v4) && Number.isFinite(v3)) {
            promP4Val = v4;
            promP3Val = v3;
            fixedT = currentT;
            rateReady = true;
            console.log(` -> Đã đủ dữ liệu rate [1m] tại thời điểm cố định T = ${fixedT} (${new Date(fixedT * 1000).toISOString()}):`);
            console.log(`    * Panel 4 (<= 2s rate): ${promP4Val.toFixed(2)}%`);
            console.log(`    * Panel 3 (5xx error ): ${promP3Val.toFixed(2)}%`);
            break;
          }
        }
      } catch (e) {
        // Chưa đủ dữ liệu, tiếp tục vòng lặp
      }
      console.log(`    [Polling] Chờ đủ 2 điểm scrape trong cửa sổ [1m]... (${((Date.now() - pollRateStart) / 1000).toFixed(1)}s)`);
    }

    assert(rateReady && fixedT !== null, 'Prometheus không tính được rate [1m] hợp lệ sau 60s phát lưu lượng!');

    // Cho dashboard dùng khoảng thời gian tuyệt đối kết thúc tại T và tắt tự refresh trong phiên kiểm thử
    const windowSeconds = 300; // Cửa sổ 5 phút kết thúc tại T
    const fromMs = Math.floor((fixedT - windowSeconds) * 1000);
    const toMs = Math.floor(fixedT * 1000);
    const fixedDashUrl = `${grafanaBase}/d/${dashboardUid}?kiosk&from=${fromMs}&to=${toMs}&refresh=`;
    console.log(` - Điều hướng Chrome tới Dashboard với khoảng thời gian tuyệt đối kết thúc tại T = ${fixedT} (tắt auto-refresh):`);
    console.log(`   URL: ${fixedDashUrl}`);
    await sendCdp('Page.navigate', { url: fixedDashUrl });
    await sleep(4000);

    // Đọc DOM Panel 3 và Panel 4 tại thời điểm cố định T
    const domP3WithTraffic = await extractStatPanelDom(3);
    const domP4WithTraffic = await extractStatPanelDom(4);

    console.log(`\n[ĐỐI CHIẾU SỐ LIỆU TẠI THỜI ĐIỂM T = ${fixedT} (${new Date(fixedT * 1000).toISOString()})]:`);

    // Đối chiếu Panel 4
    console.log(` - Panel 4 ("Tỷ lệ yêu cầu hoàn thành <= 2s (%)"):`);
    console.log(`   * Giá trị Prometheus tại T : ${promP4Val.toFixed(2)}%`);
    console.log(`   * Giá trị DOM Grafana tại T : ${domP4WithTraffic.parsed.value}% (text: "${domP4WithTraffic.valueText}")`);
    assert(!domP4WithTraffic.parsed.isNoData, 'Panel 4 bị thiếu dữ liệu khi đang có tải!');
    const compP4 = compareDomWithPrometheus({
      domValue: domP4WithTraffic.parsed.value,
      promValue: promP4Val,
      tolerance: 0.5,
      panelTitle: 'Panel 4 (<= 2s)'
    });
    console.log(`   * Sai số làm tròn           : ${compP4.diff.toFixed(2)}% (dung sai: 0.5%) -> [PASS] Khớp chuẩn xác.`);

    // Kiểm tra màu Panel 4 theo thresholds
    const expColorP4 = resolveExpectedThresholdColor(domP4WithTraffic.parsed.value, p4ThresholdSteps);
    const matchesColorP4 = matchesExpectedColor(
      { backgroundColor: domP4WithTraffic.computedBg, backgroundImage: domP4WithTraffic.computedBgImage },
      expColorP4
    );
    assert(matchesColorP4, `Màu nền Panel 4 khi giá trị là ${domP4WithTraffic.parsed.value}% không khớp màu kỳ vọng (${expColorP4}).`);

    // Đối chiếu Panel 3
    console.log(` - Panel 3 ("Tỷ lệ lỗi HTTP 5xx (%)"):`);
    console.log(`   * Giá trị Prometheus tại T : ${promP3Val.toFixed(2)}%`);
    console.log(`   * Giá trị DOM Grafana tại T : ${domP3WithTraffic.parsed.value}% (text: "${domP3WithTraffic.valueText}")`);
    assert(!domP3WithTraffic.parsed.isNoData, 'Panel 3 bị thiếu dữ liệu khi đang có tải!');
    const compP3 = compareDomWithPrometheus({
      domValue: domP3WithTraffic.parsed.value,
      promValue: promP3Val,
      tolerance: 0.5,
      panelTitle: 'Panel 3 (5xx error)'
    });
    console.log(`   * Sai số làm tròn           : ${compP3.diff.toFixed(2)}% (dung sai: 0.5%) -> [PASS] Khớp chuẩn xác.`);

    // Kiểm tra màu Panel 3 theo thresholds
    const expColorP3 = resolveExpectedThresholdColor(domP3WithTraffic.parsed.value, p3ThresholdSteps);
    const matchesColorP3 = matchesExpectedColor(
      { backgroundColor: domP3WithTraffic.computedBg, backgroundImage: domP3WithTraffic.computedBgImage },
      expColorP3
    );
    assert(matchesColorP3, `Màu nền Panel 3 khi giá trị là ${domP3WithTraffic.parsed.value}% không khớp màu kỳ vọng (${expColorP3}).`);

    // Chụp ảnh màn hình có tải
    await captureAndSaveScreenshot('dashboard_with_traffic.png');
    console.log(' -> [PASS] Giai đoạn 1: Dashboard hiển thị chuẩn xác khi có tải.\n');

    // Dừng lưu lượng và chờ trafficPromise kết thúc
    keepTrafficRunning = false;
    await Promise.race([trafficPromise, sleep(4000)]);
    console.log(` - Đã dừng lưu lượng. Thống kê: Gửi ${trafficStats.sent}, Thành công: ${trafficStats.success}, Lỗi: ${trafficStats.errors}.`);
    assert(trafficStats.sent > 0, 'Chưa gửi yêu cầu lưu lượng nào!');
    assert(trafficStats.errors === 0, `Có ${trafficStats.errors} yêu cầu bị lỗi HTTP khi phát lưu lượng.`);

    // BƯỚC 4: GIAI ĐOẠN 2 - CHỜ HẾT TẢI & ĐỐI CHIẾU TRẠNG THÁI "CHƯA CÓ DỮ LIỆU" NỀN XÁM #808080
    console.log('\n>>> GIAI ĐOẠN 2: CHỜ HẾT TẢI & ĐỐI CHIẾU TRẠNG THÁI "CHƯA CÓ DỮ LIỆU" NỀN XÁM #808080 <<<');
    console.log(' - Polling Prometheus xác nhận hết tải (target vẫn UP, dữ liệu mới và rate count về 0)...');

    const cooldownResult = await verifyCooldownState({
      baseUrl: promBase,
      timeoutSec: 75,
      intervalMs: 4000
    });
    console.log(` -> Prometheus đã xác nhận hết tải sau ${cooldownResult.elapsedSec}s (Target UP, tuổi mẫu ${cooldownResult.sampleAge.toFixed(1)}s, count rate = ${cooldownResult.finalRate}).`);

    // Kiểm tra hai biểu thức tỷ lệ trên Prometheus lúc hết tải (không có mẫu số > 0 -> vector rỗng)
    const tCooldownEval = Math.floor(Date.now() / 1000);
    const qP4Cooldown = await queryPrometheus({ baseUrl: promBase, query: p4Expr, time: tCooldownEval });
    const qP3Cooldown = await queryPrometheus({ baseUrl: promBase, query: p3Expr, time: tCooldownEval });
    assert((qP4Cooldown.data?.result || []).length === 0, 'Biểu thức Panel 4 trên Prometheus vẫn trả về giá trị khi rate = 0 (kỳ vọng rỗng vì mẫu số > 0)!');
    assert((qP3Cooldown.data?.result || []).length === 0, 'Biểu thức Panel 3 trên Prometheus vẫn trả về giá trị khi rate = 0 (kỳ vọng rỗng vì mẫu số > 0)!');
    console.log(' -> [PASS] Cả hai biểu thức tỷ lệ trên Prometheus đều ở trạng thái không có dữ liệu (vector rỗng) khi rate = 0.');

    // Điều hướng lại trên Chrome để cập nhật trạng thái mới nhất
    await sendCdp('Page.navigate', {
      url: `${grafanaBase}/d/${dashboardUid}?kiosk&refresh=`
    });
    await sleep(4000);

    // Xác thực DOM khi hết tải
    const domP3NoTraffic = await extractStatPanelDom(3);
    const domP4NoTraffic = await extractStatPanelDom(4);

    console.log(' - Kiểm tra hiển thị Panel khi HẾT tải trên Grafana:');
    console.log(`   * Panel 3 text: "${domP3NoTraffic.valueText || domP3NoTraffic.fullSectionText}" -> IsNoData: ${domP3NoTraffic.parsed.isNoData}`);
    console.log(`   * Panel 4 text: "${domP4NoTraffic.valueText || domP4NoTraffic.fullSectionText}" -> IsNoData: ${domP4NoTraffic.parsed.isNoData}`);

    // Cả hai panel khi hết tải phải có isNoData = true và hiển thị "Chưa có dữ liệu"
    assert(domP3NoTraffic.parsed.isNoData, `Panel 3 khi hết tải không ở trạng thái "Chưa có dữ liệu" (nhận được: "${domP3NoTraffic.valueText}").`);
    assert(domP4NoTraffic.parsed.isNoData, `Panel 4 khi hết tải không ở trạng thái "Chưa có dữ liệu" (nhận được: "${domP4NoTraffic.valueText}").`);

    // Kiểm tra màu nền xám #808080 khi thiếu dữ liệu
    const matchesGrayP3 = matchesExpectedColor(
      { backgroundColor: domP3NoTraffic.computedBg, backgroundImage: domP3NoTraffic.computedBgImage },
      '#808080'
    );
    assert(matchesGrayP3, `Panel 3 khi hết tải không có màu nền xám #808080!`);

    const matchesGrayP4 = matchesExpectedColor(
      { backgroundColor: domP4NoTraffic.computedBg, backgroundImage: domP4NoTraffic.computedBgImage },
      '#808080'
    );
    assert(matchesGrayP4, `Panel 4 khi hết tải không có màu nền xám #808080!`);

    // Chụp ảnh màn hình khi hết lưu lượng
    await captureAndSaveScreenshot('dashboard_no_traffic.png');
    console.log(' -> [PASS] Giai đoạn 2: Dashboard hiển thị "Chưa có dữ liệu" nền xám #808080 chuẩn xác.\n');

    cleanupDone = true;

    return {
      success: true,
      fixedT,
      promP4Val,
      promP3Val,
      trafficSent: trafficStats.sent,
      cooldownElapsedSec: cooldownResult.elapsedSec
    };

  } catch (err) {
    originalError = err;
    throw err;
  } finally {
    // KHỐI CLEANUP ĐƯỢC BẢO ĐẢM LUÔN LUÔN THỰC THI (KHÔNG BỊ BỎ QUA BỞI PROCESS.EXIT)
    console.log('\n[CLEANUP] Bắt đầu dọn dẹp tài nguyên bài test...');
    keepTrafficRunning = false;
    let cleanupError = null;

    try {
      if (trafficPromise) {
        try {
          await Promise.race([trafficPromise, sleep(3000)]);
        } catch (e) {}
      }

      if (ws) {
        try {
          ws.close();
        } catch (e) {}
      }

      if (chromeProc && chromeProc.pid) {
        const pidToKill = chromeProc.pid;
        console.log(`[CLEANUP] Đang dừng tiến trình Chrome headless do script tạo (PID: ${pidToKill})...`);
        try {
          execSync(`taskkill /pid ${pidToKill} /f /t`, { stdio: 'ignore' });
        } catch (e) {}
        try {
          chromeProc.kill('SIGKILL');
        } catch (e) {}

        // Xác nhận tiến trình đã thực sự kết thúc
        let processStillAlive = false;
        for (let wait = 0; wait < 6; wait++) {
          try {
            process.kill(pidToKill, 0);
            processStillAlive = true;
            await sleep(400);
          } catch (e) {
            processStillAlive = false;
            break;
          }
        }
        if (processStillAlive) {
          throw new Error(`[LỖI CLEANUP] Tiến trình Chrome PID ${pidToKill} không thể dừng sau lệnh kill!`);
        }
        console.log(`[CLEANUP] Đã xác nhận tiến trình Chrome PID ${pidToKill} kết thúc hoàn toàn.`);
      }

      if (tempProfileDir && fs.existsSync(tempProfileDir)) {
        console.log(`[CLEANUP] Đang xóa thư mục profile tạm thời: ${tempProfileDir}...`);
        for (let retry = 0; retry < 6; retry++) {
          try {
            fs.rmSync(tempProfileDir, { recursive: true, force: true });
            break;
          } catch (e) {
            await sleep(500);
          }
        }
        // Xác nhận thư mục profile không còn
        if (fs.existsSync(tempProfileDir)) {
          throw new Error(`[LỖI CLEANUP] Thư mục profile tạm ${tempProfileDir} vẫn còn tồn tại sau khi xóa!`);
        }
        console.log(`[CLEANUP] Đã xác nhận thư mục profile tạm đã bị xóa hoàn toàn.`);
      }
    } catch (err) {
      cleanupError = err;
      console.error(`[LỖI CLEANUP] ${err.message}`);
    }

    if (cleanupError) {
      if (originalError) {
        const combined = new Error(`Lỗi bài test: ${originalError.message} | Kèm lỗi dọn dẹp: ${cleanupError.message}`);
        combined.originalError = originalError;
        combined.cleanupError = cleanupError;
        throw combined;
      }
      throw cleanupError;
    }

    if (originalError) {
      throw originalError;
    }

    console.log('[CLEANUP] Hoàn tất dọn dẹp tài nguyên sạch sẽ.');
    console.log('========================================================================');
    console.log('      [KẾT QUẢ CUỐI CÙNG] TOÀN BỘ KIỂM THỬ LIVE VÀ CHỤP ẢNH: PASS');
    console.log('========================================================================');
  }
}

// Chạy trực tiếp qua dòng lệnh nếu được gọi chính thức
if (require.main === module) {
  runLiveTrafficAndDashboard()
    .then(() => {
      process.exitCode = 0;
    })
    .catch((err) => {
      console.error('\n========================================================================');
      console.error(`  [KIỂM THỬ THẤT BẠI: FAIL] ${err.message}`);
      console.error('========================================================================');
      process.exitCode = 1;
    });
}

module.exports = {
  runLiveTrafficAndDashboard
};
