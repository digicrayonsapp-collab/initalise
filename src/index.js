'use strict';

const express = require('express');
const helmet = require('helmet');
const axios = require('axios');
const { attachRetry } = require('./core/retry');

attachRetry(axios, { retries: 3, baseDelayMs: 300 });

const { httpLogger, log } = require('./core/logger');
const { AppError, toAppError } = require('./core/errors');
const { initSQLite, markJob, setKV } = require('./infra/sqlite');
const { tickRunner } = require('./infra/scheduler');
const routes = require('./api/routes');
const { get } = require('./config/env');
const { DateTime } = require('luxon');

const { sendSuccessMail, sendFailureMail } = require('./infra/email');

const { getAzureAccessToken } = require('./services/graphAuth');
const {
  findByEmployeeId,
  findByEmail,
  findUserByUPN,
  getUser,
  getDeletedUser,
  revokeUserSessions,
  deleteUser,
  updateUser
} = require('./services/graphUser');
const {
  officialEmailFromUpn,
  updateCandidateOfficialEmail
} = require('./services/zohoPeople');

function mask(s) {
  if (!s) return 'MISSING';
  s = String(s);
  return s.length <= 6 ? '***' : `${s.slice(0, 3)}…${s.slice(-3)}`;
}
log.info(
  'Azure env:',
  'tenant=', mask(process.env.AZURE_TENANT_ID),
  'clientId=', mask(process.env.AZURE_CLIENT_ID),
  'secretSet=', !!process.env.AZURE_CLIENT_SECRET
);

async function executor(job) {
  const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;

  const rawType = job.type;
  const type = String(rawType || '').trim().toLowerCase();
  const tz = process.env.TZ || 'Asia/Kolkata';
  const nowUtc = new Date().toISOString();
  const nowIst = DateTime.now().setZone(tz).toFormat('dd-LL-yyyy HH:mm:ss ZZZZ');
  log.info(`Running job ${job.id} [${job.type}] at UTC=${nowUtc} / ${tz}=${nowIst}`);

  if (type === 'create' || type === 'createfromcandidate') {
    try {
      const {
        firstname, lastname, email, employeeId, domain, candidateId,
        country, city, mobilePhone, department, zohoRole, company,
        employementType, employeeType, officelocation, joiningdate
      } = payload;

      const token = await getAzureAccessToken();

      let existingUser = null;
      try { existingUser = await findByEmployeeId(token, employeeId); } catch {}
      if (!existingUser && email) {
        try { existingUser = await findByEmail(token, email); } catch {}
      }
      if (existingUser) {
        try {
          if (candidateId) {
            const cooldownMin = parseInt(process.env.PREHIRE_COOLDOWN_MINUTES || '3', 10);
            const cooldownMs = Math.max(0, cooldownMin) * 60 * 1000;
            setKV(`CANDIDATE_COOLDOWN_UNTIL:${candidateId}`, String(Date.now() + cooldownMs));
          }
        } catch {}
        markJob(job.id, {
          status: 'done',
          result: { action: 'already_exists', userId: existingUser?.id || null, upn: existingUser?.userPrincipalName || null }
        });
        await sendSuccessMail({
          subject: `CREATE skipped (already exists) [job ${job.id}]`,
          text: `User ${existingUser.userPrincipalName || existingUser.id} already exists.`
        });
        return;
      }

      let effectiveEmployeeId = employeeId;
      if (!effectiveEmployeeId) {
        try {
          const { getLastEmployeeIdFromZoho } = require('./services/zohoPeople');
          const last = await getLastEmployeeIdFromZoho();
          if (Number.isFinite(last)) {
            const next = last + 1;
            effectiveEmployeeId = String(next);
            const { setKV } = require('./infra/sqlite');
            setKV('EMPLOYEE_ID_SEQ', next);
          }
        } catch {}
      }
      if (!effectiveEmployeeId) {
        try {
          const { bumpKVInt, getKVInt } = require('./infra/sqlite');
          const prev = getKVInt('EMPLOYEE_ID_SEQ', 0);
          if (prev > 0) {
            const next = bumpKVInt('EMPLOYEE_ID_SEQ');
            effectiveEmployeeId = String(next);
          }
        } catch {}
      }
      if (!effectiveEmployeeId) {
        try {
          const { getNextEmployeeId } = require('./services/graphUser');
          const next = await getNextEmployeeId(token);
          effectiveEmployeeId = String(next);
          const n = parseInt(next, 10);
          if (Number.isFinite(n)) setKV('EMPLOYEE_ID_SEQ', n);
        } catch {}
      }

      const empType = employeeType || employementType || null;
      const { upsertUser } = require('./services/graphUser');
      const result = await upsertUser(token, {
        firstname, lastname, email,
        employeeId: effectiveEmployeeId,
        domain,
        country, city, mobilePhone, department, zohoRole, company,
        employeeType: empType,
        employementType: empType,
        officelocation
      });

      if (joiningdate) {
        try {
          const [dd, mm, yyyy] = String(joiningdate).split('-');
          const dt = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
          if (!isNaN(dt.getTime())) {
            await updateUser(token, result.userId, { employeeHireDate: dt.toISOString().replace(/\.\d{3}Z$/, 'Z') });
          }
        } catch {}
      }

      if (candidateId) {
        try {
          const official = officialEmailFromUpn(result.upn);
          const officialField = process.env.OFFICIAL_EMAIL_FIELD_LINK_NAME || 'Other_Email';
          const empIdField = process.env.ZOHO_EMPLOYEEID_FIELD_LINK_NAME || 'Employee_ID';
          const { updateCandidateFields } = require('./services/zohoPeople');
          const fields = { [officialField]: official };
          if (effectiveEmployeeId) fields[empIdField] = String(effectiveEmployeeId);
          await updateCandidateFields({ recordId: candidateId, fields });
        } catch {}
      }

      try {
        if (candidateId) {
          const cooldownMin = parseInt(process.env.PREHIRE_COOLDOWN_MINUTES || '3', 10);
          const cooldownMs = Math.max(0, cooldownMin) * 60 * 1000;
          setKV(`CANDIDATE_COOLDOWN_UNTIL:${candidateId}`, String(Date.now() + cooldownMs));
        }
      } catch {}

      markJob(job.id, { status: 'done', result: { userId: result.userId, upn: result.upn, action: result.action } });
      await sendSuccessMail({
        subject: `CREATE ${result.action} [job ${job.id}]`,
        text: `User ${result.upn} (${result.userId}) ${result.action}.`
      });
      return;
    } catch (e) {
      const details = e?.response?.data || e?.message || String(e);
      log.error('create failed:', details);
      markJob(job.id, { status: 'failed', lastError: details });
      await sendFailureMail({ subject: `CREATE failed [job ${job.id}]`, text: String(details) });
      return;
    }
  }

  if (type === 'deleteuser') {
    const { employeeId, email, upn } = payload || {};
    try {
      const token = await getAzureAccessToken();

      let user = employeeId ? await findByEmployeeId(token, String(employeeId).trim()) : null;
      if (!user && email) {
        const byEmail = await findByEmail(token, String(email).trim());
        if (byEmail && (!employeeId || String(byEmail.employeeId ?? '').trim() === String(employeeId).trim())) user = byEmail;
      }
      if (!user && upn) {
        const byUpn = await findUserByUPN(token, String(upn).trim());
        if (byUpn && (!employeeId || String(byUpn.employeeId ?? '').trim() === String(employeeId).trim())) user = byUpn;
      }
      if (!user) {
        const msg = 'User not found for delete';
        markJob(job.id, { status: 'failed', lastError: msg });
        await sendFailureMail({ subject: `DELETE failed [job ${job.id}]`, text: msg });
        return;
      }

      try { await getUser(token, user.id, 'id,userPrincipalName,employeeId,accountEnabled'); } catch {}
      try { await revokeUserSessions(token, user.id); } catch {}

      try {
        await deleteUser(token, user.id);
      } catch (e) {
        const details = e?.response?.data || e?.message || e;
        markJob(job.id, { status: 'failed', lastError: details });
        await sendFailureMail({ subject: `DELETE failed [job ${job.id}]`, text: String(details) });
        return;
      }

      try { await getUser(token, user.id, 'id'); } catch {}
      try { await getDeletedUser(token, user.id); } catch {}

      markJob(job.id, { status: 'done' });
      await sendSuccessMail({
        subject: `DELETE succeeded [job ${job.id}]`,
        text: `Deleted user ${user.userPrincipalName || user.id}.`
      });
      return;
    } catch (e) {
      const details = e?.response?.data || e?.message || String(e);
      log.error('delete failed:', details);
      markJob(job.id, { status: 'failed', lastError: details });
      await sendFailureMail({ subject: `DELETE failed [job ${job.id}]`, text: String(details) });
      return;
    }
  }

  if (type === 'disableuser') {
    const { employeeId, email, upn } = payload || {};
    try {
      const token = await getAzureAccessToken();

      let user = employeeId ? await findByEmployeeId(token, String(employeeId).trim()) : null;
      if (!user && email) user = await findByEmail(token, String(email).trim());
      if (!user && upn) user = await findUserByUPN(token, String(upn).trim());

      if (!user) {
        const msg = 'User not found for disable';
        markJob(job.id, { status: 'failed', lastError: msg });
        await sendFailureMail({ subject: `DISABLE failed [job ${job.id}]`, text: msg });
        return;
      }

      await updateUser(token, user.id, { accountEnabled: false });
      markJob(job.id, { status: 'done' });
      await sendSuccessMail({
        subject: `DISABLE succeeded [job ${job.id}]`,
        text: `Disabled ${user.userPrincipalName || user.id}.`
      });
      return;
    } catch (e) {
      const details = e?.response?.data || e?.message || String(e);
      log.error('disable failed:', details);
      markJob(job.id, { status: 'failed', lastError: details });
      await sendFailureMail({ subject: `DISABLE failed [job ${job.id}]`, text: String(details) });
      return;
    }
  }

  const msg = `Unknown job type: ${job.type}`;
  log.warn(msg);
  markJob(job.id, { status: 'failed', lastError: msg });
}

function buildApp() {
  const app = express();
  app.use(helmet());

  app.use(express.json({
    limit: '1mb',
    verify: (req, res, buf) => { req.rawBody = Buffer.from(buf); }
  }));
  app.use(express.urlencoded({
    extended: true,
    verify: (req, res, buf) => { req.rawBody = Buffer.from(buf); }
  }));

  app.use(httpLogger);
  app.use('/api', routes);

  app.use((req, res, next) => next(new AppError(404, 'Not Found')));
  app.use((err, req, res, next) => {
    const e = toAppError(err);
    log.error('Error', e.message, e.details || '');
    res.status(e.status || 500).json({ message: e.message, details: e.details });
  });
  return app;
}

async function bootstrap() {
  process.on('unhandledRejection', (r) => console.error('unhandledRejection', r));
  process.on('uncaughtException', (e) => console.error('uncaughtException', e));

  await initSQLite();
  const app = buildApp();
  const port = parseInt(get('PORT', 3008), 10);
  app.listen(port, '0.0.0.0', () => log.info(`http://0.0.0.0:${port}`));

  tickRunner(executor);
}

bootstrap();
