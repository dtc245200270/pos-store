const crypto = require('crypto');

// Danh sách các trường nhạy cảm cần loại bỏ hoặc che giấu
const SENSITIVE_KEYS = new Set([
  'password',
  'password_hash',
  'passwordhash',
  'current_password',
  'new_password',
  'confirm_password',
  'pass',
  'token',
  'csrftoken',
  'x-csrf-token',
  'cookie',
  'connect.sid',
  'session',
  'sessionid',
  'authorization',
  'secret',
  'session_secret',
  'connectionstring',
  'sql',
  'query',
  'parameters',
  'params',
  'db_password',
  'root_password'
]);

function sanitizeData(data) {
  if (data === null || data === undefined) return data;
  if (typeof data !== 'object') return data;
  if (Array.isArray(data)) {
    return data.map(sanitizeData);
  }

  const clean = {};
  for (const [key, value] of Object.entries(data)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_KEYS.has(lowerKey)) {
      continue; // Bỏ qua hoàn toàn dữ liệu nhạy cảm
    }
    if (value && typeof value === 'object') {
      clean[key] = sanitizeData(value);
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

const fs = require('fs');
const path = require('path');

const LOGS_DIR = path.resolve(__dirname, '..', 'logs');
if (!fs.existsSync(LOGS_DIR)) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  } catch (_) {}
}
const LOG_FILE_PATH = path.join(LOGS_DIR, 'app.log');

function appendToFile(line) {
  try {
    fs.appendFileSync(LOG_FILE_PATH, line, { encoding: 'utf8' });
  } catch (fileErr) {
    // Tranh gay loi gián doan luong ung dung
  }
}

function writeLog(level, data) {
  try {
    const payload = {
      timestamp: new Date().toISOString(),
      level,
      ...sanitizeData(data)
    };
    const jsonLine = JSON.stringify(payload) + '\n';

    // 1. Ghi ben vung vao file UTF-8 de Grafana Alloy thu thap
    appendToFile(jsonLine);

    // 2. Tiep tuc ghi vao stdout/stderr
    if (level === 'error') {
      process.stderr.write(jsonLine);
    } else {
      process.stdout.write(jsonLine);
    }
  } catch (err) {
    const fallback = JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'error',
      event: 'logger_error',
      message: 'Failed to serialize log line'
    }) + '\n';
    appendToFile(fallback);
    process.stderr.write(fallback);
  }
}

const logger = {
  info(data) {
    writeLog('info', data);
  },
  warn(data) {
    writeLog('warn', data);
  },
  error(data) {
    writeLog('error', data);
  },
  logHttpRequest(data) {
    writeLog(data.level || 'info', {
      event: 'http_request',
      ...data
    });
  },
  logServerError(req, operation, error) {
    if (!req) return;
    // Chống ghi log lặp lại cho cùng một request
    if (req._serverErrorLogged) return;
    req._serverErrorLogged = true;

    const requestId = req.requestId || 'unknown';
    const errorCode = error?.code || 'INTERNAL_ERROR';
    const errorType = error?.name || (error instanceof Error ? 'Error' : 'UnknownError');

    const logData = {
      event: 'server_error',
      requestId,
      operation: operation || 'unknown_operation',
      errorType,
      errorCode
    };

    if (req.session?.userId) {
      logData.userId = req.session.userId;
    }
    if (req.session?.role) {
      logData.role = req.session.role;
    }

    writeLog('error', logData);
  },
  sendServerError(res, req, operation, error) {
    logger.logServerError(req, operation, error);
    if (!res.headersSent) {
      return res.status(500).json({
        error: 'Lỗi máy chủ nội bộ',
        requestId: req?.requestId || null
      });
    }
  }
};

module.exports = logger;
