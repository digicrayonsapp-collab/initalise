'use strict';

const axios = require('axios');
const { getKV, setKV } = require('../infra/sqlite');
const { log } = require('../core/logger');

const KV_KEY = 'last_employee_id';

async function getMaxEmployeeIdFromGraph(token) {
  let url = 'https://graph.microsoft.com/v1.0/users?$select=employeeId&$top=999';
  let maxNum = 0;
  while (url) {
    const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
    const users = res.data?.value || [];
    for (const u of users) {
      const raw = (u.employeeId ?? '').toString().trim();
      if (!raw) continue;
      const m = raw.match(/\d+/);
      if (!m) continue;
      const n = parseInt(m[0], 10);
      if (Number.isFinite(n) && n > maxNum) maxNum = n;
    }
    url = res.data?.['@odata.nextLink'] || null;
  }
  return maxNum || null;
}

async function getNextEmployeeIdSmart({ email, graphToken, strictZoho = false }) {
  try {
    const { fetchEmployeeByEmailAlias, extractEmployeeIdNumber } = require('./zohoPeople');
    if (email) {
      const row = await fetchEmployeeByEmailAlias({ email });
      const last = extractEmployeeIdNumber(row);
      if (Number.isFinite(last)) {
        const next = String(last + 1);
        setKV(KV_KEY, next);
        log.info({ last, next }, '[empid] source=zoho');
        return next;
      }
    }
  } catch (e) {
    if (strictZoho) throw e;
  }

  const cached = getKV(KV_KEY);
  if (cached != null) {
    const base = parseInt(String(cached), 10);
    if (Number.isFinite(base)) {
      const next = String(base + 1);
      setKV(KV_KEY, next);
      log.warn({ base, next }, '[empid] source=cache');
      return next;
    }
  }

  if (graphToken) {
    const maxGraph = await getMaxEmployeeIdFromGraph(graphToken);
    if (Number.isFinite(maxGraph)) {
      const next = String(maxGraph + 1);
      setKV(KV_KEY, next);
      log.warn({ maxGraph, next }, '[empid] source=graph');
      return next;
    }
  }

  setKV(KV_KEY, '1');
  log.warn({}, '[empid] source=default');
  return '1';
}

module.exports = { getNextEmployeeIdSmart };
