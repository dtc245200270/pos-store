const crypto = require('crypto');

function requestIdMiddleware(req, res, next) {
  const incomingId = req.headers['x-request-id'];
  const requestId = (incomingId && typeof incomingId === 'string' && incomingId.trim()) 
    ? incomingId.trim() 
    : crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);
  next();
}

module.exports = requestIdMiddleware;
