'use strict';

// src/services/graphAuth.js
const axios = require('axios');
const qs = require('qs');
const { get } = (() => { try { return require('../config/env'); } catch { return { get: (k, d) => process.env[k] ?? d }; } })();

const DEFAULT_TIMEOUT = 15000;

// axios instance with sane timeout
const http = axios.create({ timeout: DEFAULT_TIMEOUT });

/* -------------------------------- utilities -------------------------------- */

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

function mask(v) {
  if (!v) return 'MISSING';
  const s = String(v);
  return s.length <= 6 ? '***' : `${s.slice(0, 3)}…${s.slice(-3)}`;
}

/* ------------------------------- token cache -------------------------------- */

let _cache = { token: null, expTs: 0, scope: null };

function cacheValid(scope) {
  return _cache.token && _cache.scope === scope && Date.now() < (_cache.expTs - 60_000);
}

/* ------------------------------ main function ------------------------------ */

/**
 * Get an Azure AD application token for Microsoft Graph using client credentials.
 * Respects caching; override scope/authority via env.
 *
 * Env:
 *   AZURE_TENANT_ID (required)
 *   AZURE_CLIENT_ID (required)
 *   AZURE_CLIENT_SECRET (required)
 *   AZURE_SCOPE (optional, default: 'https://graph.microsoft.com/.default')
 *   AZURE_LOGIN_HOST (optional, default: 'https://login.microsoftonline.com')
 */
async function getAzureAccessToken() {
  const tenant = get('AZURE_TENANT_ID');
  const clientId = get('AZURE_CLIENT_ID');
  const clientSecret = get('AZURE_CLIENT_SECRET');

  if (!tenant || !clientId || !clientSecret) {
    // professional, non-leaky message
    throw new Error('Azure credentials missing (tenant/clientId/clientSecret)');
  }

  const scope = (get('AZURE_SCOPE', 'https://graph.microsoft.com/.default') || '').trim();
  if (cacheValid(scope)) return _cache.token;

  const loginHost = (get('AZURE_LOGIN_HOST', 'https://login.microsoftonline.com') || '').replace(/\/+$/, '');
  const url = `${loginHost}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;

  const body = qs.stringify({
    client_id: clientId,
    client_secret: clientSecret,
    scope,
    grant_type: 'client_credentials'
  });

  try {
    const res = await withRetry(() => http.post(url, body, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    }));

    const token = res?.data?.access_token;
    if (!token) {
      const hint = res?.data?.error_description || res?.data?.error || 'no access_token in response';
      throw new Error(`Token response invalid: ${hint}`);
    }

    // cache with TTL; default ~55m if expires_in missing
    const ttlSec = parseInt(res?.data?.expires_in, 10);
    const ttlMs = Number.isFinite(ttlSec) ? Math.max(30, ttlSec) * 1000 : 55 * 60 * 1000;
    _cache = { token, expTs: Date.now() + ttlMs, scope };

    return token;
  } catch (err) {
    const status = err?.response?.status;
    const payload = err?.response?.data;
    const msg =
      (payload && (payload.error_description || payload.error)) ||
      err?.message ||
      'token fetch failed';

    // mask IDs in the log line; do not print secrets
    console.error('[AUTH] Azure token fetch failed:', {
      status,
      tenant: mask(tenant),
      clientId: mask(clientId),
      message: String(msg).slice(0, 400)
    });

    throw err;
  }
}

module.exports = { getAzureAccessToken };
