'use strict';

const express = require('express');
const router = express.Router();

const { log } = require('../core/logger');
const { upsertJob, markJob, findActiveJobByCandidate, findLatestJobByCandidate, getKV } = require('../infra/sqlite');

const { getInt, get } = require('../config/env');
const { DateTime } = require('luxon');

const { getAzureAccessToken } = require('../services/graphAuth');
const {
  findByEmployeeId,
  findByEmail,
  findUserByUPN,
  getUser,
  revokeUserSessions,
  getDeletedUser,
  updateUser
} = require('../services/graphUser');

const { updateCandidateOfficialEmail } = require('../services/zohoPeople');

// optional: if you added a bus/mailer, we will emit safely without breaking anything
let bus = null;
try { ({ bus } = require('../core/bus')); } catch (_) { /* noop if not present */ }
const emitSafe = (event, payload) => { try { if (bus && bus.emit) bus.emit(event, payload); } catch (_) {} };

// axios is only used for Graph endpoints not covered by your services
const axios = require('axios');
const AXIOS_TIMEOUT_MS = 15000;

/* ---------- helpers ---------- */

const tz = process.env.TZ || 'Asia/Kolkata';

function toInt(v, d = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}

function clamp(n, min, max) {
  return Math.min(Math.max(n, min), max);
}

// dd-LL-yyyy -> DateTime in given TZ (IST by default)
function parseJoinDateIST(s, zone = tz) {
  if (!s) return null;
  const dt = DateTime.fromFormat(String(s).trim(), 'dd-LL-yyyy', { zone });
  return dt.isValid ? dt : null;
}

function prefixForEmployeeType(t) {
  if (!t) return '';
  const s = String(t).toLowerCase();
  if (s.includes('contractor')) return 'c-';
  if (s.includes('intern')) return 'i-';
  return '';
}

function normNickname(first, last) {
  return `${String(first || '').toLowerCase()}.${String(last || '').toLowerCase()}`
    .replace(/[^a-z0-9.]/g, '');
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '') {
      return obj[k];
    }
  }
  return undefined;
}

/* ---------- constants ---------- */

const OFF_H = clamp(getInt('OFFBOARD_EXEC_HOUR', 14), 0, 23);
const OFF_M = clamp(getInt('OFFBOARD_EXEC_MIN', 20), 0, 59);
log.info(`Offboard exec time (IST) -> ${String(OFF_H).padStart(2, '0')}:${String(OFF_M).padStart(2, '0')}`);

/* ---------- routes ---------- */

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

/**
 * Prehire scheduling webhook
 * Enqueues createFromCandidate job, handles cooldown and optional provisional Zoho email update.
 */
router.post('/zoho-candidate/edit', async (req, res) => {
  const startedAt = new Date().toISOString();
  log.info('➡️  HIT /api/zoho-candidate/edit', { ts: startedAt, ip: req.ip, ua: req.get('user-agent') });

  try {
    const data = (req.body && Object.keys(req.body).length) ? req.body : req.query;
    const { id, firstname, lastname, email, employeeId, joiningdate, employeeType } = data;

    log.info('🧾 [prehire] Candidate payload', {
      id, firstname: !!firstname, lastname: !!lastname, joiningdate, email: !!email, employeeId: !!employeeId, employeeType
    });

    if (!id || !firstname || !lastname) {
      return res.status(400).json({
        message: 'Missing firstname, lastname, or candidate ID',
        receivedKeys: Object.keys(data || {})
      });
    }

    // Cooldown to suppress echo webhooks right after a success
    const cooldownMin = toInt(process.env.PREHIRE_COOLDOWN_MINUTES, 3);
    const untilStr = getKV(`CANDIDATE_COOLDOWN_UNTIL:${id}`);
    const until = untilStr ? Number(untilStr) : 0;
    if (until && Date.now() < until) {
      const msLeft = until - Date.now();
      log.warn('🛑 [prehire] Cooldown active; suppressing schedule', { candidateId: id, msLeft });
      return res.json({ message: 'cooldown_active', candidateId: id, retryAfterMs: msLeft });
    }

    const execHour = toInt(process.env.PREHIRE_EXEC_HOUR, 14);
    const execMin = toInt(process.env.PREHIRE_EXEC_MIN, 45);
    const quickMins = toInt(process.env.POSTJOIN_OFFSET_MINUTES, 2);
    const prehireDays = toInt(process.env.PREHIRE_OFFSET_DAYS, 5);

    const joinDtIST = parseJoinDateIST(joiningdate, tz);

    let runAtDate;
    let reason;
    const nowIST = DateTime.now().setZone(tz);

    if (joinDtIST) {
      const prehireIST = joinDtIST.minus({ days: prehireDays })
        .set({ hour: execHour, minute: execMin, second: 0, millisecond: 0 });
      if (prehireIST > nowIST) {
        runAtDate = new Date(prehireIST.toUTC().toMillis());
        reason = `prehire-${prehireDays}d`;
      } else {
        runAtDate = new Date(nowIST.plus({ minutes: quickMins }).toUTC().toMillis());
        reason = 'prehire-in-past->quick';
      }
    } else {
      runAtDate = new Date(nowIST.plus({ minutes: quickMins }).toUTC().toMillis());
      reason = 'no-join->quick';
    }

    const runAt = runAtDate.getTime();
    const execAtISTLabel = DateTime.fromMillis(runAt).setZone(tz).toFormat('HH:mm');

    log.info('🗓️ [prehire] Schedule decision', {
      computedFrom: reason,
      prehireDays,
      joinDateIST: joinDtIST ? joinDtIST.toISODate() : null,
      execAtIST: execAtISTLabel,
      runAtUTC: new Date(runAt).toISOString()
    });

    // De-dupe: suppress if a near-identical job is already queued
    const existing = findActiveJobByCandidate('createFromCandidate', id);
    if (existing) {
      const toleranceMs = 60 * 1000;
      if (Math.abs(existing.runAt - runAt) > toleranceMs) {
        markJob(existing.id, {
          status: 'cancelled',
          lastError: 'superseded by new schedule',
          result: { supersededBy: { runAt } }
        });
        log.info('🔁 [prehire] Superseding old job', {
          oldJobId: existing.id,
          oldRunAtUTC: new Date(existing.runAt).toISOString(),
          newRunAtUTC: new Date(runAt).toISOString()
        });
      } else {
        const runAtIstExisting = DateTime.fromMillis(existing.runAt).setZone(tz).toFormat('dd-LL-yyyy HH:mm:ss ZZZZ');
        log.info('⏩ [prehire] Duplicate call suppressed: job already active', {
          jobId: existing.id, status: existing.status, runAtUTC: new Date(existing.runAt).toISOString(), runAtIST: runAtIstExisting
        });
        return res.json({
          message: 'already_scheduled',
          jobId: existing.id,
          status: existing.status,
          runAtUTC: new Date(existing.runAt).toISOString(),
          runAtIST: runAtIstExisting
        });
      }
    }

    const jobId = upsertJob({
      type: 'createFromCandidate',
      runAt,
      payload: {
        candidateId: id,
        firstname,
        lastname,
        email,
        employeeId,                 // optional seed
        joiningdate: joiningdate || null,
        offsetDays: prehireDays,
        domain: get('AZURE_DEFAULT_DOMAIN'),
        employeeType,
        employementType: employeeType  // legacy key retained
      }
    });

    log.info('📬 [prehire] Enqueued createFromCandidate', {
      jobId,
      runAtUTC: new Date(runAt).toISOString(),
      execAtIST: execAtISTLabel,
      joinDateIST: joinDtIST ? joinDtIST.toISODate() : null,
      prehireDays
    });

    // Optional provisional Zoho update
    if (String(process.env.ZP_PROVISIONAL_UPDATE || 'false').toLowerCase() === 'true') {
      try {
        const domain = (process.env.OFFICIAL_EMAIL_DOMAIN || get('AZURE_DEFAULT_DOMAIN') || '').trim();
        if (!domain) throw new Error('no domain configured');
        const local = normNickname(firstname, lastname);
        const pref = prefixForEmployeeType(employeeType);
        const provisional = `${pref}${local}@${domain}`;
        await updateCandidateOfficialEmail({ recordId: id, officialEmail: provisional });
        log.info('✅ [prehire] Provisional Official Email set in Zoho', { provisional });
        emitSafe('sync:success', { action: 'prehire-provisional-email', employee_id: id, upn: provisional });
      } catch (zerr) {
        const details = zerr?.response?.data || zerr?.message || String(zerr);
        log.warn('⚠️ [prehire] Provisional Zoho update skipped/failed', { details });
        emitSafe('sync:failure', { action: 'prehire-provisional-email', employee_id: id, error: details });
      }
    } else {
      log.info('⏭️  [prehire] Skipping provisional Zoho update (ZP_PROVISIONAL_UPDATE!=true)');
    }

    return res.json({
      message: 'scheduled',
      jobId,
      runAt: new Date(runAt).toISOString(),
      computedFrom: reason,
      joinDateIST: joinDtIST ? joinDtIST.toISODate() : null,
      execAtIST: execAtISTLabel,
      prehireDays,
      quickFallbackMinutes: reason.includes('quick') ? quickMins : null
    });
  } catch (error) {
    const details = error?.response?.data || error?.message || String(error);
    log.error('❌ [prehire] Error processing Zoho webhook', { details });
    emitSafe('sync:failure', { action: 'prehire-schedule', error: details });
    return res.status(500).json({ message: 'Failed to process webhook', error: details });
  }
});

/**
 * Update webhook
 * Patches Azure user fields, and optionally sets manager by employeeId.
 */
router.post('/zoho-webhook/edit', async (req, res) => {
  const startedAt = new Date().toISOString();
  log.info('➡️  HIT /api/zoho-webhook/edit', { ts: startedAt, ip: req.ip, ua: req.get('user-agent') });

  try {
    const data = (req.body && Object.keys(req.body).length) ? req.body : req.query;
    log.info('🧾 Raw payload keys', { keys: Object.keys(data || {}) });

    const upn =
      data.userPrincipalName ||
      data.upn ||
      data.Other_Email ||
      data['Other Email'] ||
      data.otherEmail;

    const { email, employeeId, manager } = data;
    log.info('🔍 Identifiers received', { upn, email, employeeId, hasManager: !!manager });

    const {
      firstname,
      lastname,
      city,
      country,
      mobilePhone,
      department,
      zohoRole,
      company,
      employementType,
      officelocation,
      joiningdate
    } = data;

    // Token
    log.info('🔑 Fetching Azure token…');
    const token = await getAzureAccessToken();
    log.info('✅ Azure token OK');

    // Resolve user by UPN -> email -> employeeId
    let user = null;
    let lookedUpBy = null;

    if (upn) {
      try {
        log.info('🔎 Lookup by UPN', { upn });
        user = await findUserByUPN(token, String(upn).trim());
        if (user) lookedUpBy = `UPN:${upn}`;
      } catch (e) {
        log.warn('⚠️ Lookup by UPN failed', { details: e?.message || String(e) });
      }
    }

    if (!user && email) {
      try {
        log.info('🔎 Lookup by email', { email });
        user = await findByEmail(token, String(email).trim());
        if (user) lookedUpBy = `email:${email}`;
      } catch (e) {
        log.warn('⚠️ Lookup by email failed', { details: e?.message || String(e) });
      }
    }

    if (!user && employeeId) {
      try {
        log.info('🔎 Lookup by employeeId', { employeeId });
        user = await findByEmployeeId(token, String(employeeId).trim());
        if (user) lookedUpBy = `employeeId:${employeeId}`;
      } catch (e) {
        log.warn('⚠️ Lookup by employeeId failed', { details: e?.message || String(e) });
      }
    }

    if (!user) {
      log.warn('⚠️ No Azure user found with provided identifiers');
      return res.status(404).json({
        message: 'Azure user not found. Provide one of: userPrincipalName/upn/Other_Email or email or employeeId.',
        tried: { upn: upn || null, email: email || null, employeeId: employeeId || null }
      });
    }

    // Build patch (keep fields same as your current behavior)
    const patch = {
      displayName: (firstname || lastname)
        ? `${firstname || user.givenName || ''} ${lastname || user.surname || ''}`.trim()
        : undefined,
      givenName: firstname || undefined,
      surname: lastname || undefined,
      mail: email || undefined,                // note: Graph may treat mail as read-only; kept to preserve behavior
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

    // joiningdate -> employeeHireDate (ISO)
    if (joiningdate) {
      try {
        const [dd, mm, yyyy] = String(joiningdate).split('-');
        const dt = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
        if (!isNaN(dt.getTime())) {
          patch.employeeHireDate = dt.toISOString().replace(/\.\d{3}Z$/, 'Z');
        }
      } catch (e) {
        log.warn('⚠️ Failed to parse joiningdate -> employeeHireDate', { details: e?.message || String(e) });
      }
    }

    // Manager handling (robust)
    if (manager && typeof manager === 'string') {
      try {
        const parts = manager.trim().split(/\s+/);
        const managerCode = parts[parts.length - 1]; // your existing convention
        if (managerCode) {
          const managerUser = await findByEmployeeId(token, managerCode);
          if (managerUser && managerUser.id) {
            log.info('📡 Updating manager', { userId: user.id, managerId: managerUser.id });
            await axios.put(
              `https://graph.microsoft.com/v1.0/users/${user.id}/manager/$ref`,
              { '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${managerUser.id}` },
              {
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                timeout: AXIOS_TIMEOUT_MS
              }
            );
            log.info('✅ Manager updated');
          } else {
            log.warn('❌ Manager not found in Azure by employeeId', { managerCode });
          }
        }
      } catch (e) {
        log.warn('⚠️ Manager update failed', { details: e?.response?.data || e?.message || String(e) });
      }
    }

    // Clean undefined keys
    Object.keys(patch).forEach(k => patch[k] === undefined && delete patch[k]);
    log.info('🛠️ Patch keys to apply', { keys: Object.keys(patch) });

    if (Object.keys(patch).length === 0) {
      log.info('ℹ️ Nothing to update; no valid fields in payload');
      return res.json({
        message: 'Nothing to update; no valid fields provided',
        userId: user.id,
        upn: user.userPrincipalName,
        lookedUpBy
      });
    }

    log.info('📡 Sending PATCH to Microsoft Graph', { userId: user.id });
    await updateUser(token, user.id, patch);
    log.info('✅ Azure user updated', { userId: user.id, lookedUpBy });
    emitSafe('sync:success', { action: 'user-update', upn: user.userPrincipalName, employee_id: user.employeeId, details: { keys: Object.keys(patch) } });

    return res.json({
      message: 'Azure user updated',
      userId: user.id,
      upn: user.userPrincipalName,
      lookedUpBy,
      updatedFields: Object.keys(patch),
      handledAt: new Date().toISOString()
    });
  } catch (err) {
    const details = err?.response?.data || err?.message || String(err);
    log.error('❌ /api/zoho-webhook/edit failed', { details });
    emitSafe('sync:failure', { action: 'user-update', error: details });
    return res.status(500).json({ message: 'Failed to update Azure user', details });
  }
});

/**
 * Offboarding webhook
 * Either immediate disable+cleanup, or schedules a disable job at configured H:M on exit date.
 */
router.post('/zoho-webhook/delete', async (req, res) => {
  const startedAt = new Date().toISOString();
  log.info('➡️  HIT /api/zoho-webhook/delete', { ts: startedAt, ip: req.ip, ua: req.get('user-agent') });

  try {
    const data = (req.body && Object.keys(req.body).length) ? req.body : req.query;
    log.info('🧾 Raw payload keys', { keys: Object.keys(data || {}) });

    const employeeId = pick(data, ['employeeId', 'EmployeeID', 'EmpID', 'Emp Id', 'empId']);
    const email = pick(data, ['email', 'mail', 'Email']);
    const upn = pick(data, ['userPrincipalName', 'upn', 'Other_Email', 'Other Email', 'otherEmail']);

    // Zoho commonly sends "dateOFExit"
    const exitDateRaw = pick(data, ['dateOFExit', 'dateOfExit', 'Date_of_Exit', 'Date of Exit', 'dateofexit', 'exitDate']);
    log.info('🔎 Identifiers for delete', { employeeId, haveEmail: !!email, haveUpn: !!upn, exitDateRaw });

    if (!employeeId) {
      log.warn('⚠️ employeeId is required for strict delete');
      return res.status(400).json({ message: 'employeeId is required' });
    }

    const exitDtIST = parseJoinDateIST(exitDateRaw, tz);
    const futureCandidate = exitDtIST
      ? new Date(exitDtIST.set({ hour: OFF_H, minute: OFF_M, second: 0, millisecond: 0 }).toUTC().toMillis())
      : null;

    // Immediate mode if no date or time already passed
    if (!futureCandidate || futureCandidate.getTime() <= Date.now()) {
      log.info('🟢 Immediate mode: disable now (no job)');

      const token = await getAzureAccessToken();

      let user = null;
      let foundBy = null;

      // Strict by employeeId; fallbacks must verify employeeId match
      try {
        user = await findByEmployeeId(token, String(employeeId).trim());
        if (user) foundBy = 'employeeId';
      } catch (e) {
        log.warn('⚠️ Lookup by employeeId failed', { details: e?.message || String(e) });
      }

      if (!user && email) {
        try {
          const byEmail = await findByEmail(token, String(email).trim());
          if (byEmail && String(byEmail.employeeId ?? '').trim() === String(employeeId).trim()) {
            user = byEmail; foundBy = 'email+eid';
            log.info('✅ Email matched and employeeId verified');
          }
        } catch (e) {
          log.warn('⚠️ Lookup by email failed', { details: e?.message || String(e) });
        }
      }

      if (!user && upn) {
        try {
          const byUpn = await findUserByUPN(token, String(upn).trim());
          if (byUpn && String(byUpn.employeeId ?? '').trim() === String(employeeId).trim()) {
            user = byUpn; foundBy = 'upn+eid';
            log.info('✅ UPN matched and employeeId verified');
          }
        } catch (e) {
          log.warn('⚠️ Lookup by UPN failed', { details: e?.message || String(e) });
        }
      }

      if (!user) {
        log.warn('⚠️ Azure user not found with matching employeeId');
        return res.status(404).json({ message: 'Azure user not found with matching employeeId', employeeId });
      }

      const azureEmpId = String(user.employeeId ?? '').trim();
      if (foundBy !== 'employeeId' && azureEmpId !== String(employeeId).trim()) {
        log.warn('⚠️ employeeId mismatch', { azureEmpId, zohoEmployeeId: String(employeeId).trim() });
        return res.status(409).json({ message: 'employeeId mismatch', azureEmpId, zohoEmployeeId: String(employeeId).trim() });
      }

      // Disable, remove groups, remove manager, revoke sessions (best-effort)
      try {
        // revoke sessions
        try {
          log.info('[disable-now] Revoking sign-in sessions', { userId: user.id });
          await revokeUserSessions(token, user.id);
          log.info('[disable-now] Sessions revoked');
        } catch (e) {
          log.warn('[disable-now] revokeSignInSessions failed', { details: e?.response?.data || e?.message || String(e) });
        }

        // disable account
        log.info('[disable-now] Disabling account', { userId: user.id, upn: user.userPrincipalName });
        await updateUser(token, user.id, { accountEnabled: false });
        log.info('[disable-now] Account disabled');

        // remove group memberships
        try {
          log.info('[disable-now] Fetching group memberships', { userId: user.id });
          const groupsRes = await axios.get(
            `https://graph.microsoft.com/v1.0/users/${user.id}/memberOf?$select=id`,
            { headers: { Authorization: `Bearer ${token}` }, timeout: AXIOS_TIMEOUT_MS }
          );
          const groups = (groupsRes.data && groupsRes.data.value) || [];
          if (!groups.length) {
            log.info('[disable-now] No group memberships found');
          } else {
            for (const g of groups) {
              try {
                log.info('[disable-now] Removing from group', { groupId: g.id });
                await axios.delete(
                  `https://graph.microsoft.com/v1.0/groups/${g.id}/members/${user.id}/$ref`,
                  { headers: { Authorization: `Bearer ${token}` }, timeout: AXIOS_TIMEOUT_MS }
                );
              } catch (err) {
                log.warn('[disable-now] Failed removing from group', { groupId: g.id, details: err?.response?.data || err?.message || String(err) });
              }
            }
            log.info('[disable-now] Group memberships removed');
          }
        } catch (e) {
          log.warn('[disable-now] Fetch/remove groups failed', { details: e?.response?.data || e?.message || String(e) });
        }

        // remove manager
        try {
          log.info('[disable-now] Removing manager', { userId: user.id });
          await axios.delete(
            `https://graph.microsoft.com/v1.0/users/${user.id}/manager/$ref`,
            { headers: { Authorization: `Bearer ${token}` }, timeout: AXIOS_TIMEOUT_MS }
          );
          log.info('[disable-now] Manager removed');
        } catch (e) {
          log.warn('[disable-now] Remove manager failed', { details: e?.response?.data || e?.message || String(e) });
        }

      } catch (e) {
        const details = e?.response?.data || e?.message || String(e);
        log.error('[disable-now] Failure during disable/cleanup', { details });
        emitSafe('sync:failure', { action: 'user-disable', upn: user.userPrincipalName, employee_id: azureEmpId, error: details });
        return res.status(e?.response?.status || 502).json({ message: 'Disable failed', details });
      }

      // Verify
      try {
        await getUser(token, user.id, 'id');
        log.warn('[disable-now] Verification: user still resolvable (not fatal)');
      } catch (e) {
        if (e?.response?.status === 404) log.info('[disable-now] Verification: user not resolvable (404 expected post-delete)');
        else log.warn('[disable-now] Verify read failed', { details: e?.response?.data || e?.message || String(e) });
      }

      try {
        const inBin = await getDeletedUser(token, user.id);
        log.info('[disable-now] Deleted Items check', { present: !!inBin });
      } catch (e) {
        log.warn('[disable-now] Deleted Items check failed', { details: e?.response?.data || e?.message || String(e) });
      }

      emitSafe('sync:success', { action: 'user-disable', upn: user.userPrincipalName, employee_id: azureEmpId });
      return res.json({
        message: 'deleted',
        userId: user.id,
        upn: user.userPrincipalName,
        employeeId: azureEmpId || String(employeeId).trim(),
        mode: 'immediate'
      });
    }

    // Scheduled disable
    const runAt = futureCandidate.getTime();
    upsertJob({
      type: 'disableUser',
      runAt,
      payload: { employeeId: String(employeeId).trim(), email: email || null, upn: upn || null }
    });
    log.info('📬 Enqueued disableUser', { runAtUTC: futureCandidate.toISOString() });

    return res.json({
      message: 'scheduled',
      runAt: futureCandidate.toISOString(),
      exitDateIST: exitDtIST ? exitDtIST.toISODate() : null,
      execAtIST: `${String(OFF_H).padStart(2, '0')}:${String(OFF_M).padStart(2, '0')}`,
      mode: 'scheduled'
    });
  } catch (e) {
    const details = e?.response?.data || e?.message || String(e);
    log.error('❌ /zoho-webhook/delete failed', { details });
    emitSafe('sync:failure', { action: 'user-delete', error: details });
    return res.status(500).json({ message: 'Internal Server Error', details });
  }
});

/**
 * Employment type change webhook
 * Adds an alias to otherMails based on the type (i- or c- prefixing UPN, or strip prefix).
 */
router.post('/employee-type/edit', async (req, res) => {
  const ts = new Date().toISOString();
  log.info('➡️  HIT /api/employee-type/edit', { ts, ip: req.ip, ua: req.get('user-agent') });

  try {
    const payload = (req.body && Object.keys(req.body).length) ? req.body : req.query;
    const employeeId = payload.employeeId;
    const type = payload.type;

    log.info('📩 Employment type edit received', { employeeId, type });

    if (!employeeId || !type) {
      return res.status(400).json({ message: 'employeeId and type are required' });
    }

    const token = await getAzureAccessToken();

    log.info('🔎 Lookup user by employeeId', { employeeId });
    const user = await findByEmployeeId(token, employeeId);
    if (!user) {
      log.warn('⚠️ No Azure user found for given employeeId');
      return res.status(404).json({ message: 'User not found in Azure' });
    }

    const upn = user.userPrincipalName || '';
    let aliasEmail = null;

    if (type === 'Regular Full-Time') {
      aliasEmail = upn.replace(/^(i-|c-)/, '');
    } else if (type === 'Intern Full-Time') {
      aliasEmail = upn.startsWith('i-') ? null : `i-${upn.replace(/^(i-|c-)/, '')}`;
    } else if (type === 'Contractor Full-Time') {
      aliasEmail = upn.startsWith('c-') ? null : `c-${upn.replace(/^(i-|c-)/, '')}`;
    }

    if (!aliasEmail) {
      log.info('ℹ️ No alias change needed');
      return res.json({ message: 'No change needed' });
    }

    const currentAliases = Array.isArray(user.otherMails) ? user.otherMails : [];
    if (currentAliases.includes(aliasEmail)) {
      log.info('ℹ️ Alias already present', { aliasEmail });
      return res.json({ message: 'Alias already present', employeeId, aliasEmail });
    }

    const patch = { otherMails: [...currentAliases, aliasEmail] };
    log.info('📡 Patching otherMails', { userId: user.id, aliasEmail });
    await updateUser(token, user.id, patch);

    emitSafe('sync:success', { action: 'alias-add', upn, employee_id: employeeId, details: { alias: aliasEmail } });

    return res.json({ message: 'Alias email added', employeeId, aliasEmail });
  } catch (e) {
    const details = e?.response?.data || e?.message || String(e);
    log.error('❌ /employee-type/edit failed', { details });
    emitSafe('sync:failure', { action: 'alias-add', error: details });
    return res.status(500).json({ message: 'Internal Server Error', details });
  }
});

module.exports = router;
