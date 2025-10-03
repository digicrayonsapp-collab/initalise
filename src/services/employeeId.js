'use strict';

/**
 * src/services/employeeId.js
 * Next Employee ID helper with fallbacks:
 *  1) Zoho by email alias -> last + 1
 *  2) KV cache -> last + 1
 *  3) Graph scan -> max + 1
 */

const axios = require('axios');
const { getKV, setKV } = require('../infra/sqlite');
const { log } = require('../core/logger');

const DEFAULT_TIMEOUT = 15000;
const http = axios.create({ timeout: DEFAULT_TIMEOUT });

const KV_KEY = 'last_employee_id';

// simple retry for transient errors
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withRetry(fn, { tries = 2, base = 400 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      const s = e?.response?.status;
      const transient = s === 429 || (s >= 500 && s <= 599) || e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT';
      if (i === tries - 1 || !transient) break;

      let delay = base * (i + 1);
      const retryAfter = e?.response?.headers?.['retry-after'];
      if (retryAfter) {
        const sec = parseInt(retryAfter, 10);
        if (Number.isFinite(sec)) delay = Math.max(delay, sec * 1000);
      }
      delay += Math.floor(Math.random() * 200);
      await sleep(delay);
    }
  }
  throw lastErr;
}

/** Last resort: scan Graph users ($select=employeeId) and compute max. */
async function getMaxEmployeeIdFromGraph(token, { maxScan = 50000 } = {}) {
  let url = 'https://graph.microsoft.com/v1.0/users?$select=employeeId&$top=999';
  let maxNum = 0;
  let scanned = 0;

  while (url) {
    const res = await withRetry(() => http.get(url, { headers: { Authorization: `Bearer ${token}` } }));
    const users = res.data?.value || [];
    scanned += users.length;

    for (const u of users) {
      const raw = (u.employeeId ?? '').toString().trim();
      if (!raw) continue;
      const m = raw.match(/\d+/);
      if (!m) continue;
      const n = parseInt(m[0], 10);
      if (Number.isFinite(n) && n > maxNum) maxNum = n;
    }

    url = res.data?.['@odata.nextLink'] || null;
    if (scanned >= maxScan) break;
  }

  return maxNum || null;
}

/**
 * Get next Employee ID with fallbacks:
 *  1) Zoho (by email alias) -> last + 1
 *  2) KV cache -> last + 1
 *  3) Graph scan -> max + 1
 * Persists the chosen "last" (we store the next so subsequent calls increment by 1).
 *
 * @param {Object} opts
 * @param {string} [opts.email]       Email alias to look up in Zoho
 * @param {string} [opts.graphToken]  Bearer token for MS Graph
 * @param {boolean} [opts.strictZoho] If true, throw on Zoho failure instead of falling back
 * @returns {Promise<string>} next employee id
 */
async function getNextEmployeeIdSmart({ email, graphToken, strictZoho = false }) {
  // 1) Try Zoho by email alias
  try {
    const { fetchEmployeeByEmailAlias, extractEmployeeIdNumber } = require('./zohoPeople');
    if (email) {
      const row = await fetchEmployeeByEmailAlias({ email });
      const last = extractEmployeeIdNumber(row);
      if (Number.isFinite(last)) {
        const next = String(last + 1);
        setKV(KV_KEY, next);
        log.info('[EMPID] source=zoho last=%s next=%s', last, next);
        return next;
      }
    }
  } catch (e) {
    if (strictZoho) throw e;
    log.warn('[EMPID] zoho alias lookup failed: %s', e?.message || String(e));
  }

  // 2) KV cache
  const cached = getKV(KV_KEY);
  if (cached != null) {
    const base = parseInt(String(cached), 10);
    if (Number.isFinite(base)) {
      const next = String(base + 1);
      setKV(KV_KEY, next);
      log.warn('[EMPID] source=cache base=%s next=%s', base, next);
      return next;
    }
  }

  // 3) Graph fallback
  if (graphToken) {
    const maxGraph = await getMaxEmployeeIdFromGraph(graphToken);
    if (Number.isFinite(maxGraph)) {
      const next = String(maxGraph + 1);
      setKV(KV_KEY, next);
      log.warn('[EMPID] source=graph max=%s next=%s', maxGraph, next);
      return next;
    }
  }

  // Default start if everything else fails
  setKV(KV_KEY, '1');
  log.warn('[EMPID] source=default start=1');
  return '1';
}

module.exports = { getNextEmployeeIdSmart, getMaxEmployeeIdFromGraph };
