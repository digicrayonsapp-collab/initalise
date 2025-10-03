'use strict';

const express = require('express');
const router = express.Router();

const axios = require('axios');
const { DateTime } = require('luxon');

const { log } = require('../core/logger');
const { verifySignature } = require('../middleware/verifySignature');
const { get, getInt } = require('../config/env');

const {
  upsertJob,
  markJob,
  findActiveJobByCandidate,
  getKV
} = require('../infra/sqlite');

const { getAzureAccessToken } = require('../services/graphAuth');

const {
  findByEmployeeId,
  findByEmail,
  findUserByUPN,
  getUser,
  revokeUserSessions,
  updateUser
} = require('../services/graphUser');

const {
  updateCandidateOfficialEmail
} = require('../services/zohoPeople');

const {
  sendSuccessMail,
  sendFailureMail
} = require('../infra/email');

const tz = process.env.TZ || 'Asia/Kolkata';

function toInt(v, d = 0) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }
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
function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '') {
      return obj[k];
    }
  }
  return undefined;
}

router.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

router.post('/zoho-candidate/edit', verifySignature, async (req, res) => {
  try {
    const data = (req.body && Object.keys(req.body).length) ? req.body : req.query;
    const { id, firstname, lastname, email, employeeId, joiningdate } = data;
    const employeeType = data.employeeType;

    if (!id || !firstname || !lastname) {
      const msg = 'Missing firstname, lastname, or candidate ID';
      log.warn({ msg, receivedKeys: Object.keys(data || {}) }, '[prehire] bad request');
      await sendFailureMail({ subject: 'PREHIRE schedule failed', text: msg });
      return res.status(400).json({ message: msg, received: data });
    }

    const cooldownMin = toInt(process.env.PREHIRE_COOLDOWN_MINUTES, 3);
    const untilStr = getKV(`CANDIDATE_COOLDOWN_UNTIL:${id}`);
    const until = untilStr ? Number(untilStr) : 0;
    if (until && Date.now() < until) {
      const msLeft = until - Date.now();
      log.info({ candidateId: id, msLeft }, '[prehire] cooldown active');
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
      const prehireIST = joinDtIST
        .minus({ days: prehireDays })
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

    const existing = findActiveJobByCandidate('createFromCandidate', id);
    if (existing) {
      const toleranceMs = 60 * 1000;
      if (Math.abs(existing.runAt - runAtDate.getTime()) <= toleranceMs) {
        const runAtIstExisting = DateTime.fromMillis(existing.runAt).setZone(tz).toFormat('dd-LL-yyyy HH:mm:ss ZZZZ');
        log.info({ existingId: existing.id, runAtIstExisting }, '[prehire] duplicate suppressed');
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
        firstname,
        lastname,
        email,
        employeeId,
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
        log.info({ provisional }, '[prehire] provisional Zoho official email set');
      } catch (zerr) {
        log.warn({ err: zerr?.response?.data || zerr?.message || zerr }, '[prehire] provisional Zoho update failed');
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
    log.error({ err: details }, '[prehire] schedule failed');
    await sendFailureMail({ subject: 'PREHIRE schedule failed', text: String(details || 'unknown error') });
    return res.status(500).json({ message: 'Failed to process webhook', error: details });
  }
});

router.post('/zoho-webhook/edit', verifySignature, async (req, res) => {
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
      log.warn({ tried: { upn, email, employeeId } }, '[edit] not found');
      await sendFailureMail({ subject: 'EDIT failed (user not found)', text: msg });
      return res.status(404).json({ message: msg });
    }

    const patch = {
      displayName: (firstname || lastname)
        ? `${firstname || user.givenName || ''} ${lastname || user.surname || ''}`.trim()
        : undefined,
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
      } catch (e) {
        log.warn({ join: joiningdate, err: e?.message }, '[edit] hireDate parse failed');
      }
    }

    if (manager) {
      try {
        const managerCode = String(manager).split(' ').pop();
        const mUser = await findByEmployeeId(token, managerCode);
        if (mUser?.id) {
          await axios.put(
            `https://graph.microsoft.com/v1.0/users/${user.id}/manager/$ref`,
            { '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${mUser.id}` },
            { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
          );
        } else {
          log.warn({ manager }, '[edit] manager not found by employeeId');
        }
      } catch (err) {
        log.warn({ err: err?.response?.data || err?.message || err }, '[edit] manager update failed');
      }
    }

    Object.keys(patch).forEach((k) => patch[k] === undefined && delete patch[k]);

    if (Object.keys(patch).length) {
      await updateUser(token, user.id, patch);
    } else {
      log.info({ userId: user.id }, '[edit] nothing to update');
      return res.json({
        message: 'Nothing to update; no valid fields provided',
        userId: user.id,
        upn: user.userPrincipalName,
        lookedUpBy
      });
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
    log.error({ err: details }, '[edit] failed');
    await sendFailureMail({ subject: 'EDIT failed', text: String(details) });
    return res.status(500).json({ message: 'Failed to update Azure user', details });
  }
});

router.post('/zoho-webhook/delete', verifySignature, async (req, res) => {
  try {
    const data = Object.keys(req.body || {}).length ? req.body : req.query;

    const employeeId = pick(data, ['employeeId', 'EmployeeID', 'EmpID', 'Emp Id', 'empId']);
    const email = pick(data, ['email', 'mail', 'Email']);
    const upn = pick(data, ['userPrincipalName', 'upn', 'Other_Email', 'Other Email', 'otherEmail']);
    const exitDateRaw = pick(data, ['dateOFExit', 'dateOfExit', 'Date_of_Exit', 'Date of Exit', 'dateofexit', 'exitDate']);

    if (!employeeId) {
      const msg = 'employeeId is required';
      log.warn('[delete] missing employeeId');
      await sendFailureMail({ subject: 'DELETE failed (missing employeeId)', text: msg });
      return res.status(400).json({ message: msg });
    }

    const H = getInt('OFFBOARD_EXEC_HOUR', 14);
    const M = getInt('OFFBOARD_EXEC_MIN', 20);
    const exitDtIST = parseJoinDateIST(exitDateRaw, tz);
    const candidate = exitDtIST
      ? new Date(exitDtIST.set({ hour: H, minute: M, second: 0, millisecond: 0 }).toUTC().toMillis())
      : null;

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
        log.warn({ employeeId, email, upn }, '[delete] not found');
        await sendFailureMail({ subject: 'DELETE failed (not found)', text: msg });
        return res.status(404).json({ message: msg, employeeId });
      }

      try { await revokeUserSessions(token, user.id); } catch { }
      try {
        await updateUser(token, user.id, { accountEnabled: false });

        try {
          const groupsRes = await axios.get(
            `https://graph.microsoft.com/v1.0/users/${user.id}/memberOf?$select=id`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
          const groups = groupsRes.data.value || [];
          for (const g of groups) {
            try {
              await axios.delete(
                `https://graph.microsoft.com/v1.0/groups/${g.id}/members/${user.id}/$ref`,
                { headers: { Authorization: `Bearer ${token}` } }
              );
            } catch { }
          }
        } catch { }

        try {
          await axios.delete(
            `https://graph.microsoft.com/v1.0/users/${user.id}/manager/$ref`,
            { headers: { Authorization: `Bearer ${token}` } }
          );
        } catch { }
      } catch (e) {
        const details = e?.response?.data || e?.message || e;
        log.error({ err: details }, '[delete] disable failed');
        await sendFailureMail({ subject: 'DELETE failed (update)', text: String(details) });
        return res.status(502).json({ message: 'Delete failed', details });
      }

      await sendSuccessMail({
        subject: 'DELETE (immediate) succeeded',
        text: `Disabled user ${user.userPrincipalName || user.id} (employeeId ${employeeId}).`
      });

      return res.json({
        message: 'deleted',
        userId: user.id,
        upn: user.userPrincipalName,
        employeeId: String(employeeId).trim(),
        mode: 'immediate'
      });
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
    log.error({ err: details }, '[delete] exception');
    await sendFailureMail({ subject: 'DELETE failed (exception)', text: String(details) });
    return res.status(500).json({ message: 'Internal Server Error', details });
  }
});

router.post('/employee-type/edit', verifySignature, async (req, res) => {
  try {
    const { employeeId, type } = req.body || {};
    if (!employeeId || !type) {
      const msg = 'employeeId and type are required';
      log.warn('[emp-type] missing inputs');
      await sendFailureMail({ subject: 'EMP-TYPE failed (bad request)', text: msg });
      return res.status(400).json({ message: msg });
    }

    const token = await getAzureAccessToken();
    const user = await findByEmployeeId(token, employeeId);
    if (!user) {
      const msg = `No user for employeeId ${employeeId}`;
      log.warn({ employeeId }, '[emp-type] not found');
      await sendFailureMail({ subject: 'EMP-TYPE failed (not found)', text: msg });
      return res.status(404).json({ message: 'User not found in Azure' });
    }

    const upn = user.userPrincipalName;
    let aliasEmail = null;
    if (type === 'Regular Full-Time') aliasEmail = upn.replace(/^(i-|c-)/, '');
    else if (type === 'Intern Full-Time') aliasEmail = upn.startsWith('i-') ? null : `i-${upn.replace(/^(i-|c-)/, '')}`;
    else if (type === 'Contractor Full-Time') aliasEmail = upn.startsWith('c-') ? null : `c-${upn.replace(/^(i-|c-)/, '')}`;

    if (!aliasEmail) {
      log.info({ upn, type }, '[emp-type] no change needed');
      return res.json({ message: 'No change needed' });
    }

    const currentAliases = user.otherMails || [];
    if (!currentAliases.includes(aliasEmail)) {
      await updateUser(token, user.id, { otherMails: [...currentAliases, aliasEmail] });
    }

    await sendSuccessMail({ subject: 'EMP-TYPE alias added', text: `Added alias ${aliasEmail} to ${upn}` });
    return res.json({ message: 'Alias email added', employeeId, aliasEmail });
  } catch (e) {
    const details = e?.response?.data || e?.message || e;
    log.error({ err: details }, '[emp-type] failed');
    await sendFailureMail({ subject: 'EMP-TYPE failed', text: String(details) });
    return res.status(500).json({ message: 'Internal Server Error', details });
  }
});

module.exports = router;
