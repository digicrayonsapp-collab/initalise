'use strict';

const express = require('express');
const router = express.Router();

const { log } = require('../core/logger');
const { upsertJob, markJob, findActiveJobByCandidate, getKV } = require('../infra/sqlite');
const { getInt, get } = require('../config/env');
const { getAzureAccessToken } = require('../services/graphAuth');
const { DateTime } = require('luxon');
const axios = require('axios');

const {
  findByEmployeeId,
  findByEmail,
  findUserByUPN,
  getUser,
  revokeUserSessions,
  deleteUser,
  getDeletedUser,
  updateUser
} = require('../services/graphUser');

const { updateCandidateOfficialEmail } = require('../services/zohoPeople');
const { sendSuccessMail, sendFailureMail } = require('../infra/email');

const tz = process.env.TZ || 'Asia/Kolkata';

function toInt(v, d = 0) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
function clamp(n, min, max) { return Math.min(Math.max(n, min), max); }

function parseJoinDateIST(s, zone) {
  if (!s) return null;
  const dt = DateTime.fromFormat(String(s).trim(), 'dd-LL-yyyy', { zone: zone || tz });
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

router.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

/* ------------------------- prehire: candidate ----------------------- */

router.post('/zoho-candidate/edit', async (req, res) => {
  const startedAt = new Date().toISOString();
  try {
    const data = (req.body && Object.keys(req.body).length) ? req.body : req.query;
    const { id, firstname, lastname, email, employeeId, joiningdate } = data;
    const employeeType = data.employeeType;

    log.info('[prehire] request', { startedAt, keys: Object.keys(data), employeeType, id, firstname, lastname, joiningdate });

    if (!id || !firstname || !lastname) {
      const msg = 'Missing firstname, lastname, or candidate ID';
      await sendFailureMail({ subject: 'PREHIRE schedule failed', text: msg });
      return res.status(400).json({ message: msg, received: data });
    }

    // Cool-down on candidate id to avoid echo loops
    const cooldownMin = toInt(process.env.PREHIRE_COOLDOWN_MINUTES, 3);
    const untilStr = getKV(`CANDIDATE_COOLDOWN_UNTIL:${id}`);
    const until = untilStr ? Number(untilStr) : 0;
    if (until && Date.now() < until) {
      const msLeft = until - Date.now();
      log.info('[prehire] cooldown', { candidateId: id, msLeft });
      return res.json({ message: 'cooldown_active', candidateId: id, retryAfterMs: msLeft });
    }

    const execHour = toInt(process.env.PREHIRE_EXEC_HOUR, 14);
    const execMin = toInt(process.env.PREHIRE_EXEC_MIN, 45);
    const quickMins = toInt(process.env.POSTJOIN_OFFSET_MINUTES, 2);
    const prehireDays = toInt(process.env.PREHIRE_OFFSET_DAYS, 5);

    const joinDtIST = parseJoinDateIST(joiningdate, tz);
    const nowIST = DateTime.now().setZone(tz);

    let runAtDate, reason;
    if (joinDtIST) {
      const prehireIST = joinDtIST.minus({ days: prehireDays }).set({ hour: execHour, minute: execMin, second: 0, millisecond: 0 });
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

    const existing = findActiveJobByCandidate('createFromCandidate', id);
    if (existing) {
      const toleranceMs = 60 * 1000;
      if (Math.abs(existing.runAt - runAtDate.getTime()) <= toleranceMs) {
        const runAtIstExisting = DateTime.fromMillis(existing.runAt).setZone(tz).toFormat('dd-LL-yyyy HH:mm:ss ZZZZ');
        log.info('[prehire] duplicate suppressed', { job: existing, runAtIstExisting });
        return res.json({
          message: 'already_scheduled',
          jobId: existing.id,
          status: existing.status,
          runAtUTC: new Date(existing.runAt).toISOString(),
          runAtIST: runAtIstExisting
        });
      }
      markJob(existing.id, {
        status: 'cancelled',
        lastError: 'superseded by new schedule',
        result: { supersededBy: { runAt: runAtDate.getTime() } }
      });
    }

    const jobId = upsertJob({
      type: 'createFromCandidate',
      runAt: runAtDate.getTime(),
      payload: {
        candidateId: id,
        firstname, lastname, email, employeeId,
        joiningdate: joiningdate || null,
        offsetDays: prehireDays,
        domain: get('AZURE_DEFAULT_DOMAIN'),
        employeeType,
        employementType: employeeType
      }
    });

    if (String(process.env.ZP_PROVISIONAL_UPDATE || 'false').toLowerCase() === 'true') {
      try {
        const domain = process.env.OFFICIAL_EMAIL_DOMAIN || get('AZURE_DEFAULT_DOMAIN');
        const local = normNickname(firstname, lastname);
        const pref = prefixForEmployeeType(employeeType);
        const provisional = `${pref}${local}@${domain}`;
        await updateCandidateOfficialEmail({ recordId: id, officialEmail: provisional });
        log.info('[prehire] provisional Zoho email set', { provisional });
      } catch (zerr) {
        log.warn('[prehire] provisional Zoho update failed', zerr?.response?.data || zerr?.message || zerr);
      }
    }

    const execAtISTLabel = DateTime.fromMillis(runAtDate.getTime()).setZone(tz).toFormat('HH:mm');
    await sendSuccessMail({
      subject: `PREHIRE scheduled (job ${jobId})`,
      text: `Job ${jobId} scheduled at ${runAtDate.toISOString()} [IST ${execAtISTLabel}] for candidate ${id}.`
    });

    return res.json({
      message: 'scheduled',
      jobId,
      runAt: runAtDate.toISOString(),
      computedFrom: reason,
      joinDateIST: joinDtIST ? joinDtIST.toISODate() : null,
      execAtIST: execAtISTLabel,
      prehireDays
    });
  } catch (error) {
    const details = error?.response?.data || error.message;
    log.error('[prehire] error', details);
    await sendFailureMail({ subject: 'PREHIRE schedule failed', text: String(details || 'unknown error') });
    return res.status(500).json({ message: 'Failed to process webhook', error: details });
  }
});

/* --------------------------- edit: profile patch --------------------------- */

router.post('/zoho-webhook/edit', async (req, res) => {
  const startedAt = new Date().toISOString();
  log.info('[edit] hit', { ts: startedAt, ip: req.ip, ua: req.get('user-agent') });

  try {
    const data = Object.keys(req.body || {}).length ? req.body : req.query;
    const upn = data.userPrincipalName || data.upn || data.Other_Email || data['Other Email'] || data.otherEmail;
    const { email, employeeId, manager } = data;

    const {
      firstname, lastname, city, country, mobilePhone, department,
      zohoRole, company, employementType, officelocation, joiningdate
    } = data;

    const token = await getAzureAccessToken();

    let user = null;
    let lookedUpBy = null;

    if (upn) {
      user = await findUserByUPN(token, String(upn).trim());
      if (user) lookedUpBy = `UPN:${upn}`;
    }
    if (!user && email) {
      user = await findByEmail(token, String(email).trim());
      if (user) lookedUpBy = `email:${email}`;
    }
    if (!user && employeeId) {
      user = await findByEmployeeId(token, String(employeeId).trim());
      if (user) lookedUpBy = `employeeId:${employeeId}`;
    }

    if (!user) {
      const msg = 'Azure user not found. Provide one of: userPrincipalName/upn/Other_Email or email or employeeId.';
      await sendFailureMail({ subject: 'EDIT failed (user not found)', text: msg });
      return res.status(404).json({ message: msg, tried: { upn: upn || null, email: email || null, employeeId: employeeId || null } });
    }

    // Use otherMails (mail is read-only)
    const patch = {
      displayName: (firstname || lastname) ? `${firstname || user.givenName || ''} ${lastname || user.surname || ''}`.trim() : undefined,
      givenName: firstname || undefined,
      surname: lastname || undefined,
      otherMails: email ? [String(email).trim()] : undefined,
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
        if (!isNaN(dt.getTime())) patch.employeeHireDate = dt.toISOString().replace(/\.\d{3}Z$/, 'Z');
      } catch (e) { log.warn('[edit] failed to parse joiningdate', e.message); }
    }

    if (manager) {
      try {
        const managerCode = manager.split(' ').pop();
        const mUser = await findByEmployeeId(token, managerCode);
        if (mUser?.id) {
          await axios.put(
            `https://graph.microsoft.com/v1.0/users/${user.id}/manager/$ref`,
            { '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${mUser.id}` },
            { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
          );
        } else {
          log.warn('[edit] manager not found in Azure by employeeId', manager);
        }
      } catch (err) {
        log.warn('[edit] manager update failed', err?.response?.data || err?.message || err);
      }
    }

    Object.keys(patch).forEach((k) => patch[k] === undefined && delete patch[k]);
    if (Object.keys(patch).length) {
      await updateUser(token, user.id, patch);
    }

    await sendSuccessMail({
      subject: 'EDIT succeeded',
      text: `Updated user ${user.userPrincipalName || user.id}. Fields: ${Object.keys(patch).join(', ')}`
    });

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
    log.error('[edit] failed', details);
    await sendFailureMail({ subject: 'EDIT failed', text: String(details) });
    return res.status(500).json({ message: 'Failed to update Azure user', details });
  }
});

/* --------------------------- offboarding delete --------------------------- */

router.post('/zoho-webhook/delete', async (req, res) => {
  const startedAt = new Date().toISOString();
  log.info('[delete] hit', { ts: startedAt, ip: req.ip, ua: req.get('user-agent') });

  try {
    const data = Object.keys(req.body || {}).length ? req.body : req.query;

    const employeeId = ['employeeId', 'EmployeeID', 'EmpID', 'Emp Id', 'empId'].map(k => data[k]).find(v => v !== undefined);
    const email = ['email', 'mail', 'Email'].map(k => data[k]).find(v => v !== undefined);
    const upn = ['userPrincipalName', 'upn', 'Other_Email', 'Other Email', 'otherEmail'].map(k => data[k]).find(v => v !== undefined);
    const exitDateRaw = ['dateOFExit', 'dateOfExit', 'Date_of_Exit', 'Date of Exit', 'dateofexit', 'exitDate'].map(k => data[k]).find(v => v !== undefined);

    if (!employeeId) {
      const msg = 'employeeId is required';
      await sendFailureMail({ subject: 'DELETE failed (missing employeeId)', text: msg });
      return res.status(400).json({ message: msg });
    }

    const H = getInt('OFFBOARD_EXEC_HOUR', 14);
    const M = getInt('OFFBOARD_EXEC_MIN', 20);
    const exitDtIST = parseJoinDateIST(exitDateRaw, tz);
    const candidate = exitDtIST ? new Date(exitDtIST.set({ hour: H, minute: M, second: 0, millisecond: 0 }).toUTC().toMillis()) : null;

    if (!candidate || candidate.getTime() <= Date.now()) {
      const token = await getAzureAccessToken();
      let user = await findByEmployeeId(token, String(employeeId).trim());
      if (!user && email) {
        const byEmail = await findByEmail(token, String(email).trim());
        if (byEmail && String(byEmail.employeeId ?? '').trim() === String(employeeId).trim()) user = byEmail;
      }
      if (!user && upn) {
        const byUpn = await findUserByUPN(token, String(upn).trim());
        if (byUpn && String(byUpn.employeeId ?? '').trim() === String(employeeId).trim()) user = byUpn;
      }

      if (!user) {
        const msg = 'Azure user not found with matching employeeId';
        await sendFailureMail({ subject: 'DELETE failed (not found)', text: msg });
        return res.status(404).json({ message: msg, employeeId });
      }

      try { await revokeUserSessions(token, user.id); } catch {}
      try {
        await updateUser(token, user.id, { accountEnabled: false });

        // remove from groups
        try {
          const groupsRes = await axios.get(`https://graph.microsoft.com/v1.0/users/${user.id}/memberOf?$select=id`, { headers: { Authorization: `Bearer ${token}` } });
          const groups = groupsRes.data.value || [];
          for (const g of groups) {
            try { await axios.delete(`https://graph.microsoft.com/v1.0/groups/${g.id}/members/${user.id}/$ref`, { headers: { Authorization: `Bearer ${token}` } }); }
            catch (err) { log.warn('[delete] group remove failed', { group: g.id, err: err?.response?.data || err?.message }); }
          }
        } catch (e) { log.warn('[delete] remove groups failed', e?.message); }

        try { await axios.delete(`https://graph.microsoft.com/v1.0/users/${user.id}/manager/$ref`, { headers: { Authorization: `Bearer ${token}` } }); }
        catch (e) { log.warn('[delete] remove manager failed', e?.message); }

      } catch (e) {
        const details = e?.response?.data || e?.message || e;
        await sendFailureMail({ subject: 'DELETE failed (update)', text: String(details) });
        return res.status(502).json({ message: 'Delete failed', details });
      }

      await sendSuccessMail({
        subject: 'DELETE (immediate) succeeded',
        text: `Disabled user ${user.userPrincipalName || user.id} (employeeId ${employeeId}).`
      });

      return res.json({ message: 'deleted', userId: user.id, upn: user.userPrincipalName, employeeId: String(employeeId).trim(), mode: 'immediate' });
    }

    const runAt = candidate.getTime();
    const jobId = upsertJob({
      type: 'disableUser',
      runAt,
      payload: { employeeId: String(employeeId).trim(), email: email || null, upn: upn || null }
    });

    await sendSuccessMail({
      subject: `DELETE scheduled (job ${jobId})`,
      text: `Disable scheduled at ${candidate.toISOString()} for employeeId ${employeeId}.`
    });

    return res.json({
      message: 'scheduled',
      runAt: candidate.toISOString(),
      exitDateIST: exitDtIST ? exitDtIST.toISODate() : null,
      execAtIST: `${String(H).padStart(2, '0')}:${String(M).padStart(2, '0')}`,
      mode: 'scheduled'
    });
  } catch (e) {
    const details = e?.response?.data || e?.message || String(e);
    log.error('[delete] failed', details);
    await sendFailureMail({ subject: 'DELETE failed (exception)', text: String(details) });
    return res.status(500).json({ message: 'Internal Server Error', details });
  }
});

/* ---------------------- employment type alias helper ---------------------- */

router.post('/employee-type/edit', async (req, res) => {
  log.info('[emp-type] hit', { ts: new Date().toISOString(), ip: req.ip, ua: req.get('user-agent') });

  try {
    const { employeeId, type } = req.body || {};
    if (!employeeId || !type) {
      await sendFailureMail({ subject: 'EMP-TYPE failed (bad request)', text: 'employeeId and type are required' });
      return res.status(400).json({ message: 'employeeId and type are required' });
    }

    const token = await getAzureAccessToken();
    const user = await findByEmployeeId(token, employeeId);
    if (!user) {
      await sendFailureMail({ subject: 'EMP-TYPE failed (not found)', text: `No user for employeeId ${employeeId}` });
      return res.status(404).json({ message: 'User not found in Azure' });
    }

    const upn = user.userPrincipalName;
    let aliasEmail = null;
    if (type === 'Regular Full-Time') aliasEmail = upn.replace(/^(i-|c-)/, '');
    else if (type === 'Intern Full-Time') aliasEmail = upn.startsWith('i-') ? null : `i-${upn.replace(/^(i-|c-)/, '')}`;
    else if (type === 'Contractor Full-Time') aliasEmail = upn.startsWith('c-') ? null : `c-${upn.replace(/^(i-|c-)/, '')}`;

    if (!aliasEmail) return res.json({ message: 'No change needed' });

    const currentAliases = user.otherMails || [];
    if (!currentAliases.includes(aliasEmail)) {
      await updateUser(token, user.id, { otherMails: [...currentAliases, aliasEmail] });
    }

    await sendSuccessMail({ subject: 'EMP-TYPE alias added', text: `Added alias ${aliasEmail} to ${upn}` });
    return res.json({ message: 'Alias email added', employeeId, aliasEmail });

  } catch (e) {
    const details = e?.response?.data || e?.message || e;
    log.error('[emp-type] failed', details);
    await sendFailureMail({ subject: 'EMP-TYPE failed', text: String(details) });
    return res.status(500).json({ message: 'Internal Server Error', details });
  }
});

module.exports = router;
