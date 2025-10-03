'use strict';

// src/core/logger.js
const morgan = require('morgan');

// Optional email env loader is isolated to avoid hard deps here.
let envObj = {};
try { ({ env: envObj } = require('../infra/env')); } catch (_) { /* noop */ }

const isProd = process.env.NODE_ENV === 'production';
const LOG_LEVEL = (process.env.LOG_LEVEL || (isProd ? 'info' : 'debug')).toLowerCase(); // debug|info|warn|error
const LOG_JSON = String(process.env.LOG_JSON || '').toLowerCase() === 'true';
const CLIP = Number.isFinite(parseInt(process.env.LOG_CLIP, 10)) ? parseInt(process.env.LOG_CLIP, 10) : 10000;

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
function levelEnabled(lvl) { return LEVELS[lvl] >= LEVELS[LOG_LEVEL]; }

function clip(s, n = CLIP) {
  try {
    const str = String(s);
    return str.length > n ? str.slice(0, n) : str;
  } catch { return s; }
}

// Redact likely secrets in strings
function maskSecretsStr(s) {
  if (!s) return s;
  let t = String(s);

  // Authorization headers / bearer tokens
  t = t.replace(/Authorization:\s*Bearer\s+[A-Za-z0-9._\-~+/=]+/gi, 'Authorization: Bearer [REDACTED]');

  // Client secrets and passwords in key=value or JSON-ish blobs
  t = t.replace(/([A-Za-z0-9_.-]*(secret|password|pwd|token)[A-Za-z0-9_.-]*)(\s*[:=]\s*)["']?([^"'\s]{6,})["']?/gi, '$1$3[REDACTED]');

  // Azure/Zoh o tokens and GUID-like long strings (best-effort)
  t = t.replace(/\b(eyJ[0-9A-Za-z._-]{20,}|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\b/gi, '[REDACTED]');

  return t;
}

function maskSecretsObj(obj, depth = 0) {
  if (obj == null || depth > 4) return obj;
  if (typeof obj === 'string') return maskSecretsStr(obj);
  if (Array.isArray(obj)) return obj.map((v) => maskSecretsObj(v, depth + 1));

  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      const lk = k.toLowerCase();
      if (lk.includes('password') || lk.includes('secret') || lk.includes('token') || lk === 'authorization' || lk === 'cookie') {
        out[k] = '[REDACTED]';
      } else {
        out[k] = maskSecretsObj(v, depth + 1);
      }
    }
    return out;
  }
  return obj;
}

function toPrintable(args) {
  if (!args || !args.length) return { msg: '', meta: null };

  // If first arg is an object with a 'msg', prefer structured log
  const [first, ...rest] = args;

  // Normalize error objects
  const norm = (v) => {
    if (v instanceof Error) {
      return {
        name: v.name,
        message: maskSecretsStr(v.message),
        stack: clip(maskSecretsStr(v.stack || '')),
      };
    }
    return maskSecretsObj(v);
  };

  const sanitized = [norm(first), ...rest.map(norm)];

  // Build message string and meta
  if (typeof sanitized[0] === 'string') {
    const msg = maskSecretsStr(clip(sanitized[0]));
    const meta = sanitized.slice(1).length ? sanitized.slice(1) : null;
    return { msg, meta };
  }

  // If first item is object, use it as meta; optional second string as msg
  let msg = '';
  let meta = sanitized[0];
  if (typeof sanitized[1] === 'string') {
    msg = maskSecretsStr(clip(sanitized[1]));
    if (sanitized.length > 2) meta = { ...meta, extra: sanitized.slice(2) };
  } else if (sanitized.length > 1) {
    meta = { ...meta, extra: sanitized.slice(1) };
  }
  return { msg, meta };
}

function write(level, ...args) {
  if (!levelEnabled(level)) return;

  const ts = new Date().toISOString();
  const { msg, meta } = toPrintable(args);

  if (LOG_JSON) {
    const line = {
      ts,
      level,
      msg: msg || undefined,
      ...(meta ? { meta } : {})
    };
    // eslint-disable-next-line no-console
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(JSON.stringify(line));
    return;
  }

  const prefix = level === 'error' ? '[ERROR]' : level === 'warn' ? '[WARN ]' : level === 'info' ? '[INFO ]' : '[DEBUG]';
  const head = `${ts} ${prefix}`;
  if (meta) {
    // eslint-disable-next-line no-console
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(head, msg || '', meta);
  } else {
    // eslint-disable-next-line no-console
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(head, msg || '');
  }
}

const log = {
  debug: (...a) => write('debug', ...a),
  info:  (...a) => write('info',  ...a),
  warn:  (...a) => write('warn',  ...a),
  error: (...a) => write('error', ...a),
  isLevelEnabled: levelEnabled
};

// HTTP access log (text mode only; still fine under LOG_JSON because it's middleware)
const httpLogger = morgan(':method :url :status :res[content-length] - :response-time ms', {
  stream: {
    write: (line) => {
      // Trim newline from morgan and pass through our logger with minimal processing
      log.info('[HTTP]', maskSecretsStr(line.trim()));
    }
  }
});

module.exports = { httpLogger, log };
