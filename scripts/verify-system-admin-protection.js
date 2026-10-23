require('dotenv').config();
const http = require('http');
const assert = require('assert');
const mysql = require('mysql2/promise');

const BASE_URL = 'http://127.0.0.1:8080';
const DB_CONFIG = {
  host: '127.0.0.1',
  port: 3307,
  user: process.env.DB_USER || 'pos_app',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'pos_store'
};

function httpRequest(method, path, body = null, cookie = null, csrfToken = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const headers = {};

    if (body) {
      headers['Content-Type'] = 'application/json';
    }
    if (cookie) {
      headers['Cookie'] = cookie;
    }
    if (csrfToken) {
      headers['X-CSRF-Token'] = csrfToken;
    }

    const req = http.request(
      url,
      {
        method,
        headers
      },
      (res) => {
        let rawData = '';
        res.on('data', (chunk) => {
          rawData += chunk;
        });
        res.on('end', () => {
          let data = null;
          try {
            data = JSON.parse(rawData);
          } catch (e) {
            data = rawData;
          }

          const setCookieHeaders = res.headers['set-cookie'];
          let newCookie = cookie;
          if (setCookieHeaders) {
            newCookie = setCookieHeaders.map((c) => c.split(';')[0]).join('; ');
          }

          resolve({
            status: res.statusCode,
            headers: res.headers,
            data,
            cookie: newCookie
          });
        });
      }
    );

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

async function loginUser(username, password) {
  const csrfRes = await httpRequest('GET', '/api/auth/csrf');
  const csrfToken = csrfRes.data?.csrfToken;
  const cookie = csrfRes.cookie;

  const loginRes = await httpRequest(
    'POST',
    '/api/auth/login',
    { username, password },
    cookie,
    csrfToken
  );

  return {
    status: loginRes.status,
    data: loginRes.data,
    cookie: loginRes.cookie,
    csrfToken: loginRes.data?.csrfToken || csrfToken
  };
}

async function run() {
  console.log('=== BẮT ĐẦU KIỂM THỬ BẢO VỆ TÀI KHOẢN HỆ THỐNG MANAGER ===');
  const db = await mysql.createConnection(DB_CONFIG);

  try {
    // 0. Đối chiếu thông tin tài khoản manager ban đầu trong DB
    const [origRows] = await db.query(
      'SELECT id, username, full_name, role, is_active, password_hash FROM users WHERE username = "manager"'
    );
    assert.strictEqual(origRows.length, 1, 'Tài khoản manager phải tồn tại trong DB');
    const managerBefore = origRows[0];
    console.log(`[0] Tài khoản manager ban đầu: ID=${managerBefore.id}, full_name="${managerBefore.full_name}", role="${managerBefore.role}", active=${managerBefore.is_active}`);

    // 1. Đăng nhập với tài khoản manager
    const mgrAuth = await loginUser('manager', process.env.INITIAL_MANAGER_PASSWORD);
    assert.strictEqual(mgrAuth.status, 200, 'Đăng nhập manager thành công (HTTP 200)');
    console.log('✓ [1] Đăng nhập tài khoản manager thành công qua Nginx cổng 8080');

    // 2. Lấy danh sách nhân viên từ GET /api/employees
    const listRes = await httpRequest('GET', '/api/employees', null, mgrAuth.cookie);
    assert.strictEqual(listRes.status, 200, 'Lấy danh sách nhân viên trả về HTTP 200');
    const mgrInList = listRes.data.find((u) => u.username === 'manager');
    assert(mgrInList, 'manager phải có trong danh sách');
    assert.strictEqual(mgrInList.is_system, true, 'Trường is_system của manager phải là true');
    console.log(`✓ [2] GET /api/employees trả về HTTP 200, tài khoản manager có is_system = ${mgrInList.is_system}`);

    // 3. Kiểm tra chặn các API quản lý nhân viên thao tác lên tài khoản manager (ID = 1)
    const mgrId = managerBefore.id;

    // 3.1. Chặn sửa thông tin / đổi vai trò
    console.log('\n--- Kiểm tra chặn thao tác lên tài khoản hệ thống ---');
    const putRes = await httpRequest(
      'PUT',
      `/api/employees/${mgrId}`,
      { full_name: 'Hacked Admin Name', role: 'CASHIER' },
      mgrAuth.cookie,
      mgrAuth.csrfToken
    );
    console.log(`  PUT /api/employees/${mgrId} -> Status: ${putRes.status}, Error: "${putRes.data?.error}"`);
    assert.strictEqual(putRes.status, 403, 'PUT sửa tài khoản manager phải bị chặn HTTP 403');

    // 3.2. Chặn sửa họ tên kể cả khi giữ nguyên vai trò
    const putNameOnlyRes = await httpRequest(
      'PUT',
      `/api/employees/${mgrId}`,
      { full_name: 'Hacked Admin Name', role: 'MANAGER' },
      mgrAuth.cookie,
      mgrAuth.csrfToken
    );
    console.log(`  PUT /api/employees/${mgrId} (name only) -> Status: ${putNameOnlyRes.status}, Error: "${putNameOnlyRes.data?.error}"`);
    assert.strictEqual(putNameOnlyRes.status, 403, 'PUT sửa họ tên manager phải bị chặn HTTP 403');

    // 3.3. Chặn khóa / toggle-active
    const lockRes = await httpRequest(
      'PATCH',
      `/api/employees/${mgrId}/toggle-active`,
      { is_active: false },
      mgrAuth.cookie,
      mgrAuth.csrfToken
    );
    console.log(`  PATCH /api/employees/${mgrId}/toggle-active -> Status: ${lockRes.status}, Error: "${lockRes.data?.error}"`);
    assert.strictEqual(lockRes.status, 403, 'PATCH toggle-active manager phải bị chặn HTTP 403');

    // 3.4. Chặn reset-password qua API quản lý nhân viên
    const resetRes = await httpRequest(
      'PATCH',
      `/api/employees/${mgrId}/reset-password`,
      { password: 'NewHackedPassword123', confirm_password: 'NewHackedPassword123' },
      mgrAuth.cookie,
      mgrAuth.csrfToken
    );
    console.log(`  PATCH /api/employees/${mgrId}/reset-password -> Status: ${resetRes.status}, Error: "${resetRes.data?.error}"`);
    assert.strictEqual(resetRes.status, 403, 'PATCH reset-password manager phải bị chặn HTTP 403');

    // 3.5. Chặn xóa tài khoản hệ thống
    const delRes = await httpRequest(
      'DELETE',
      `/api/employees/${mgrId}`,
      null,
      mgrAuth.cookie,
      mgrAuth.csrfToken
    );
    console.log(`  DELETE /api/employees/${mgrId} -> Status: ${delRes.status}, Error: "${delRes.data?.error}"`);
    assert.strictEqual(delRes.status, 403, 'DELETE manager phải bị chặn HTTP 403');

    // 3.6. Chặn tạo tài khoản trùng username 'manager'
    const createDupMgrRes = await httpRequest(
      'POST',
      '/api/employees',
      { username: 'manager', full_name: 'Clone Admin', password: 'Password123@', confirm_password: 'Password123@', role: 'CASHIER' },
      mgrAuth.cookie,
      mgrAuth.csrfToken
    );
    console.log(`  POST /api/employees (username="manager") -> Status: ${createDupMgrRes.status}, Error: "${createDupMgrRes.data?.error}"`);
    assert(createDupMgrRes.status === 400, 'POST tạo username=manager phải bị từ chối HTTP 400');

    // 3.7. Đối chiếu dữ liệu DB của tài khoản manager sau các đợt gọi API bị từ chối
    const [afterRows] = await db.query(
      'SELECT id, username, full_name, role, is_active, password_hash FROM users WHERE id = ?',
      [mgrId]
    );
    const managerAfter = afterRows[0];
    assert.strictEqual(managerAfter.username, managerBefore.username, 'username không đổi');
    assert.strictEqual(managerAfter.full_name, managerBefore.full_name, 'full_name không đổi');
    assert.strictEqual(managerAfter.role, managerBefore.role, 'role không đổi');
    assert.strictEqual(managerAfter.is_active, managerBefore.is_active, 'is_active không đổi');
    assert.strictEqual(managerAfter.password_hash, managerBefore.password_hash, 'password_hash không đổi');
    console.log('✓ [3] Đối chiếu dữ liệu DB: Tài khoản manager hoàn toàn nguyên vẹn 100%!');

    // 4. Kiểm tra phân quyền thu ngân và chống vượt quyền (Privilege escalation)
    console.log('\n--- Kiểm tra phân quyền thu ngân & chống vượt quyền ---');
    const testCashierUsername = `thungan_test_${Date.now().toString().slice(-4)}`;
    const testCashierPass = 'CashierPass123@';

    const createCashierRes = await httpRequest(
      'POST',
      '/api/employees',
      {
        username: testCashierUsername,
        full_name: 'Thu Ngân Test Scoped',
        password: testCashierPass,
        confirm_password: testCashierPass,
        role: 'CASHIER'
      },
      mgrAuth.cookie,
      mgrAuth.csrfToken
    );
    assert.strictEqual(createCashierRes.status, 201, 'Tạo thu ngân thử nghiệm thành công (HTTP 201)');
    const testCashierId = createCashierRes.data.id;
    console.log(`  Đã tạo thu ngân thử nghiệm: ${testCashierUsername} (ID: ${testCashierId})`);

    // Đăng nhập bằng thu ngân thử nghiệm
    const cashierAuth = await loginUser(testCashierUsername, testCashierPass);
    assert.strictEqual(cashierAuth.status, 200, 'Thu ngân đăng nhập thành công');

    // Thu ngân thử gọi các API quản lý nhân viên (thay ID thành 1 của manager hoặc ID khác)
    const cshGetList = await httpRequest('GET', '/api/employees', null, cashierAuth.cookie);
    console.log(`  Thu ngân GET /api/employees -> Status: ${cshGetList.status}`);
    assert.strictEqual(cshGetList.status, 403, 'Thu ngân gọi GET /api/employees phải bị 403');

    const cshPutMgr = await httpRequest(
      'PUT',
      `/api/employees/${mgrId}`,
      { full_name: 'Hacked By Cashier', role: 'MANAGER' },
      cashierAuth.cookie,
      cashierAuth.csrfToken
    );
    console.log(`  Thu ngân PUT /api/employees/${mgrId} -> Status: ${cshPutMgr.status}`);
    assert.strictEqual(cshPutMgr.status, 403, 'Thu ngân gọi PUT /api/employees/:id phải bị 403');

    const cshLockMgr = await httpRequest(
      'PATCH',
      `/api/employees/${mgrId}/toggle-active`,
      { is_active: false },
      cashierAuth.cookie,
      cashierAuth.csrfToken
    );
    console.log(`  Thu ngân PATCH /api/employees/${mgrId}/toggle-active -> Status: ${cshLockMgr.status}`);
    assert.strictEqual(cshLockMgr.status, 403, 'Thu ngân gọi PATCH toggle-active phải bị 403');

    const cshResetMgr = await httpRequest(
      'PATCH',
      `/api/employees/${mgrId}/reset-password`,
      { password: 'NewCashierHack123', confirm_password: 'NewCashierHack123' },
      cashierAuth.cookie,
      cashierAuth.csrfToken
    );
    console.log(`  Thu ngân PATCH /api/employees/${mgrId}/reset-password -> Status: ${cshResetMgr.status}`);
    assert.strictEqual(cshResetMgr.status, 403, 'Thu ngân gọi reset-password phải bị 403');

    const cshDeleteMgr = await httpRequest(
      'DELETE',
      `/api/employees/${mgrId}`,
      null,
      cashierAuth.cookie,
      cashierAuth.csrfToken
    );
    console.log(`  Thu ngân DELETE /api/employees/${mgrId} -> Status: ${cshDeleteMgr.status}`);
    assert.strictEqual(cshDeleteMgr.status, 403, 'Thu ngân gọi DELETE phải bị 403');

    console.log('✓ [4] Thu ngân hoàn toàn bị chặn khi cố tình gọi API hoặc thay ID/payload (HTTP 403)');

    // 5. Kiểm tra Quản lý vẫn quản lý thu ngân bình thường (sửa, khóa, mở khóa, reset password, xóa)
    console.log('\n--- Kiểm tra Quản lý quản lý thu ngân bình thường ---');
    // 5.1 Sửa họ tên thu ngân
    const mgrUpdateCsh = await httpRequest(
      'PUT',
      `/api/employees/${testCashierId}`,
      { full_name: 'Thu Ngân Updated Name', role: 'CASHIER' },
      mgrAuth.cookie,
      mgrAuth.csrfToken
    );
    console.log(`  Quản lý PUT /api/employees/${testCashierId} -> Status: ${mgrUpdateCsh.status}`);
    assert.strictEqual(mgrUpdateCsh.status, 200, 'Quản lý sửa thu ngân thành công (HTTP 200)');

    // 5.2 Khóa thu ngân
    const mgrLockCsh = await httpRequest(
      'PATCH',
      `/api/employees/${testCashierId}/toggle-active`,
      { is_active: false },
      mgrAuth.cookie,
      mgrAuth.csrfToken
    );
    console.log(`  Quản lý PATCH lock /api/employees/${testCashierId} -> Status: ${mgrLockCsh.status}`);
    assert.strictEqual(mgrLockCsh.status, 200, 'Quản lý khóa thu ngân thành công (HTTP 200)');

    // 5.3 Mở khóa thu ngân
    const mgrUnlockCsh = await httpRequest(
      'PATCH',
      `/api/employees/${testCashierId}/toggle-active`,
      { is_active: true },
      mgrAuth.cookie,
      mgrAuth.csrfToken
    );
    console.log(`  Quản lý PATCH unlock /api/employees/${testCashierId} -> Status: ${mgrUnlockCsh.status}`);
    assert.strictEqual(mgrUnlockCsh.status, 200, 'Quản lý mở khóa thu ngân thành công (HTTP 200)');

    // 5.4 Đặt lại mật khẩu thu ngân
    const newTestCshPass = 'NewCashierPass456@';
    const mgrResetCsh = await httpRequest(
      'PATCH',
      `/api/employees/${testCashierId}/reset-password`,
      { password: newTestCshPass, confirm_password: newTestCshPass },
      mgrAuth.cookie,
      mgrAuth.csrfToken
    );
    console.log(`  Quản lý PATCH reset-password /api/employees/${testCashierId} -> Status: ${mgrResetCsh.status}`);
    assert.strictEqual(mgrResetCsh.status, 200, 'Quản lý reset mật khẩu thu ngân thành công (HTTP 200)');

    // Thu ngân đăng nhập lại với mật khẩu mới
    const cshNewLogin = await loginUser(testCashierUsername, newTestCshPass);
    assert.strictEqual(cshNewLogin.status, 200, 'Thu ngân đăng nhập thành công với mật khẩu mới được reset');
    console.log('✓ [5] Quản lý thực hiện các quyền quản lý thu ngân bình thường (sửa, khóa, mở khóa, reset password)');

    // 6. Kiểm tra luồng đổi mật khẩu cá nhân (/api/auth/change-password) trên môi trường cách ly (dùng tài khoản test, KHÔNG đổi pass admin)
    console.log('\n--- Kiểm tra luồng tự đổi mật khẩu cá nhân (cách ly, không đổi pass admin) ---');
    const selfChangePass = 'SelfChangedPass789@';
    const wrongCurRes = await httpRequest(
      'POST',
      '/api/auth/change-password',
      {
        current_password: 'WrongCurrentPassword!',
        new_password: selfChangePass,
        confirm_password: selfChangePass
      },
      cshNewLogin.cookie,
      cshNewLogin.csrfToken
    );
    console.log(`  Đổi mật khẩu sai mật khẩu hiện tại -> Status: ${wrongCurRes.status}`);
    assert.strictEqual(wrongCurRes.status, 400, 'Sai mật khẩu hiện tại phải trả 400');

    const mismatchRes = await httpRequest(
      'POST',
      '/api/auth/change-password',
      {
        current_password: newTestCshPass,
        new_password: selfChangePass,
        confirm_password: 'DifferentConfirmPassword@'
      },
      cshNewLogin.cookie,
      cshNewLogin.csrfToken
    );
    console.log(`  Đổi mật khẩu xác nhận không khớp -> Status: ${mismatchRes.status}`);
    assert.strictEqual(mismatchRes.status, 400, 'Mật khẩu xác nhận không khớp phải trả 400');

    const validChangeRes = await httpRequest(
      'POST',
      '/api/auth/change-password',
      {
        current_password: newTestCshPass,
        new_password: selfChangePass,
        confirm_password: selfChangePass
      },
      cshNewLogin.cookie,
      cshNewLogin.csrfToken
    );
    console.log(`  Đổi mật khẩu hợp lệ -> Status: ${validChangeRes.status}`);
    assert.strictEqual(validChangeRes.status, 200, 'Đổi mật khẩu thành công trả 200');

    // Đăng nhập lại với mật khẩu mới tự đổi
    const cshReLogin = await loginUser(testCashierUsername, selfChangePass);
    assert.strictEqual(cshReLogin.status, 200, 'Đăng nhập thành công với mật khẩu mới tự đổi');
    console.log('✓ [6] Luồng tự đổi mật khẩu cá nhân qua /api/auth/change-password hoạt động chính xác');

    // Dọn dẹp tài khoản thu ngân thử nghiệm
    const delTestCsh = await httpRequest(
      'DELETE',
      `/api/employees/${testCashierId}`,
      null,
      mgrAuth.cookie,
      mgrAuth.csrfToken
    );
    console.log(`  Dọn dẹp tài khoản thu ngân test: DELETE /api/employees/${testCashierId} -> Status: ${delTestCsh.status}`);
    assert.strictEqual(delTestCsh.status, 200, 'Xóa tài khoản thu ngân thử nghiệm thành công');

    // 7. Kiểm tra giao diện HTML và JavaScript tại cổng 8080
    console.log('\n--- Kiểm tra giao diện qua cổng 8080 ---');
    const pageRes = await httpRequest('GET', '/employees', null, mgrAuth.cookie);
    assert.strictEqual(pageRes.status, 200, 'Tải trang /employees thành công qua cổng 8080 (HTTP 200)');
    
    // Tải tệp /public/js/employees.js qua Nginx cổng 8080 để xác nhận container đang phục vụ mã mới
    const jsRes = await httpRequest('GET', '/public/js/employees.js', null, mgrAuth.cookie);
    assert.strictEqual(jsRes.status, 200, 'Tải /public/js/employees.js thành công');
    assert(jsRes.data.includes('Tài khoản hệ thống — được bảo vệ'), 'public/js/employees.js phải chứa text bảo vệ tài khoản hệ thống');
    assert(jsRes.data.includes('showEditEmployeeModal'), 'Chứa hàm showEditEmployeeModal');
    console.log('✓ [7] Website cổng 8080 phục vụ trang /employees và JavaScript đã cập nhật mã bảo vệ');

    console.log('\n=== TẤT CẢ CÁC BƯỚC KIỂM THỬ ĐÃ THÀNH CÔNG 100% ===');
  } finally {
    await db.end();
  }
}

run().catch((err) => {
  console.error('LỖI KIỂM THỬ:', err);
  process.exit(1);
});
