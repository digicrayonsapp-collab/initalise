'use strict';

/**
 * errors.js
 * Robust application error type with safe serialization and adapters.
 * - Backward-compatible exports: AppError, toAppError
 * - Extras: isAppError, httpError helpers, getSafeErrorPayload
 */

const SENSITIVE_KEYS = new Set([
  'authorization', 'cookie', 'set-cookie',
  'client_secret', 'clientsecret', 'secret',
  'password', 'pass', 'token', 'access_token', 'refresh_token',
  'api_key', 'apikey', 'key'
]);

const MAX_DETAIL_BYTES = 2048;

/* --------------------------------- utils ---------------------------------- */

function clampStatus(n) {
  const x = Number.isFinite(n) ? n : 500;
  if (x < 400) return 500;
  if (x > 599) return 500;
  return x;
}

function maskString(v) {
  if (typeof v !== 'string') return v;
  // mask long token-like substrings
  if (v.length > 40) return v.slice(0, 6) + '***' + v.slice(-4);
  return v;
}

function redact(value, path = []) {
  if (value == null) return value;

  // redact strings under sensitive paths
  const key = path.length ? String(path[path.length - 1]).toLowerCase() : '';
  if (SENSITIVE_KEYS.has(key)) return '[redacted]';

  if (typeof value === 'string') return maskString(value);
  if (Array.isArray(value)) return value.map((x, i) => redact(x, path.concat(i)));

  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redact(v, path.concat(k));
    }
    return out;
  }

  return value;
}

function safeTruncateBytes(s, max = MAX_DETAIL_BYTES) {
  try {
    const buf = Buffer.from(String(s), 'utf8');
    if (buf.length <= max) return s;
    return buf.subarray(0, max).toString('utf8') + '…';
  } catch {
    return String(s);
  }
}

/* ------------------------------- AppError --------------------------------- */

class AppError extends Error {
  /**
   * @param {number|object} statusOrOpts HTTP status or options object
   * @param {string} message Human-readable message
   * @param {object} details Optional details (safe to log after redaction)
   */
  constructor(statusOrOpts, message, details) {
    const opts = typeof statusOrOpts === 'object'
      ? statusOrOpts
      : { status: statusOrOpts, message, details };

    super(opts.message || 'Internal Server Error');

    this.name = 'AppError';
    this.status = clampStatus(opts.status || 500);
    this.code = opts.code || undefined;
    this.details = opts.details !== undefined ? opts.details : undefined;
    this.expose = opts.expose === true; // if true, message can be shown to client
    this.cause = opts.cause;

    if (Error.captureStackTrace) Error.captureStackTrace(this, AppError);
  }

  toJSON() {
    return getSafeErrorPayload(this);
  }
}

/* ------------------------------ Converters -------------------------------- */

function isAxiosError(err) {
  return !!(err && (err.isAxiosError || err.response || err.config));
}

function fromAxiosError(err) {
  const status = clampStatus(err?.response?.status || err?.status || 500);

  let message =
    err?.response?.data?.error ||
    err?.response?.data?.message ||
    err?.message ||
    'HTTP error';

  // Build compact, redacted details
  const details = {
    request: {
      method: err?.config?.method,
      url: err?.config?.url,
      // do not include headers/body to avoid leaking secrets
    },
    response: {
      status: err?.response?.status,
      data: undefined
    }
  };

  // Include a truncated, redacted snapshot of response data if present
  const respData = err?.response?.data;
  if (respData !== undefined) {
    let cooked = respData;
    if (typeof cooked === 'object') cooked = JSON.stringify(redact(cooked));
    cooked = safeTruncateBytes(String(cooked));
    details.response.data = cooked;
  }

  return new AppError({ status, message, details, cause: err });
}

function toAppError(err, fallbackStatus) {
  if (!err) return new AppError(fallbackStatus || 500, 'Unknown error');

  if (err instanceof AppError) return err;

  if (isAxiosError(err)) return fromAxiosError(err);

  const status = clampStatus(
    err.status || err.statusCode || err.response?.status || fallbackStatus || 500
  );

  const message =
    err.message ||
    err.response?.data?.error ||
    err.response?.data?.message ||
    'Internal Server Error';

  // Try to preserve some context without leaking secrets
  let rawDetails = err.details || err.response?.data || undefined;
  if (rawDetails && typeof rawDetails === 'object') {
    try { rawDetails = JSON.parse(JSON.stringify(rawDetails)); } catch { }
  }
  const details = rawDetails ? redact(rawDetails) : undefined;

  return new AppError({ status, message, details, cause: err });
}

/* --------------------------- HTTP helper factories ------------------------- */

function httpError(status, message, details) {
  return new AppError({ status: clampStatus(status), message, details });
}

const badRequest = (msg = 'Bad Request', d) => httpError(400, msg, d);
const unauthorized = (msg = 'Unauthorized', d) => httpError(401, msg, d);
const forbidden = (msg = 'Forbidden', d) => httpError(403, msg, d);
const notFound = (msg = 'Not Found', d) => httpError(404, msg, d);
const conflict = (msg = 'Conflict', d) => httpError(409, msg, d);
const tooManyRequests = (msg = 'Too Many Requests', d) => httpError(429, msg, d);
const serviceUnavailable = (msg = 'Service Unavailable', d) => httpError(503, msg, d);

/* ---------------------------- Safe client payload -------------------------- */

function getSafeErrorPayload(err) {
  const e = err instanceof AppError ? err : toAppError(err);

  const payload = {
    status: e.status,
    code: e.code || undefined,
    message: e.expose ? e.message : httpStatusMessage(e.status),
    // include redacted details only if present
    details: e.details ? redact(e.details) : undefined
  };

  return payload;
}

function httpStatusMessage(status) {
  switch (status) {
    case 400: return 'Bad Request';
    case 401: return 'Unauthorized';
    case 403: return 'Forbidden';
    case 404: return 'Not Found';
    case 409: return 'Conflict';
    case 422: return 'Unprocessable Entity';
    case 429: return 'Too Many Requests';
    case 500: return 'Internal Server Error';
    case 502: return 'Bad Gateway';
    case 503: return 'Service Unavailable';
    case 504: return 'Gateway Timeout';
    default: return 'Error';
  }
}

/* --------------------------------- exports -------------------------------- */

module.exports = {
  AppError,
  toAppError,

  // helpful extras (optional use)
  isAppError: (e) => e instanceof AppError,
  httpError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  tooManyRequests,
  serviceUnavailable,
  getSafeErrorPayload
};
