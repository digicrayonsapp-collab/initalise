'use strict';

const axios = require('axios');
const qs = require('qs');

const {
  ZOHO_CLIENT_ID,
  ZOHO_CLIENT_SECRET,
  ZOHO_REFRESH_TOKEN,
  ZOHO_PEOPLE_BASE = 'https://people.zoho.com',
  OFFICIAL_EMAIL_FIELD_LINK_NAME = 'Other_Email',
  OFFICIAL_EMAIL_DOMAIN,
  ZOHO_DC = 'com'
} = process.env;

function officialEmailFromUpn(upn) {
  if (!OFFICIAL_EMAIL_DOMAIN) return upn;
  const [local] = String(upn).split('@');
  return `${local}@${OFFICIAL_EMAIL_DOMAIN}`;
}

function zohoAccountsBase() {
  // e.g. https://accounts.zoho.in or https://accounts.zoho.com
  const dc = String(ZOHO_DC || 'com').trim();
  return `https://accounts.zoho.${dc}`;
}

async function getZohoAccessToken() {
  const tokenUrl = `${zohoAccountsBase()}/oauth/v2/token`;
  const formData = qs.stringify({
    refresh_token: ZOHO_REFRESH_TOKEN,
    client_id: ZOHO_CLIENT_ID,
    client_secret: ZOHO_CLIENT_SECRET,
    grant_type: 'refresh_token'
  });

  const res = await axios.post(tokenUrl, formData, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    validateStatus: () => true
  });

  if (res.status !== 200 || !res.data?.access_token) {
    const msg = `Zoho token error (${res.status}): ${JSON.stringify(res.data || {})}`;
    throw new Error(msg);
  }
  return res.data.access_token;
}

/**
 * Update Candidate record’s Official Email in Zoho People
 */
async function updateCandidateOfficialEmail({ recordId, officialEmail, fieldLinkName }) {
  const id = String(recordId || '').trim();
  if (!/^\d{8,}$/.test(id)) {
    throw new Error(`Zoho recordId must be numeric Zoho People record id (got "${recordId}")`);
  }

  const field = fieldLinkName || OFFICIAL_EMAIL_FIELD_LINK_NAME;
  if (!field) throw new Error('OFFICIAL_EMAIL_FIELD_LINK_NAME is not configured');

  const accessToken = await getZohoAccessToken();
  const body = qs.stringify({
    recordId: id,
    inputData: JSON.stringify({ [field]: officialEmail })
  });

  const url = `${ZOHO_PEOPLE_BASE}/people/api/forms/json/Candidate/updateRecord`;
  const res = await axios.post(url, body, {
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    validateStatus: () => true
  });

  const status = res.data?.response?.status;
  if (status === 0) return res.data;

  const zErr = res.data?.response?.errors || res.data;
  throw new Error(`Zoho update failed: ${JSON.stringify(zErr)}`);
}

async function fetchEmployeeViewPage({ viewName, slindex = 1, rec_limit = 200 }) {
  const accessToken = await getZohoAccessToken();
  const vname = viewName || process.env.ZOHO_EMPLOYEE_VIEW || 'P_EmployeeView';
  const url = `${ZOHO_PEOPLE_BASE}/api/forms/${encodeURIComponent(vname)}/records`;

  const res = await axios.get(url, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    params: { slindex, rec_limit },
    validateStatus: () => true
  });

  const rows = Array.isArray(res.data) ? res.data :
    (Array.isArray(res.data?.data) ? res.data.data : []);
  return rows;
}

async function fetchEmployeeByEmailAlias({ email, viewName, aliasColumn }) {
  const accessToken = await getZohoAccessToken();
  const vname = viewName || process.env.ZOHO_EMPLOYEE_VIEW || 'P_EmployeeView';
  const column = aliasColumn || process.env.ZOHO_EMPLOYEE_ALIAS_COLUMN || 'EMPLOYEEMAILALIASs';
  const url = `${ZOHO_PEOPLE_BASE}/api/forms/${encodeURIComponent(vname)}/records`;

  const res = await axios.get(url, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    params: { searchColumn: column, searchValue: email },
    validateStatus: () => true
  });

  const rows = Array.isArray(res.data) ? res.data :
    (Array.isArray(res.data?.data) ? res.data.data : []);
  return rows && rows.length ? rows[0] : null;
}

function extractEmployeeIdNumber(row) {
  const keys = ['Employee ID', 'Employee Id', 'Emp ID', 'EmpID', 'EmployeeID', 'EMPLOYEEID'];
  for (const k of keys) {
    if (row?.[k] != null) {
      const m = String(row[k]).trim().match(/\d+/);
      if (m) {
        const n = parseInt(m[0], 10);
        if (Number.isFinite(n)) return n;
      }
    }
  }
  return null;
}

async function updateCandidateFields({ recordId, fields }) {
  const accessToken = await getZohoAccessToken();
  const body = qs.stringify({
    recordId: String(recordId),
    inputData: JSON.stringify(fields)
  });
  const url = `${ZOHO_PEOPLE_BASE}/people/api/forms/json/Candidate/updateRecord`;
  const res = await axios.post(url, body, {
    headers: {
      Authorization: `Zoho-oauthtoken ${accessToken}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    validateStatus: () => true
  });
  const status = res.data?.response?.status;
  if (status === 0) return res.data;
  throw new Error(`Zoho update failed: ${JSON.stringify(res.data?.response?.errors || res.data)}`);
}

async function getNextEmployeeIdFromZoho({ pageSize = 200, maxPages = 50 } = {}) {
  let maxNum = 0;
  for (let page = 0; page < maxPages; page++) {
    const slindex = page * pageSize + 1;
    const rows = await fetchEmployeeViewPage({ slindex, rec_limit: pageSize });
    if (!rows.length) break;

    for (const r of rows) {
      const n = extractEmployeeIdNumber(r);
      if (n != null && n > maxNum) maxNum = n;
    }
    if (rows.length < pageSize) break;
  }
  return String(maxNum + 1 || 1);
}

async function getLastEmployeeIdFromZoho() {
  const accessToken = await getZohoAccessToken();
  const field = process.env.ZOHO_EMPLOYEEID_FIELD_LINK_NAME || 'Employee_ID';
  const url = `${ZOHO_PEOPLE_BASE}/people/api/forms/P_EmployeeView/records`;

  const res = await axios.get(url, {
    headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
    params: { page: 1, perPage: 1, sortColumn: field, sortOrder: 'desc' },
    validateStatus: () => true
  });

  const records =
    res?.data?.response?.result?.records ||
    res?.data?.response?.result ||
    res?.data?.records ||
    [];

  const rec = Array.isArray(records) ? records[0] : null;
  if (!rec) return null;

  const raw = String(rec[field] ?? rec['Employee_ID'] ?? '').trim();
  const m = raw.match(/\d+/);
  if (!m) return null;
  return parseInt(m[0], 10);
}

module.exports = {
  officialEmailFromUpn,
  updateCandidateOfficialEmail,
  fetchEmployeeByEmailAlias,
  getLastEmployeeIdFromZoho,
  extractEmployeeIdNumber,
  updateCandidateFields,
  getZohoAccessToken
};
