'use strict';

const axios = require('axios');
const qs = require('qs');

// Prefer config/env helpers if available (non-fatal fallback)
let get = (k, d) => process.env[k] ?? d;
try { ({ get } = require('../config/env')); } catch (_) { }

const ZOHO_DC = (get('ZOHO_DC', 'com') || 'com').trim(); // com | in | eu | ...
const ZOHO_CLIENT_ID = get('ZOHO_CLIENT_ID', '');
const ZOHO_CLIENT_SECRET = get('ZOHO_CLIENT_SECRET', '');
const ZOHO_REFRESH_TOKEN = get('ZOHO_REFRESH_TOKEN', '');

const OFFICIAL_EMAIL_DOMAIN = (get('OFFICIAL_EMAIL_DOMAIN', '') || '').trim();
const OFFICIAL_EMAIL_FIELD_LINK_NAME = get('OFFICIAL_EMAIL_FIELD_LINK_NAME', 'Other_Email');

const ZOHO_PEOPLE_BASE = (get('ZOHO_PEOPLE_BASE', '') || '').trim() ||
  `https://people.zoho.${ZOHO_DC}`;
const ZOHO_ACCOUNTS_BASE = `https://accounts.zoho.${ZOHO_DC}`;

const DEFAULT_TIMEOUT = 15000;

/* --------------------------------- axios ---------------------------------- */

const http = axios.create({ timeout: DEFAULT_TIMEOUT });

// Simple transient retry (1 attempt) for 429/5xx/timeouts
async function withRetry(fn, { tries = 2, baseDelayMs = 500 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      const status = e?.response?.status;
      const transient = status === 429 || (status >= 500 && status <= 599) || e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT';
      if (i === tries - 1 || !transient) break;
      const jitter = Math.floor(Math.random() * 200);
      await new Promise(r => setTimeout(r, baseDelayMs + jitter));
    }
  }
  throw lastErr;
}

/* ---------------------------- token (with cache) --------------------------- */

let _tokenCache = { token: null, expTs: 0 }; // unix ms

async function getZohoAccessToken() {
  // use cache if still valid
  if (_tokenCache.token && Date.now() < _tokenCache.expTs - 5_000) {
    return _tokenCache.token;
  }

  if (!ZOHO_CLIENT_ID || !ZOHO_CLIENT_SECRET || !ZOHO_REFRESH_TOKEN) {
    throw new Error('Zoho OAuth env not configured (ZOHO_CLIENT_ID/SECRET/REFRESH_TOKEN)');
  }

  const tokenUrl = `${ZOHO_ACCOUNTS_BASE}/oauth/v2/token`;
  const formData = qs.stringify({
    refresh_token: ZOHO_REFRESH_TOKEN,
    client_id: ZOHO_CLIENT_ID,
    client_secret: ZOHO_CLIENT_SECRET,
    grant_type: 'refresh_token'
  });

  const res = await withRetry(() => http.post(tokenUrl, formData, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  }));

  const token = res?.data?.access_token;
  if (!token) {
    throw new Error(`Zoho token response missing access_token: ${JSON.stringify(res?.data || {})}`);
  }

  const ttlSec = Number.parseInt(res?.data?.expires_in, 10);
  const ttlMs = Number.isFinite(ttlSec) ? Math.max(30, ttlSec - 60) * 1000 : 55 * 60 * 1000; // default ~55m
  _tokenCache = { token, expTs: Date.now() + ttlMs };

  return token;
}

/* --------------------------------- helpers --------------------------------- */

function officialEmailFromUpn(upn) {
  if (!OFFICIAL_EMAIL_DOMAIN) return upn;
  const [local] = String(upn || '').split('@');
  return `${local}@${OFFICIAL_EMAIL_DOMAIN}`;
}

function ensureNumericZohoId(id) {
  const s = String(id || '').trim();
  if (!/^\d{8,}$/.test(s)) {
    throw new Error(`Zoho recordId must be a numeric People record id (got "${id}")`);
  }
  return s;
}

function zohoPeopleUrl(path) {
  // path examples:
  //   /people/api/forms/json/Candidate/updateRecord
  //   /people/api/forms/P_EmployeeView/records
  //   /api/forms/P_EmployeeView/records   (legacy)
  if (path.startsWith('http')) return path;
  if (!path.startsWith('/')) path = `/${path}`;
  return `${ZOHO_PEOPLE_BASE}${path}`;
}

function parseZohoRows(data) {
  // Zoho can reply in multiple shapes; normalize to array of rows
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.response?.result?.records)) return data.response.result.records;
  if (Array.isArray(data?.records)) return data.records;
  return [];
}

/* -------------------------------- Services --------------------------------- */

/**
 * Update Candidate record’s Official Email in Zoho People
 * @param {{recordId: string|number, officialEmail: string, fieldLinkName?: string}} params
 */
async function updateCandidateOfficialEmail({ recordId, officialEmail, fieldLinkName }) {
  const id = ensureNumericZohoId(recordId);
  const field = (fieldLinkName || OFFICIAL_EMAIL_FIELD_LINK_NAME || '').trim();
  if (!field) throw new Error('OFFICIAL_EMAIL_FIELD_LINK_NAME is not configured');

  const accessToken = await getZohoAccessToken();
  const body = qs.stringify({
    recordId: id,
    inputData: JSON.stringify({ [field]: officialEmail })
  });

  const url = zohoPeopleUrl('/people/api/forms/json/Candidate/updateRecord');

  const res = await withRetry(() => http.post(url, body, {
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    validateStatus: () => true
  }));

  const status = res?.data?.response?.status;
  if (status === 0) return res.data;

  const zErr = res?.data?.response?.errors || res?.data;
  throw new Error(`Zoho update failed: ${JSON.stringify(zErr)}`);
}

/**
 * Update arbitrary Candidate fields in Zoho People
 * @param {{recordId: string|number, fields: Object}} params
 */
async function updateCandidateFields({ recordId, fields }) {
  const id = ensureNumericZohoId(recordId);
  const accessToken = await getZohoAccessToken();

  const body = qs.stringify({
    recordId: String(id),
    inputData: JSON.stringify(fields || {})
  });

  const url = zohoPeopleUrl('/people/api/forms/json/Candidate/updateRecord');

  const res = await withRetry(() => http.post(url, body, {
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    validateStatus: () => true
  }));

  const status = res?.data?.response?.status;
  if (status === 0) return res.data;

  const zErr = res?.data?.response?.errors || res?.data;
  throw new Error(`Zoho update failed: ${JSON.stringify(zErr)}`);
}

/**
 * Fetch a page from an Employee view (defaults to P_EmployeeView).
 * Uses slindex/rec_limit for paging.
 */
async function fetchEmployeeViewPage({ viewName, slindex = 1, rec_limit = 200 } = {}) {
  const accessToken = await getZohoAccessToken();
  const vname = (viewName || get('ZOHO_EMPLOYEE_VIEW', 'P_EmployeeView')).trim();

  const url = zohoPeopleUrl(`/people/api/forms/${encodeURIComponent(vname)}/records`);
  const res = await withRetry(() => http.get(url, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    params: { slindex, rec_limit },
    validateStatus: () => true
  }));

  return parseZohoRows(res.data);
}

/**
 * Find employee row by email alias column (defaults to EMPLOYEEMAILALIASs).
 */
async function fetchEmployeeByEmailAlias({ email, viewName, aliasColumn } = {}) {
  const accessToken = await getZohoAccessToken();
  const vname = (viewName || get('ZOHO_EMPLOYEE_VIEW', 'P_EmployeeView')).trim();
  const column = (aliasColumn || get('ZOHO_EMPLOYEE_ALIAS_COLUMN', 'EMPLOYEEMAILALIASs')).trim();

  const url = zohoPeopleUrl(`/people/api/forms/${encodeURIComponent(vname)}/records`);
  const res = await withRetry(() => http.get(url, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    params: { searchColumn: column, searchValue: email },
    validateStatus: () => true
  }));

  const rows = parseZohoRows(res.data);
  return rows && rows.length ? rows[0] : null;
}

/**
 * Extract numeric Employee ID from a Zoho employee row.
 */
function extractEmployeeIdNumber(row) {
  const keys = ['Employee ID', 'Employee Id', 'Emp ID', 'EmpID', 'EmployeeID', 'EMPLOYEEID'];
  for (const k of keys) {
    if (row && row[k] != null) {
      const m = String(row[k]).trim().match(/\d+/);
      if (m) {
        const n = parseInt(m[0], 10);
        if (Number.isFinite(n)) return n;
      }
    }
  }
  return null;
}

/**
 * Returns the last (max) Employee_ID from Zoho People (P_EmployeeView), parsed as number.
 */
async function getLastEmployeeIdFromZoho() {
  const accessToken = await getZohoAccessToken();
  const field = (get('ZOHO_EMPLOYEEID_FIELD_LINK_NAME', 'Employee_ID') || 'Employee_ID').trim();

  const url = zohoPeopleUrl('/people/api/forms/P_EmployeeView/records');
  const res = await withRetry(() => http.get(url, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    params: { page: 1, perPage: 1, sortColumn: field, sortOrder: 'desc' },
    validateStatus: () => true
  }));

  const records = parseZohoRows(res.data);
  const rec = Array.isArray(records) ? records[0] : null;
  if (!rec) return null;

  const raw = String(rec[field] ?? rec['Employee_ID'] ?? '').trim();
  const m = raw.match(/\d+/);
  if (!m) return null;

  return parseInt(m[0], 10);
}

/**
 * Optional: scan all pages to compute next numeric Employee ID.
 * (Kept for completeness; not required if you use getNextEmployeeId from Graph)
 */
async function getNextEmployeeIdFromZoho({ pageSize = 200, maxPages = 50 } = {}) {
  let maxNum = 0;
  for (let page = 0; page < maxPages; page++) {
    const slindex = page * pageSize + 1; // 1-based
    const rows = await fetchEmployeeViewPage({ slindex, rec_limit: pageSize });
    if (!rows.length) break;

    for (const r of rows) {
      const n = extractEmployeeIdNumber(r);
      if (n != null && n > maxNum) maxNum = n;
    }
    if (rows.length < pageSize) break; // last page
  }
  return String(maxNum + 1 || 1);
}

module.exports = {
  officialEmailFromUpn,
  updateCandidateOfficialEmail,
  fetchEmployeeByEmailAlias,
  getLastEmployeeIdFromZoho,
  extractEmployeeIdNumber,
  updateCandidateFields,
  getZohoAccessToken,
  // optional export
  getNextEmployeeIdFromZoho
};
