'use strict';

/**
 * services/graphAuth.js
 * Returns an Azure AD app-only access token for Microsoft Graph.
 *
 * API:
 *   - getAzureAccessToken(opts?) -> Promise<string>
 *   - resetAzureTokenCache()     -> void
 *   - clearAzureTokenCache()     -> void (alias)
 *
 * opts:
 *   { scope?: string, force?: boolean }
 *   scope defaults to 'https://graph.microsoft.com/.default'
 */

const axios = require('axios');
const qs = require('qs');
const { get } = require('../config/env');
const { log } = require('../core/logger');

const TIMEOUT_MS = Number.parseInt(process.env.AZURE_AUTH_TIMEOUT_MS || '20000', 10); // 20s
const AUTH_HOST = process.env.AZURE_AUTH_HOST || 'login.microsoftonline.com';

// isolated axios for auth calls (no global interceptors)
const http = axios.create({ timeout: TIMEOUT_MS });

let cache = {
  key: '',
  token: '',
  expMs: 0
};

function tokenKey(tenant, clientId, scope) {
  return String(tenant) + '|' + String(clientId) + '|' + String(scope || '');
}

function nowMs() { return Date.now(); }

function validateEnv() {
  const tenant = get('AZURE_TENANT_ID');
  const clientId = get('AZURE_CLIENT_ID');
  const clientSecret = get('AZURE_CLIENT_SECRET');

  if (!tenant || !clientId || !clientSecret) {
    throw new Error('Azure credentials missing (AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET)');
  }
  return { tenant, clientId, clientSecret };
}

function shouldUseCache(key) {
  return cache.token && cache.key === key && cache.expMs > nowMs();
}

function setCache(key, token, expiresInSec) {
  // Safety buffer: refresh ~10% early, min 60s, max 5m
  const safety = Math.max(60, Math.min(300, Math.floor(expiresInSec * 0.1)));
  cache = {
    key,
    token,
    expMs: nowMs() + Math.max(1, (expiresInSec - safety)) * 1000
  };
}

/**
 * Minimal retry for transient auth errors.
 * Retries on 429, 5xx, ECONNRESET, ETIMEDOUT. Honors Retry-After.
 */
async function withRetry(fn, { tries = 3, baseMs = 400 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const status = e?.response?.status;
      const transient =
        status === 429 ||
        (status >= 500 && status <= 599) ||
        e.code === 'ECONNRESET' ||
        e.code === 'ETIMEDOUT';
      if (!transient || i === tries - 1) break;

      // Honor Retry-After if present
      let delay = baseMs * (i + 1);
      const ra = e?.response?.headers?.['retry-after'];
      if (ra) {
        const sec = parseInt(ra, 10);
        if (Number.isFinite(sec)) delay = Math.max(delay, sec * 1000);
      }
      delay += Math.floor(Math.random() * 200);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

async function fetchToken({ tenant, clientId, clientSecret, scope }) {
  const body = qs.stringify({
    client_id: clientId,
    client_secret: clientSecret,
    scope: scope || 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials'
  });

  const url = `https://${AUTH_HOST}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;

  // Use validateStatus to always resolve; craft clear error for non-200
  const res = await http.post(url, body, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    validateStatus: () => true
  });

  if (res.status !== 200) {
    const errMsg =
      res.data?.error_description ||
      res.data?.error ||
      JSON.stringify(res.data || {});
    throw Object.assign(new Error(`Azure token error (${res.status}): ${errMsg}`), {
      response: res
    });
  }

  const token = res.data?.access_token;
  const expiresIn = Number.parseInt(res.data?.expires_in, 10);

  if (!token || !Number.isFinite(expiresIn)) {
    const msg = 'Invalid token response from Azure AD';
    log.error({ data: res?.data }, '[auth] ' + msg);
    throw new Error(msg);
  }

  return { token, expiresIn };
}

/**
 * Get an app-only access token for Microsoft Graph.
 * Caches until near-expiry. Call with { force: true } to bypass cache.
 */
async function getAzureAccessToken(opts) {
  const scope = (opts && opts.scope) || 'https://graph.microsoft.com/.default';
  const force = !!(opts && opts.force);

  const { tenant, clientId, clientSecret } = validateEnv();
  const key = tokenKey(tenant, clientId, scope);

  if (!force && shouldUseCache(key)) {
    return cache.token;
  }

  const { token, expiresIn } = await withRetry(
    () => fetchToken({ tenant, clientId, clientSecret, scope }),
    { tries: 3, baseMs: 500 }
  );

  setCache(key, token, expiresIn);
  log.debug({ tenant: tenant.slice(0, 4) + '…', scope }, '[auth] token acquired');
  return token;
}

function resetAzureTokenCache() {
  cache = { key: '', token: '', expMs: 0 };
}

function clearAzureTokenCache() { resetAzureTokenCache(); }

module.exports = { getAzureAccessToken, resetAzureTokenCache, clearAzureTokenCache };
