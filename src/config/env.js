'use strict';

require('dotenv').config();

const warned = new Set();

/* ------------------------------ internal utils ------------------------------ */

function _warnMissing(key) {
  if (!warned.has(key)) {
    // Professional, single-line, structured-ish warning
    console.warn(`[env] missing key: ${key}`);
    warned.add(key);
  }
}

function _trim(v) {
  return typeof v === 'string' ? v.trim() : v;
}

/* --------------------------------- getters ---------------------------------- */

/**
 * Get raw string (trimmed). If unset, returns default (can be undefined).
 */
function get(key, def = undefined) {
  const v = process.env[key];
  if (v === undefined || v === null || String(v).trim() === '') return def;
  return String(v).trim();
}

/**
 * Get integer. If parse fails, returns default.
 */
function getInt(key, def = 0) {
  const v = Number.parseInt(get(key, ''), 10);
  return Number.isFinite(v) ? v : def;
}

/**
 * Get float. If parse fails, returns default.
 */
function getFloat(key, def = 0) {
  const v = Number.parseFloat(get(key, ''));
  return Number.isFinite(v) ? v : def;
}

/**
 * Get boolean. Accepts: 1,true,yes,y,on / 0,false,no,n,off (case-insensitive)
 */
function getBool(key, def = false) {
  const raw = get(key, '');
  if (raw === undefined) return !!def;
  const s = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return !!def;
}

/**
 * Get comma-separated list -> string[]
 */
function getList(key, def = []) {
  const raw = get(key, '');
  if (!raw) return Array.isArray(def) ? def : [];
  return String(raw)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Require a value. If missing, logs a one-time warning and returns '' (empty).
 * Use when a key is important but you still want fail-soft behavior.
 */
function requireEnv(key) {
  const v = get(key, '');
  if (!v) _warnMissing(key);
  return v;
}

/* --------------------------------- helpers ---------------------------------- */

function clampInt(n, min, max) {
  const x = Number.isFinite(n) ? n : min;
  return Math.min(Math.max(x, min), max);
}

/**
 * Return { hour, minute } from two keys with defaults and clamping.
 * Example: getExecHM('OFFBOARD_EXEC', 14, 20) reads OFFBOARD_EXEC_HOUR/MIN.
 */
function getExecHM(prefix, defH = 0, defM = 0) {
  const h = clampInt(getInt(`${prefix}_HOUR`, defH), 0, 23);
  const m = clampInt(getInt(`${prefix}_MIN`, defM), 0, 59);
  return { hour: h, minute: m };
}

/* ------------------------------ email helpers ------------------------------- */

/**
 * Email is considered enabled if EMAIL_MODE != off and SMTP host/user/pass exist.
 * This mirrors the routing layer's expectations without hard failure.
 */
function isEmailEnabled() {
  const mode = (get('EMAIL_MODE', 'event') || 'event').toLowerCase();
  if (mode === 'off') return false;
  return !!(get('EMAIL_SMTP_HOST') && get('EMAIL_SMTP_USER') && get('EMAIL_SMTP_PASS'));
}

/**
 * Provide a normalized email config snapshot (no secrets leaked in logs).
 * Consumers may still read process.env directly; this is just convenience.
 */
function readEmailConfig() {
  return {
    mode: (get('EMAIL_MODE', 'event') || 'event').toLowerCase(),     // event|summary|both|off
    subjectPrefix: get('EMAIL_SUBJECT_PREFIX', '[Zoho-Azure Sync]'),
    smtp: {
      host: get('EMAIL_SMTP_HOST', ''),
      port: getInt('EMAIL_SMTP_PORT', 587),
      secure: getBool('EMAIL_SMTP_SECURE', false),
      user: get('EMAIL_SMTP_USER', ''),
      // do not include pass in snapshots/logs
    },
    from: get('EMAIL_FROM', 'sync@example.com'),
    toSuccess: get('EMAIL_TO_SUCCESS', ''),
    toFailure: get('EMAIL_TO_FAILURE', ''),
    toSummary: get('EMAIL_TO_SUMMARY', ''),
    ratePerMinute: getInt('EMAIL_RATE_PER_MINUTE', 120),
    hidePII: getBool('EMAIL_HIDE_PII', true)
  };
}

/* --------------------------------- exports ---------------------------------- */

module.exports = {
  // existing API (backward-compatible)
  get,
  getInt,

  // new safe helpers
  getFloat,
  getBool,
  getList,
  requireEnv,
  clampInt,
  getExecHM,

  // email utilities
  isEmailEnabled,
  readEmailConfig
};
