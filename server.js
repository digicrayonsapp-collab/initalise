'use strict';

require('dotenv').config();

const express = require('express');
const axios = require('axios');
const qs = require('qs');

const app = express();
const PORT = Number(process.env.PORT || 3008);

/* ----------------------------- infrastructure ------------------------------ */

const { initBus, bus } = (() => {
  try { return require('./src/core/bus'); } catch (_) { return { initBus: () => { }, bus: null }; }
})();
const { upsertJob } = (() => {
  try { return require('./src/infra/sqlite'); } catch (_) { return { upsertJob: () => Date.now() }; }
})();
const { get, getInt } = (() => {
  try { return require('./config/env'); } catch (_) { return { get: (k, d) => process.env[k] ?? d, getInt: (k, d) => { const n = parseInt(process.env[k], 10); return Number.isFinite(n) ? n : d; } }; }
})();

// optional mailer; if absent, emailing no-ops safely
let sendMail = null;
try { ({ sendMail } = require('./src/infra/email')); } catch (_) { /* no mailer present */ }

const EMAIL_MODE = (get('EMAIL_MODE', 'event') || 'event').toLowerCase();
const EMAIL_SUBJECT_PREFIX = get('EMAIL_SUBJECT_PREFIX', '[Zoho-Azure Sync]');
const TO_SUCCESS = (get('EMAIL_TO_SUCCESS', '') || '').trim();
const TO_FAILURE = (get('EMAIL_TO_FAILURE', '') || '').trim();

const mailEnabled = !!sendMail && EMAIL_MODE !== 'off';
function escapeHtml(s) {
  return String(s).replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
async function mailSuccess(subject, body) {
  if (!mailEnabled || (EMAIL_MODE !== 'event' && EMAIL_MODE !== 'both') || !TO_SUCCESS) return;
  try {
    await sendMail({
      to: TO_SUCCESS,
      subject: `${EMAIL_SUBJECT_PREFIX} ${subject}`.trim(),
      text: body,
      html: `<pre>${escapeHtml(body)}</pre>`
    });
  } catch (e) { console.warn('[MAIL] success email failed:', e && (e.message || String(e))); }
}
async function mailFailure(subject, body) {
  if (!mailEnabled || (EMAIL_MODE !== 'event' && EMAIL_MODE !== 'both') || !TO_FAILURE) return;
  try {
    await sendMail({
      to: TO_FAILURE,
      subject: `${EMAIL_SUBJECT_PREFIX} ${subject}`.trim(),
      text: body,
      html: `<pre>${escapeHtml(body)}</pre>`
    });
  } catch (e) { console.warn('[MAIL] failure email failed:', e && (e.message || String(e))); }
}

function emitSafe(event, payload) {
  try { if (bus && bus.emit) bus.emit(event, payload); } catch (_) { }
}

/* --------------------------------- express --------------------------------- */

app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true, limit: '256kb' }));

// event bus boot (if present)
initBus();

/* --------------------------------- helpers --------------------------------- */

const { DateTime } = (() => { try { return require('luxon'); } catch (_) { return { DateTime: null }; } })();

function toInt(v, d = 0) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
function clamp(n, min, max) { return Math.min(Math.max(n, min), max); }
const TZ = process.env.TZ || 'Asia/Kolkata';

function parseJoinDateIST(s, zone = TZ) {
  if (!s || !DateTime) return null;
  const dt = DateTime.fromFormat(String(s).trim(), 'dd-LL-yyyy', { zone });
  return dt.isValid ? dt : null;
}

function _normKey(s) { return String(s).toLowerCase().replace(/[^a-z0-9]/g, ''); }
function pickWithKey(obj, aliases = []) {
  if (!obj) return { value: undefined, matchedKey: null };
  const lut = {};
  for (const [k, v] of Object.entries(obj)) lut[_normKey(k)] = { v, k };
  for (const a of aliases) {
    const hit = lut[_normKey(a)];
    if (hit && hit.v !== undefined && hit.v !== null && String(hit.v).trim() !== '') {
      return { value: hit.v, matchedKey: hit.k };
    }
  }
  return { value: undefined, matchedKey: null };
}

function normNickname(first, last) {
  return `${String(first || '').toLowerCase()}.${String(last || '').toLowerCase()}`
    .replace(/[^a-z0-9.]/g, '');
}
function prefixForEmployeeType(t) {
  if (!t) return '';
  const s = String(t).toLowerCase();
  if (s.includes('contractor')) return 'c-';
  if (s.includes('intern')) return 'i-';
  return '';
}
function odataQuote(str) {
  // escape single-quotes per OData by doubling them
  return String(str).replace(/'/g, "''");
}

/* ---------------------------- tokens & clients ----------------------------- */

const ZOHO_CLIENT_ID = process.env.ZOHO_CLIENT_ID || '';
const ZOHO_CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET || '';
const ZOHO_REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN || '';
const ZOHO_DC = (process.env.ZOHO_DC || 'com').trim(); // com | in | eu ...

const AZURE_CLIENT_ID = process.env.AZURE_CLIENT_ID || '';
const AZURE_CLIENT_SECRET = process.env.AZURE_CLIENT_SECRET || '';
const AZURE_TENANT_ID = process.env.AZURE_TENANT_ID || '';

axios.defaults.timeout = 15000; // global default timeout

async function getZohoAccessToken() {
  const tokenUrl = `https://accounts.zoho.${ZOHO_DC}/oauth/v2/token`;
  const formData = qs.stringify({
    refresh_token: ZOHO_REFRESH_TOKEN,
    client_id: ZOHO_CLIENT_ID,
    client_secret: ZOHO_CLIENT_SECRET,
    grant_type: 'refresh_token'
  });
  const res = await axios.post(tokenUrl, formData, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 15000
  });
  return res.data.access_token;
}

async function getAzureAccessToken() {
  try {
    const res = await axios.post(
      `https://login.microsoftonline.com/${AZURE_TENANT_ID}/oauth2/v2.0/token`,
      qs.stringify({
        client_id: AZURE_CLIENT_ID,
        client_secret: AZURE_CLIENT_SECRET,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials'
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
    );
    console.log('[AUTH] Azure access token refreshed');
    return res.data.access_token;
  } catch (err) {
    const details = err?.response?.data || err?.message || String(err);
    console.error('[AUTH] Azure token refresh failed:', details);
    throw err;
  }
}

/* --------------------------------- routes ---------------------------------- */

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

/**
 * Prehire: compute provisional email based on employee type and update Zoho Candidate.Other_Email
 */
app.post('/zoho-candidate/edit', async (req, res) => {
  try {
    const data = (req.body && Object.keys(req.body).length) ? req.body : req.query;

    const { value: employeeType, matchedKey: employeeTypeKey } = pickWithKey(data, [
      'employeeType', 'employmentType', 'employementType', 'Employee_Type', 'Employee Type', 'EmployeeType', 'empType', 'typeOfEmployee'
    ]);

    const { id, firstname, lastname } = data;
    console.log('[PREHIRE] payload keys:', Object.keys(data));
    console.log('[PREHIRE] employeeType:', employeeType, '(key:', employeeTypeKey, ')');

    if (!id || !firstname || !lastname) {
      return res.status(400).json({ message: 'Missing firstname, lastname, or candidate ID', receivedKeys: Object.keys(data || {}) });
    }

    const domain = (process.env.OFFICIAL_EMAIL_DOMAIN || get('AZURE_DEFAULT_DOMAIN') || 'roundglass.com').trim();
    const local = normNickname(firstname, lastname);
    const pref = prefixForEmployeeType(employeeType);
    const officialEmail = `${pref}${local}@${domain}`;

    console.log('[PREHIRE] email decision:', { employeeType, prefix: pref || '(none)', local, domain, officialEmail });

    const formData = qs.stringify({
      recordId: id,
      inputData: JSON.stringify({ Other_Email: officialEmail })
    });

    const accessToken = await getZohoAccessToken();
    console.log('[PREHIRE] Zoho access token acquired');

    const zohoRes = await axios.post(
      `https://people.zoho.${ZOHO_DC}/api/forms/json/Candidate/updateRecord`,
      formData,
      { headers: { Authorization: `Zoho-oauthtoken ${accessToken}`, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
    );

    console.log('[PREHIRE] Zoho Candidate updated with official email');
    emitSafe('sync:success', { action: 'prehire-provisional-email', employee_id: id, upn: officialEmail });
    await mailSuccess('PREHIRE provisional email set', `candidateId=${id}\nemail=${officialEmail}`);

    return res.status(200).json({
      message: 'Official email generated and updated in Candidate record',
      officialEmail,
      employeeType,
      zohoResponse: zohoRes.data
    });
  } catch (error) {
    const details = error?.response?.data || error?.message || String(error);
    console.error('[PREHIRE] processing failed:', details);
    emitSafe('sync:failure', { action: 'prehire-provisional-email', error: details });
    await mailFailure('PREHIRE provisional email failed', String(details));
    return res.status(500).json({ message: 'Failed to process webhook', error: details });
  }
});

/**
 * Create user in Azure AD from Zoho webhook, ensuring unique UPN.
 */
app.post('/zoho-webhook/create', async (req, res) => {
  try {
    const data = (req.body && Object.keys(req.body).length) ? req.body : req.query;

    const {
      email, firstname, lastname, employeeId,
      city, manager, joiningdate, company, zohoRole,
      mobilePhone, employementType, workPhone, employeeStatus,
      country, department, officelocation
    } = data;

    console.log('[CREATE] payload keys:', Object.keys(data));

    if (!firstname || !lastname) {
      return res.status(400).json({ message: 'Missing firstname or lastname in webhook payload', receivedKeys: Object.keys(data || {}) });
    }

    const accessToken = await getAzureAccessToken();

    const safeNickname = `${firstname}.${lastname}`.toLowerCase().replace(/[^a-z0-9.]/g, '');
    const domain = (get('AZURE_DEFAULT_DOMAIN') || 'yadavhitesh340gmail.onmicrosoft.com').trim();

    // Unique UPN generation (check & increment)
    let userPrincipalName = `${safeNickname}@${domain}`;
    let counter = 1;

    while (true) {
      const filter = encodeURI(`$filter=userPrincipalName eq '${odataQuote(userPrincipalName)}'`);
      const check = await axios.get(`https://graph.microsoft.com/v1.0/users?${filter}`, {
        headers: { Authorization: `Bearer ${accessToken}` }, timeout: 15000
      });
      if (!check.data.value || check.data.value.length === 0) break;
      userPrincipalName = `${safeNickname}${counter}@${domain}`;
      counter++;
      if (counter > 50) throw new Error('exhausted upn attempts');
    }

    const tempPassword = get('GRAPH_TEMP_PASSWORD', 'TempPass123!');
    const azureUser = {
      accountEnabled: true,
      displayName: `${firstname} ${lastname}`.trim(),
      mailNickname: safeNickname,
      userPrincipalName,
      passwordProfile: { forceChangePasswordNextSignIn: true, password: tempPassword },
      mail: email || null,
      givenName: firstname || null,
      surname: lastname || null,
      employeeId: employeeId || null,
      country: country || null,
      city: city || null,
      mobilePhone: mobilePhone || null,
      department: department || null,
      jobTitle: zohoRole || null,
      companyName: company || null,
      employeeType: employementType || null,
      officeLocation: officelocation || null
    };

    const createRes = await axios.post('https://graph.microsoft.com/v1.0/users', azureUser, {
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, timeout: 20000
    });

    console.log('[CREATE] user created in Azure AD:', createRes.data && createRes.data.id);

    if (joiningdate) {
      try {
        const [dd, mm, yyyy] = String(joiningdate).split('-');
        const dt = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
        if (!isNaN(dt.getTime())) {
          const hireISO = dt.toISOString().replace(/\.\d{3}Z$/, 'Z');
          await axios.patch(
            `https://graph.microsoft.com/v1.0/users/${createRes.data.id}`,
            { employeeHireDate: hireISO },
            { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, timeout: 15000 }
          );
          console.log('[CREATE] employeeHireDate set:', hireISO);
        }
      } catch (e) {
        console.warn('[CREATE] failed to set employeeHireDate:', e && (e.message || String(e)));
      }
    }

    emitSafe('sync:success', { action: 'user-create', upn: userPrincipalName, employee_id: employeeId, details: { id: createRes.data.id } });
    await mailSuccess('CREATE user', `userId=${createRes.data.id}\nupn=${userPrincipalName}`);

    return res.status(200).json({ message: 'User successfully created in Azure AD', azureUser: createRes.data });
  } catch (error) {
    const details = error?.response?.data || error?.message || String(error);
    console.error('[CREATE] failed:', details);
    emitSafe('sync:failure', { action: 'user-create', error: details });
    await mailFailure('CREATE user failed', String(details));
    return res.status(500).json({ message: 'Failed to create user in Azure AD', error: details });
  }
});

/**
 * Offboarding: schedule disable at OFFBOARD_EXEC_HOUR:MIN IST on exit date, or soon if missing/past.
 */
app.post('/zoho-webhook/delete', (req, res) => {
  try {
    const data = (req.body && Object.keys(req.body).length) ? req.body : req.query;

    const upn =
      data.userPrincipalName ||
      data.upn ||
      data.Other_Email ||
      data['Other Email'] ||
      data.otherEmail;

    const { email, employeeId } = data;

    const exitDateRaw =
      data.dateOfExit ||
      data.Date_of_Exit ||
      data['Date of Exit'] ||
      data.dateofexit ||
      data.dateOFExit ||
      data.exitDate;

    const execH = clamp(getInt('OFFBOARD_EXEC_HOUR', 14), 0, 23);
    const execM = clamp(getInt('OFFBOARD_EXEC_MIN', 20), 0, 59);
    const quickMins = toInt(process.env.OFFBOARD_OFFSET_MINUTES, 1);

    const exitDtIST = parseJoinDateIST(exitDateRaw, TZ);

    let runAtDate;
    if (exitDtIST) {
      const targetIST = exitDtIST.set({ hour: execH, minute: execM, second: 0, millisecond: 0 });
      const candidate = new Date(targetIST.toUTC().toMillis());
      runAtDate = (candidate.getTime() <= Date.now()) ? new Date(Date.now() + quickMins * 60 * 1000) : candidate;
    } else {
      runAtDate = new Date(Date.now() + quickMins * 60 * 1000);
    }

    const runAt = runAtDate.getTime();

    const jobId = upsertJob({
      type: 'disableUser',
      runAt,
      payload: { upn: upn || null, email: email || null, employeeId: employeeId || null }
    });

    console.log('[OFFBOARD] disable scheduled', {
      jobId, runAtUTC: new Date(runAt).toISOString(), exitDateRaw, execAtIST: `${String(execH).padStart(2, '0')}:${String(execM).padStart(2, '0')}`
    });

    mailSuccess('OFFBOARD scheduled', `employeeId=${employeeId || ''}\nrunAtUTC=${new Date(runAt).toISOString()}`).catch(() => { });
    emitSafe('sync:success', { action: 'user-disable-scheduled', employee_id: employeeId, upn });

    return res.json({
      message: 'scheduled',
      jobId,
      runAt: new Date(runAt).toISOString(),
      computedFrom: exitDtIST ? 'exitDate-IST' : 'no-exitDate-immediate',
      exitDateIST: exitDtIST ? exitDtIST.toISODate() : null,
      execAtIST: `${String(execH).padStart(2, '0')}:${String(execM).padStart(2, '0')}`,
      quickFallbackMinutes: (!exitDtIST || runAtDate.getTime() <= Date.now()) ? quickMins : null
    });
  } catch (e) {
    console.error('[OFFBOARD] scheduling failed:', e && (e.stack || e.message || e));
    mailFailure('OFFBOARD scheduling failed', e && (e.message || String(e))).catch(() => { });
    return res.status(500).json({ message: 'Internal Server Error' });
  }
});

/**
 * Edit: patch Azure user by email/UPN/employeeId, set hire date if provided.
 */
app.post('/zoho-webhook/edit', async (req, res) => {
  try {
    const data = (req.body && Object.keys(req.body).length) ? req.body : req.query;

    const upn =
      data.userPrincipalName ||
      data.upn ||
      data.Other_Email ||
      data['Other Email'] ||
      data.otherEmail;

    const {
      email, firstname, lastname, employeeId, city, manager, joiningdate,
      company, zohoRole, mobilePhone, employementType, workPhone, employeeStatus,
      country, department, officelocation
    } = data;

    if (!email && !upn && !employeeId) {
      return res.status(400).json({ message: 'Provide one of: userPrincipalName/upn/Other_Email or email or employeeId.' });
    }

    const token = await getAzureAccessToken();

    // Try resolve by UPN -> email -> employeeId
    let user = null;
    if (upn) {
      try {
        const filter = encodeURI(`$filter=userPrincipalName eq '${odataQuote(upn)}'`);
        const r = await axios.get(`https://graph.microsoft.com/v1.0/users?${filter}`, { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
        user = r.data.value && r.data.value[0];
      } catch (e) { /* ignore, try next */ }
    }
    if (!user && email) {
      try {
        const filter = encodeURI(`$filter=mail eq '${odataQuote(email)}'`);
        const r = await axios.get(`https://graph.microsoft.com/v1.0/users?${filter}`, { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
        user = r.data.value && r.data.value[0];
      } catch (e) { /* ignore, try next */ }
    }
    if (!user && employeeId) {
      try {
        const filter = encodeURI(`$filter=employeeId eq '${odataQuote(employeeId)}'`);
        const r = await axios.get(`https://graph.microsoft.com/v1.0/users?${filter}`, { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 });
        user = r.data.value && r.data.value[0];
      } catch (e) { /* ignore */ }
    }

    if (!user) {
      await mailFailure('UPDATE failed: user not found', `upn=${upn || ''}\nemail=${email || ''}\nemployeeId=${employeeId || ''}`);
      return res.status(404).json({ message: 'Azure user not found. Provide one of: userPrincipalName/upn/Other_Email or email or employeeId.' });
    }

    const patch = {
      displayName: (firstname || lastname) ? `${firstname || user.givenName || ''} ${lastname || user.surname || ''}`.trim() : undefined,
      givenName: firstname || undefined,
      surname: lastname || undefined,
      mail: email || undefined,
      employeeId: employeeId || undefined,
      country: country || undefined,
      city: city || undefined,
      mobilePhone: mobilePhone || undefined,
      department: department || undefined,
      jobTitle: zohoRole || undefined,
      companyName: company || undefined,
      employeeType: employementType || undefined,
      officeLocation: officelocation || undefined
    };
    Object.keys(patch).forEach((k) => patch[k] === undefined && delete patch[k]);

    if (Object.keys(patch).length) {
      await axios.patch(
        `https://graph.microsoft.com/v1.0/users/${user.id}`,
        patch,
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 20000 }
      );
    }

    if (joiningdate) {
      try {
        const [dd, mm, yyyy] = String(joiningdate).split('-');
        const dt = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
        if (!isNaN(dt.getTime())) {
          const hireISO = dt.toISOString().replace(/\.\d{3}Z$/, 'Z');
          await axios.patch(
            `https://graph.microsoft.com/v1.0/users/${user.id}`,
            { employeeHireDate: hireISO },
            { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 }
          );
        }
      } catch (e) {
        console.warn('[UPDATE] failed to set employeeHireDate:', e && (e.message || String(e)));
      }
    }

    emitSafe('sync:success', { action: 'user-update', upn: user.userPrincipalName, employee_id: user.employeeId, details: { fields: Object.keys(patch) } });
    await mailSuccess('UPDATE applied', `userId=${user.id}\nupn=${user.userPrincipalName}\nfields=${Object.keys(patch).join(',') || '(none)'}`);

    return res.status(200).json({
      message: 'Azure user updated',
      userId: user.id,
      upn: user.userPrincipalName,
      updatedFields: Object.keys(patch)
    });
  } catch (error) {
    const details = error?.response?.data || error?.message || String(error);
    console.error('[UPDATE] failed:', details);
    emitSafe('sync:failure', { action: 'user-update', error: details });
    await mailFailure('UPDATE failed', String(details));
    return res.status(500).json({ message: 'Failed to update Azure user', error: details });
  }
});

/* --------------------------------- startup --------------------------------- */

process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err && (err.stack || err.message || err));
});
process.on('unhandledRejection', (err) => {
  console.error('[FATAL] unhandledRejection:', err && (err.stack || err.message || err));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[BOOT] server listening on http://0.0.0.0:${PORT}`);
});
