'use strict';

const express = require('express');
const router = express.Router();

const { log } = require('../core/logger');
const {
  upsertJob,
  markJob,
  findActiveJobByCandidate,
  getKV
} = require('../infra/sqlite');

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

const axios = require('axios');
const AXIOS_TIMEOUT_MS = 15000;

/* -------------------------- Optional Mailer Wire-up -------------------------- */
/* Your .env should include:
   EMAIL_MODE=event|summary|both|off
   EMAIL_SUBJECT_PREFIX=[Zoho-Azure Sync]
   EMAIL_TO_SUCCESS=ops@example.com
   EMAIL_TO_FAILURE=alerts@example.com
*/
let sendMail = null;
try {
  // expects module to export sendMail({ to, subject, text, html })
  ({ sendMail } = require('../infra/email'));
} catch (_) {
  /* Mailer not present; emails will be skipped gracefully */
}
const EMAIL_MODE = (get('EMAIL_MODE', 'event') || 'event').toLowerCase();
const EMAIL_SUBJECT_PREFIX = get('EMAIL_SUBJECT_PREFIX', '[Zoho-Azure Sync]');
const TO_SUCCESS = (get('EMAIL_TO_SUCCESS', '') || '').trim();
const TO_FAILURE = (get('EMAIL_TO_FAILURE', '') || '').trim();

const mailEnabled = !!sendMail && EMAIL_MODE !== 'off';
function escapeHtml(s) {
  return String(s).replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
async function mailSuccess(subject, body) {
  if (!mailEnabled || (EMAIL_MODE !== 'event' && EMAIL_MODE !== 'both')) return;
  if (!TO_SUCCESS) return;
  try {
    await sendMail({
      to: TO_SUCCESS,
      subject: `${EMAIL_SUBJECT_PREFIX} ${subject}`.trim(),
      text: body,
      html: `<pre>${escapeHtml(body)}</pre>`
    });
  } catch (e) {
    log.warn({ err: e && (e.message || String(e)) }, '[MAIL] success email failed');
  }
}
async function mailFailure(subject, body) {
  if (!mailEnabled || (EMAIL_MODE !== 'event' && EMAIL_MODE !== 'both')) return;
  if (!TO_FAILURE) return;
  try {
    await sendMail({
      to: TO_FAILURE,
      subject: `${EMAIL_SUBJECT_PREFIX} ${subject}`.trim(),
      text: body,
      html: `<pre>${escapeHtml(body)}</pre>`
    });
  } catch (e) {
    log.warn({ err: e && (e.message || String(e)) }, '[MAIL] failure email failed');
  }
}
/* --------------------------------------------------------------------------- */

/* ------------------------------ Local Helpers ------------------------------ */

const tz = process.env.TZ || 'Asia/Kolkata';

function toInt(v, d = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}
function clamp(n, min, max) { return Math.min(Math.max(n, min), max); }

// dd-LL-yyyy -> DateTime in TZ
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

/* ------------------------------- Configured H:M ------------------------------ */

const OFF_H = clamp(getInt('OFFBOARD_EXEC_HOUR', 14), 0, 23);
const OFF_M = clamp(getInt('OFFBOARD_EXEC_MIN', 20), 0, 59);
log.info({ offboardTimeIST: `${String(OFF_H).padStart(2, '0')}:${String(OFF_M).padStart(2, '0')}` }, '[BOOT] Offboard execution time');

/* --------------------------------- Routes ---------------------------------- */

router.get('/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

/**
 * Prehire scheduling webhook
 * - Debounces duplicate calls (cooldown)
 * - Schedules job pre-hire days before join date (or quick fallback)
 * - Optional provisional official email update in Zoho
 */
router.post('/zoho-candidate/edit', async (req, res) => {
  const ts = new Date().toISOString();
  log.info({ ts, ip: req.ip, ua: req.get('user-agent') }, '[PREHIRE] webhook hit');

  try {
    const data = (req.body && Object.keys(req.body).length) ? req.body : req.query;
    const { id, firstname, lastname, email, employeeId, joiningdate } = data;
    const employeeType = data.employeeType;

    log.info(
      {
        id,
        hasFirstname: !!firstname,
        hasLastname: !!lastname,
        hasEmail: !!email,
        employeeId: !!employeeId,
        joiningdate,
        employeeType
      },
      '[PREHIRE] candidate payload summary'
    );

    if (!id || !firstname || !lastname) {
      return res.status(400).json({
        message: 'Missing firstname, lastname, or candidate ID',
        receivedKeys: Object.keys(data || {})
      });
    }

    // Cooldown suppression
    const cooldownMin = toInt(process.env.PREHIRE_COOLDOWN_MINUTES, 3);
    const untilStr = getKV(`CANDIDATE_COOLDOWN_UNTIL:${id}`);
    const until = untilStr ? Number(untilStr) : 0;
    if (until && Date.now() < until) {
      const msLeft = until - Date.now();
      log.warn({ candidateId: id, msLeft }, '[PREHIRE] cooldown active; scheduling suppressed');
      return res.json({ message: 'cooldown_active', candidateId: id, retryAfterMs: msLeft });
    }

    const execHour = toInt(process.env.PREHIRE_EXEC_HOUR, 14);
    const execMin = toInt(process.env.PREHIRE_EXEC_MIN, 45);
    const quickMins = toInt(process.env.POSTJOIN_OFFSET_MINUTES, 2);
    const prehireDays = toInt(process.env.PREHIRE_OFFSET_DAYS, 5);

    const joinDtIST = parseJoinDateIST(joiningdate, tz);
    const nowIST = DateTime.now().setZone(tz);

    let runAtDate;
    let reason;

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

    log.info(
      {
        reason,
        prehireDays,
        joinDateIST: joinDtIST ? joinDtIST.toISODate() : null,
        execAtIST: execAtISTLabel,
        runAtUTC: new Date(runAt).toISOString()
      },
      '[PREHIRE] schedule decision'
    );

    // De-dupe active job
    const existing = findActiveJobByCandidate('createFromCandidate', id);
    if (existing) {
      const toleranceMs = 60 * 1000;
      if (Math.abs(existing.runAt - runAt) > toleranceMs) {
        markJob(existing.id, {
          status: 'cancelled',
          lastError: 'superseded by new schedule',
          result: { supersededBy: { runAt } }
        });
        log.info(
          {
            oldJobId: existing.id,
            oldRunAtUTC: new Date(existing.runAt).toISOString(),
            newRunAtUTC: new Date(runAt).toISOString()
          },
          '[PREHIRE] superseding existing job'
        );
      } else {
        const runAtIstExisting = DateTime.fromMillis(existing.runAt).setZone(tz).toFormat('dd-LL-yyyy HH:mm:ss ZZZZ');
        log.info(
          {
            jobId: existing.id,
            status: existing.status,
            runAtUTC: new Date(existing.runAt).toISOString(),
            runAtIST: runAtIstExisting
          },
          '[PREHIRE] duplicate suppressed: active job present'
        );
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
        employeeId,
        joiningdate: joiningdate || null,
        offsetDays: prehireDays,
        domain: get('AZURE_DEFAULT_DOMAIN'),
        employeeType,
        employementType: employeeType // legacy key retained
      }
    });

    log.info(
      {
        jobId,
        runAtUTC: new Date(runAt).toISOString(),
        execAtIST: execAtISTLabel,
        joinDateIST: joinDtIST ? joinDtIST.toISODate() : null,
        prehireDays
      },
      '[PREHIRE] job enqueued'
    );

    await mailSuccess('PREHIRE scheduled', `candidateId=${id}\nrunAtUTC=${new Date(runAt).toISOString()}\nreason=${reason}`);

    // Optional provisional Zoho update
    if (String(process.env.ZP_PROVISIONAL_UPDATE || 'false').toLowerCase() === 'true') {
      try {
        const domain = (process.env.OFFICIAL_EMAIL_DOMAIN || get('AZURE_DEFAULT_DOMAIN') || '').trim();
        if (!domain) throw new Error('no domain configured');
        const local = normNickname(firstname, lastname);
        const pref = prefixForEmployeeType(employeeType);
        const provisional = `${pref}${local}@${domain}`;
        await updateCandidateOfficialEmail({ recordId: id, officialEmail: provisional });
        log.info({ provisional }, '[PREHIRE] provisional official email set in Zoho');
        await mailSuccess('Zoho provisional email set', `candidateId=${id}\nemail=${provisional}`);
      } catch (zerr) {
        const details = zerr?.response?.data || zerr?.message || String(zerr);
        log.warn({ details }, '[PREHIRE] provisional Zoho update failed/skipped');
        await mailFailure('Zoho provisional email failed', `candidateId=${id}\nerror=${details}`);
      }
    } else {
      log.info({}, '[PREHIRE] provisional Zoho update disabled (ZP_PROVISIONAL_UPDATE!=true)');
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
    log.error({ details }, '[PREHIRE] processing failure');
    await mailFailure('PREHIRE scheduling failed', String(details));
    return res.status(500).json({ message: 'Failed to process webhook', error: details });
  }
});

/**
 * Update webhook
 * - Resolves user by UPN -> email -> employeeId
 * - Applies field patch
 * - Optionally sets manager via manager employee code (last token of "manager" string)
 */
router.post('/zoho-webhook/edit', async (req, res) => {
  const ts = new Date().toISOString();
  log.info({ ts, ip: req.ip, ua: req.get('user-agent') }, '[UPDATE] webhook hit');

  try {
    const data = (req.body && Object.keys(req.body).length) ? req.body : req.query;

    const upn =
      data.userPrincipalName ||
      data.upn ||
      data.Other_Email ||
      data['Other Email'] ||
      data.otherEmail;

    const { email, employeeId, manager } = data;

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

    log.info(
      { hasUpn: !!upn, hasEmail: !!email, employeeId: !!employeeId, hasManager: !!manager },
      '[UPDATE] identifiers summary'
    );

    const token = await getAzureAccessToken();

    // Resolve user
    let user = null;
    let lookedUpBy = null;

    if (upn) {
      try {
        user = await findUserByUPN(token, String(upn).trim());
        if (user) lookedUpBy = `UPN:${upn}`;
      } catch (e) { log.warn({ err: e && (e.message || String(e)) }, '[UPDATE] lookup by UPN failed'); }
    }
    if (!user && email) {
      try {
        user = await findByEmail(token, String(email).trim());
        if (user) lookedUpBy = `email:${email}`;
      } catch (e) { log.warn({ err: e && (e.message || String(e)) }, '[UPDATE] lookup by email failed'); }
    }
    if (!user && employeeId) {
      try {
        user = await findByEmployeeId(token, String(employeeId).trim());
        if (user) lookedUpBy = `employeeId:${employeeId}`;
      } catch (e) { log.warn({ err: e && (e.message || String(e)) }, '[UPDATE] lookup by employeeId failed'); }
    }

    if (!user) {
      log.warn({}, '[UPDATE] Azure user not found with provided identifiers');
      await mailFailure('UPDATE failed: user not found', `upn=${upn || ''}\nemail=${email || ''}\nemployeeId=${employeeId || ''}`);
      return res.status(404).json({
        message: 'Azure user not found. Provide one of: userPrincipalName/upn/Other_Email or email or employeeId.',
        tried: { upn: upn || null, email: email || null, employeeId: employeeId || null }
      });
    }

    // Build patch
    const patch = {
      displayName: (firstname || lastname)
        ? `${firstname || user.givenName || ''} ${lastname || user.surname || ''}`.trim()
        : undefined,
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

    if (joiningdate) {
      try {
        const [dd, mm, yyyy] = String(joiningdate).split('-');
        const dt = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
        if (!isNaN(dt.getTime())) {
          patch.employeeHireDate = dt.toISOString().replace(/\.\d{3}Z$/, 'Z');
        }
      } catch (e) {
        log.warn({ err: e && (e.message || String(e)) }, '[UPDATE] joiningdate parse failed');
      }
    }

    // Manager update
    if (manager && typeof manager === 'string') {
      try {
        const parts = manager.trim().split(/\s+/);
        const managerCode = parts[parts.length - 1];
        if (managerCode) {
          const managerUser = await findByEmployeeId(token, managerCode);
          if (managerUser && managerUser.id) {
            await axios.put(
              `https://graph.microsoft.com/v1.0/users/${user.id}/manager/$ref`,
              { '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${managerUser.id}` },
              { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: AXIOS_TIMEOUT_MS }
            );
            log.info({ userId: user.id, managerId: managerUser.id }, '[UPDATE] manager updated');
          } else {
            log.warn({ managerCode }, '[UPDATE] manager not found by employeeId');
          }
        }
      } catch (e) {
        log.warn({ details: e?.response?.data || e?.message || String(e) }, '[UPDATE] manager update failed');
      }
    }

    // Clean undefined
    Object.keys(patch).forEach((k) => patch[k] === undefined && delete patch[k]);

    if (Object.keys(patch).length === 0) {
      log.info({ userId: user.id, lookedUpBy }, '[UPDATE] nothing to update');
      return res.json({
        message: 'Nothing to update; no valid fields provided',
        userId: user.id,
        upn: user.userPrincipalName,
        lookedUpBy
      });
    }

    await updateUser(token, user.id, patch);
    log.info({ userId: user.id, lookedUpBy, keys: Object.keys(patch) }, '[UPDATE] azure user patched');
    await mailSuccess('UPDATE applied', `userId=${user.id}\nupn=${user.userPrincipalName}\nfields=${Object.keys(patch).join(',')}`);

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
    log.error({ details }, '[UPDATE] failure');
    await mailFailure('UPDATE failed', String(details));
    return res.status(500).json({ message: 'Failed to update Azure user', details });
  }
});

/**
 * Offboarding webhook
 * - Immediate disable/cleanup if exit time has passed or not provided
 * - Otherwise schedule a disable job at configured H:M IST on exit date
 */
router.post('/zoho-webhook/delete', async (req, res) => {
  const ts = new Date().toISOString();
  log.info({ ts, ip: req.ip, ua: req.get('user-agent') }, '[OFFBOARD] webhook hit');

  try {
    const data = (req.body && Object.keys(req.body).length) ? req.body : req.query;

    const employeeId = pick(data, ['employeeId', 'EmployeeID', 'EmpID', 'Emp Id', 'empId']);
    const email = pick(data, ['email', 'mail', 'Email']);
    const upn = pick(data, ['userPrincipalName', 'upn', 'Other_Email', 'Other Email', 'otherEmail']);
    const exitDateRaw = pick(data, ['dateOFExit', 'dateOfExit', 'Date_of_Exit', 'Date of Exit', 'dateofexit', 'exitDate']);

    log.info({ employeeId, hasEmail: !!email, hasUpn: !!upn, exitDateRaw }, '[OFFBOARD] identifiers summary');

    if (!employeeId) {
      log.warn({}, '[OFFBOARD] employeeId is required');
      return res.status(400).json({ message: 'employeeId is required' });
    }

    const exitDtIST = parseJoinDateIST(exitDateRaw, tz);
    const futureCandidate = exitDtIST
      ? new Date(exitDtIST.set({ hour: OFF_H, minute: OFF_M, second: 0, millisecond: 0 }).toUTC().toMillis())
      : null;

    // Immediate mode
    if (!futureCandidate || futureCandidate.getTime() <= Date.now()) {
      log.info({}, '[OFFBOARD] immediate mode: disable now');

      const token = await getAzureAccessToken();

      let user = null;
      let foundBy = null;

      try {
        user = await findByEmployeeId(token, String(employeeId).trim());
        if (user) foundBy = 'employeeId';
      } catch (e) {
        log.warn({ err: e && (e.message || String(e)) }, '[OFFBOARD] lookup by employeeId failed');
      }

      if (!user && email) {
        try {
          const byEmail = await findByEmail(token, String(email).trim());
          if (byEmail && String(byEmail.employeeId ?? '').trim() === String(employeeId).trim()) {
            user = byEmail; foundBy = 'email+eid';
          }
        } catch (e) {
          log.warn({ err: e && (e.message || String(e)) }, '[OFFBOARD] lookup by email failed');
        }
      }
      if (!user && upn) {
        try {
          const byUpn = await findUserByUPN(token, String(upn).trim());
          if (byUpn && String(byUpn.employeeId ?? '').trim() === String(employeeId).trim()) {
            user = byUpn; foundBy = 'upn+eid';
          }
        } catch (e) {
          log.warn({ err: e && (e.message || String(e)) }, '[OFFBOARD] lookup by UPN failed');
        }
      }

      if (!user) {
        log.warn({}, '[OFFBOARD] user not found with matching employeeId');
        await mailFailure('OFFBOARD failed: user not found', `employeeId=${employeeId}\nemail=${email || ''}\nupn=${upn || ''}`);
        return res.status(404).json({ message: 'Azure user not found with matching employeeId', employeeId });
      }

      const azureEmpId = String(user.employeeId ?? '').trim();
      if (foundBy !== 'employeeId' && azureEmpId !== String(employeeId).trim()) {
        log.warn({ azureEmpId, zohoEmployeeId: String(employeeId).trim() }, '[OFFBOARD] employeeId mismatch');
        await mailFailure('OFFBOARD failed: employeeId mismatch', `azure=${azureEmpId} zoho=${String(employeeId).trim()}`);
        return res.status(409).json({ message: 'employeeId mismatch', azureEmpId, zohoEmployeeId: String(employeeId).trim() });
      }

      // Best-effort cleanup sequence
      try {
        // revoke sessions
        try {
          await revokeUserSessions(token, user.id);
          log.info({ userId: user.id }, '[OFFBOARD] sessions revoked');
        } catch (e) {
          log.warn({ details: e?.response?.data || e?.message || String(e) }, '[OFFBOARD] revoke sessions failed');
        }

        // disable account
        await updateUser(token, user.id, { accountEnabled: false });
        log.info({ userId: user.id, upn: user.userPrincipalName }, '[OFFBOARD] account disabled');

        // remove groups
        try {
          const groupsRes = await axios.get(
            `https://graph.microsoft.com/v1.0/users/${user.id}/memberOf?$select=id`,
            { headers: { Authorization: `Bearer ${token}` }, timeout: AXIOS_TIMEOUT_MS }
          );
          const groups = (groupsRes.data && groupsRes.data.value) || [];
          if (groups.length) {
            for (const g of groups) {
              try {
                await axios.delete(
                  `https://graph.microsoft.com/v1.0/groups/${g.id}/members/${user.id}/$ref`,
                  { headers: { Authorization: `Bearer ${token}` }, timeout: AXIOS_TIMEOUT_MS }
                );
              } catch (err) {
                log.warn({ groupId: g.id, details: err?.response?.data || err?.message || String(err) }, '[OFFBOARD] remove from group failed');
              }
            }
          }
          log.info({ count: groups.length }, '[OFFBOARD] group memberships processed');
        } catch (e) {
          log.warn({ details: e?.response?.data || e?.message || String(e) }, '[OFFBOARD] fetch/remove groups failed');
        }

        // remove manager
        try {
          await axios.delete(
            `https://graph.microsoft.com/v1.0/users/${user.id}/manager/$ref`,
            { headers: { Authorization: `Bearer ${token}` }, timeout: AXIOS_TIMEOUT_MS }
          );
          log.info({ userId: user.id }, '[OFFBOARD] manager removed');
        } catch (e) {
          log.warn({ details: e?.response?.data || e?.message || String(e) }, '[OFFBOARD] remove manager failed');
        }

      } catch (e) {
        const details = e?.response?.data || e?.message || String(e);
        log.error({ details }, '[OFFBOARD] disable/cleanup failed');
        await mailFailure('OFFBOARD failed during cleanup', String(details));
        return res.status(e?.response?.status || 502).json({ message: 'Disable failed', details });
      }

      // Verify (best effort)
      try {
        await getUser(token, user.id, 'id');
        log.warn({}, '[OFFBOARD] verification: user still resolvable (non-fatal)');
      } catch (e) {
        if (e?.response?.status === 404) log.info({}, '[OFFBOARD] verification: user not resolvable (404)');
        else log.warn({ details: e?.response?.data || e?.message || String(e) }, '[OFFBOARD] verify read failed');
      }
      try {
        const inBin = await getDeletedUser(token, user.id);
        log.info({ present: !!inBin }, '[OFFBOARD] deleted items check');
      } catch (e) {
        log.warn({ details: e?.response?.data || e?.message || String(e) }, '[OFFBOARD] deleted items check failed');
      }

      await mailSuccess('OFFBOARD completed', `userId=${user.id}\nupn=${user.userPrincipalName}\nemployeeId=${azureEmpId}`);
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
      payload: {
        employeeId: String(employeeId).trim(),
        email: email || null,
        upn: upn || null
      }
    });
    log.info({ runAtUTC: futureCandidate.toISOString() }, '[OFFBOARD] disable job enqueued');
    await mailSuccess('OFFBOARD scheduled', `employeeId=${employeeId}\nrunAtUTC=${futureCandidate.toISOString()}`);

    return res.json({
      message: 'scheduled',
      runAt: futureCandidate.toISOString(),
      exitDateIST: exitDtIST ? exitDtIST.toISODate() : null,
      execAtIST: `${String(OFF_H).padStart(2, '0')}:${String(OFF_M).padStart(2, '0')}`,
      mode: 'scheduled'
    });
  } catch (e) {
    const details = e?.response?.data || e?.message || String(e);
    log.error({ details }, '[OFFBOARD] failure');
    await mailFailure('OFFBOARD failed', String(details));
    return res.status(500).json({ message: 'Internal Server Error', details });
  }
});

/**
 * Employment-type change webhook
 * - Adds an alias to otherMails based on employment type and current UPN
 */
router.post('/employee-type/edit', async (req, res) => {
  const ts = new Date().toISOString();
  log.info({ ts, ip: req.ip, ua: req.get('user-agent') }, '[ETYPE] webhook hit');

  try {
    const payload = (req.body && Object.keys(req.body).length) ? req.body : req.query;
    const employeeId = payload.employeeId;
    const type = payload.type;

    if (!employeeId || !type) {
      return res.status(400).json({ message: 'employeeId and type are required' });
    }

    const token = await getAzureAccessToken();
    const user = await findByEmployeeId(token, employeeId);
    if (!user) {
      log.warn({}, '[ETYPE] user not found for employeeId');
      await mailFailure('ETYPE failed: user not found', `employeeId=${employeeId}`);
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
      log.info({}, '[ETYPE] no alias change needed');
      return res.json({ message: 'No change needed' });
    }

    const currentAliases = Array.isArray(user.otherMails) ? user.otherMails : [];
    if (currentAliases.includes(aliasEmail)) {
      log.info({ aliasEmail }, '[ETYPE] alias already present');
      return res.json({ message: 'Alias already present', employeeId, aliasEmail });
    }

    await updateUser(token, user.id, { otherMails: [...currentAliases, aliasEmail] });
    log.info({ userId: user.id, aliasEmail }, '[ETYPE] alias added');
    await mailSuccess('ETYPE alias added', `employeeId=${employeeId}\nalias=${aliasEmail}`);

    return res.json({ message: 'Alias email added', employeeId, aliasEmail });
  } catch (e) {
    const details = e?.response?.data || e?.message || String(e);
    log.error({ details }, '[ETYPE] failure');
    await mailFailure('ETYPE failed', String(details));
    return res.status(500).json({ message: 'Internal Server Error', details });
  }
});

module.exports = router;
