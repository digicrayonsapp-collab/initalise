'use strict';

// src/services/graphUser.js
const axios = require('axios');
const { get } = (() => { try { return require('../config/env'); } catch { return { get: (k, d) => process.env[k] ?? d }; } })();

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const DEFAULT_TIMEOUT = 20000;

// dedicated axios instance
const graphHttp = axios.create({ baseURL: GRAPH_BASE, timeout: DEFAULT_TIMEOUT });

graphHttp.interceptors.request.use((config) => {
  config.headers = config.headers || {};
  config.headers['Accept'] = 'application/json';

  const method = (config.method || 'get').toLowerCase();
  const hasBody = !(config.data === undefined || config.data === null);

  // avoid sending a content-type on body-less verbs
  if (method === 'get' || method === 'delete' || !hasBody) {
    delete config.headers['Content-Type'];
    if (!hasBody) config.data = undefined;
    return config;
  }

  // JSON body for PATCH/POST
  if (typeof config.data !== 'string') config.data = JSON.stringify(config.data);
  config.headers['Content-Type'] = 'application/json';
  return config;
});

/* --------------------------------- retry ----------------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, { tries = 2, base = 400 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      const s = e?.response?.status;
      const transient = s === 429 || (s >= 500 && s <= 599) || e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT';
      if (i === tries - 1 || !transient) break;

      // simple backoff with jitter
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

/* --------------------------------- helpers --------------------------------- */

function escapeOdataValue(v) {
  return String(v).replace(/'/g, "''");
}

async function graphGet(token, path, params = {}) {
  const res = await withRetry(() => graphHttp.get(path, {
    headers: { Authorization: `Bearer ${token}` },
    params
  }));
  return res.data;
}

async function graphPost(token, path, body) {
  const res = await withRetry(() => graphHttp.post(path, body ?? {}, {
    headers: { Authorization: `Bearer ${token}` }
  }));
  return res.data;
}

async function graphPatch(token, path, body) {
  const res = await withRetry(() => graphHttp.patch(path, body ?? {}, {
    headers: { Authorization: `Bearer ${token}` }
  }));
  return res.data;
}

// Absolute URL variant (works with nextLink etc.)
async function graphRequest(method, url, token, data) {
  const res = await withRetry(() => graphHttp.request({
    method,
    url,
    data: data ?? undefined,
    headers: { Authorization: `Bearer ${token}` }
  }));
  return res.data;
}

function stripUndefined(obj) {
  const out = {};
  Object.keys(obj || {}).forEach((k) => {
    if (obj[k] !== undefined) out[k] = obj[k];
  });
  return out;
}

/* ------------------------------- CRUD helpers ------------------------------ */

async function deleteUser(token, id) {
  await withRetry(() => graphHttp.delete(`/users/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${token}` }
  }));
  return 204;
}

// Confirm it moved to Deleted Items (Recycle Bin)
async function getDeletedUser(token, id) {
  try {
    const res = await withRetry(() => graphHttp.get(
      `/directory/deletedItems/microsoft.graph.user/${encodeURIComponent(id)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    ));
    return res.data;
  } catch (err) {
    if (err?.response?.status === 404) return null;
    throw err;
  }
}

async function getUser(
  token,
  id,
  select = 'id,userPrincipalName,mail,employeeId,accountEnabled,displayName'
) {
  const res = await withRetry(() => graphHttp.get(`/users/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${token}` },
    params: { $select: select }
  }));
  return res.data;
}

// Body-less POST
async function revokeUserSessions(token, id) {
  await withRetry(() => graphHttp.post(
    `/users/${encodeURIComponent(id)}/revokeSignInSessions`,
    undefined,
    { headers: { Authorization: `Bearer ${token}` } }
  ));
  return 204;
}

/* --------------------------------- lookups --------------------------------- */

async function findUserByUPN(token, upn) {
  const data = await graphGet(token, '/users', {
    $filter: `userPrincipalName eq '${escapeOdataValue(upn)}'`,
    $select: 'id,userPrincipalName,mail,employeeId,accountEnabled,displayName'
  });
  return (data.value && data.value[0]) || null;
}

function normNickname(firstname, lastname) {
  return `${(firstname || '').toLowerCase()}.${(lastname || '').toLowerCase()}`
    .replace(/[^a-z0-9.]/g, '');
}

async function ensureUniquePrincipal(token, baseLocalPart, domain) {
  const base = String(baseLocalPart || '')
    .replace(/\.+/g, '.')
    .replace(/^\./, '')
    .replace(/\.$/, '');

  // bound attempts to avoid infinite loops
  const MAX_ATTEMPTS = 100;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const local = i === 0 ? base : `${base}${i}`;
    const upn = `${local}@${domain}`;
    const resp = await graphGet(token, '/users', {
      $filter:
        `(userPrincipalName eq '${escapeOdataValue(upn)}') or ` +
        `(mailNickname eq '${escapeOdataValue(local)}')`,
      $select: 'id'
    });
    if (!resp.value || resp.value.length === 0) {
      return { upn, mailNickname: local };
    }
  }
  throw new Error('exhausted attempts to ensure unique principal');
}

async function ensureUniqueUPN(token, baseLocalPart, domain) {
  const { upn } = await ensureUniquePrincipal(token, baseLocalPart, domain);
  return upn;
}

async function findByEmail(token, email) {
  if (!email) return null;
  const e = escapeOdataValue(email);
  const data = await graphGet(token, '/users', {
    $filter: `(mail eq '${e}') or (otherMails/any(c:c eq '${e}'))`,
    $select: 'id,userPrincipalName,mail,employeeId,accountEnabled,displayName'
  });
  return (data.value && data.value[0]) || null;
}

function prefixForEmployeeType(t) {
  if (!t) return '';
  const s = String(t).toLowerCase();
  if (s.includes('contractor')) return 'c-';
  if (s.includes('intern')) return 'i-';
  return '';
}

async function findByEmployeeId(token, employeeId) {
  if (!employeeId) return null;
  const data = await graphGet(token, '/users', {
    $filter: `employeeId eq '${escapeOdataValue(employeeId)}'`,
    $select: 'id,userPrincipalName,mail,employeeId,accountEnabled,displayName,otherMails'
  });
  return (data.value && data.value[0]) || null;
}

async function createUser(token, body) {
  return await graphPost(token, '/users', body);
}

async function updateUser(token, id, body) {
  return await graphPatch(token, `/users/${encodeURIComponent(id)}`, body);
}

function buildUpdatePayload(d) {
  return stripUndefined({
    displayName:
      `${(d.firstname || '').trim()} ${(d.lastname || '').trim()}`.trim() || undefined,
    givenName: d.firstname || undefined,
    surname: d.lastname || undefined,

    // 'mail' is read-only; use otherMails for external email
    otherMails: d.email ? [String(d.email).trim()] : undefined,

    employeeId:
      d.employeeId != null && String(d.employeeId).trim() !== ''
        ? String(d.employeeId).trim()
        : undefined,

    country: d.country || undefined,
    city: d.city || undefined,
    mobilePhone: d.mobilePhone || undefined,
    department: d.department || undefined,
    jobTitle: d.zohoRole || undefined,
    companyName: d.company || undefined,
    employeeType: d.employeeType || d.employementType || undefined,
    officeLocation: d.officelocation || undefined
  });
}

async function getNextEmployeeId(token, { maxScan = 50000 } = {}) {
  let url = '/users?$select=employeeId&$top=999';
  let maxNum = 0;
  let scanned = 0;

  while (url) {
    const res = await withRetry(() => graphHttp.get(url, {
      headers: { Authorization: `Bearer ${token}` }
    }));

    const batch = res.data?.value || [];
    scanned += batch.length;

    for (const u of batch) {
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

  return String(maxNum + 1);
}

async function upsertUser(token, data) {
  const domain = (data.domain || get('AZURE_DEFAULT_DOMAIN') || '').trim();
  if (!domain) throw new Error('AZURE_DEFAULT_DOMAIN is not configured');

  const base = normNickname(data.firstname || '', data.lastname || '');
  const pref = prefixForEmployeeType(data.employeeType || data.employementType);
  const nickBase = `${pref}${base}`;

  const updatePayload = buildUpdatePayload(data);

  // Update path if employee exists
  let existing = null;
  if (data.employeeId) {
    existing = await findByEmployeeId(token, String(data.employeeId).trim());
  }

  if (existing) {
    const currentLocal = String(existing.userPrincipalName || '').split('@')[0];
    const needsPrefix = !!pref;
    const hasKnownPrefix = currentLocal.startsWith('c-') || currentLocal.startsWith('i-');
    const wrongPrefix = hasKnownPrefix && !currentLocal.startsWith(pref) && needsPrefix;
    const shouldRename = (needsPrefix && !hasKnownPrefix) || wrongPrefix;

    if (shouldRename) {
      const { upn: newUpn, mailNickname } = await ensureUniquePrincipal(token, nickBase, domain);
      await updateUser(
        token,
        existing.id,
        stripUndefined({ userPrincipalName: newUpn, mailNickname, ...updatePayload })
      );
      return { action: 'updated', userId: existing.id, upn: newUpn, upnChanged: true, previousUpn: existing.userPrincipalName };
    }

    if (Object.keys(updatePayload).length) {
      await updateUser(token, existing.id, updatePayload);
    }
    return { action: 'updated', userId: existing.id, upn: existing.userPrincipalName, upnChanged: false };
  }

  // Create path
  const tempPassword = get('GRAPH_TEMP_PASSWORD', 'TempPass123!');
  const { upn, mailNickname } = await ensureUniquePrincipal(token, nickBase, domain);

  const createBody = stripUndefined({
    accountEnabled: true,
    displayName: `${data.firstname || ''} ${data.lastname || ''}`.trim(),
    mailNickname,
    userPrincipalName: upn,
    passwordProfile: { forceChangePasswordNextSignIn: true, password: tempPassword },
    otherMails: data.email ? [String(data.email).trim()] : undefined,
    givenName: data.firstname || undefined,
    surname: data.lastname || undefined,
    employeeId: data.employeeId || undefined,
    country: data.country || undefined,
    city: data.city || undefined,
    mobilePhone: data.mobilePhone || undefined,
    department: data.department || undefined,
    jobTitle: data.zohoRole || undefined,
    companyName: data.company || undefined,
    employeeType: data.employeeType || data.employementType || undefined,
    officeLocation: data.officelocation || undefined
  });

  const created = await createUser(token, createBody);
  return { action: 'created', userId: created.id, upn };
}

async function findUserByDisplayName(token, displayName) {
  try {
    const name = escapeOdataValue(String(displayName || '').trim());
    const data = await graphGet(token, '/users', {
      $filter: `displayName eq '${name}'`,
      $select: 'id,userPrincipalName,mail,employeeId,accountEnabled,displayName'
    });
    return (data.value && data.value[0]) || null;
  } catch (err) {
    console.error('findUserByDisplayName failed:', err?.response?.data || err?.message || String(err));
    return null;
  }
}

/* --------------------------------- exports --------------------------------- */

module.exports = {
  normNickname,
  ensureUniqueUPN,
  findByEmail,
  createUser,
  updateUser,
  findByEmployeeId,
  upsertUser,
  findUserByUPN,
  getNextEmployeeId,
  getUser,
  revokeUserSessions,
  deleteUser,
  ensureUniquePrincipal,
  getDeletedUser,
  prefixForEmployeeType,
  findUserByDisplayName
};
