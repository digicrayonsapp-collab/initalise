'use strict';

const express = require('express');
const helmet = require('helmet');
const { httpLogger, log } = require('./core/logger');
const { AppError, toAppError } = require('./core/errors');
const { initSQLite, markJob, setKV } = require('./infra/sqlite');
const { tickRunner } = require('./infra/scheduler');
const routes = require('./api/routes');
const { get } = require('./config/env');
const { DateTime } = require('luxon');

const { getAzureAccessToken } = require('./services/graphAuth');
const {
  findByEmployeeId,
  findByEmail,
  findUserByUPN,
  getUser,
  getDeletedUser,
  revokeUserSessions,
  deleteUser,
  updateUser,
  upsertUser,
  getNextEmployeeId
} = require('./services/graphUser');

const {
  officialEmailFromUpn,
  updateCandidateOfficialEmail,
  updateCandidateFields,
  getLastEmployeeIdFromZoho
} = require('./services/zohoPeople');

const { sendSuccessMail, sendFailureMail } = require('./infra/email');

function mask(s) {
  if (!s) return 'MISSING';
  s = String(s);
  return s.length <= 6 ? '***' : `${s.slice(0, 3)}…${s.slice(-3)}`;
}

log.info(
  {
    tenant: mask(process.env.AZURE_TENANT_ID),
    clientId: mask(process.env.AZURE_CLIENT_ID),
    secretSet: !!process.env.AZURE_CLIENT_SECRET
  },
  '[boot] azure env'
);

/* ------------------------------- executor ------------------------------- */

async function executor(job) {
  const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload;
  const type = String(job.type || '').trim().toLowerCase();
  const tz = process.env.TZ || 'Asia/Kolkata';
  const nowUtc = new Date().toISOString();
  const nowIst = DateTime.now().setZone(tz).toFormat('dd-LL-yyyy HH:mm:ss ZZZZ');

  log.info(
    {
      jobId: job.id,
      type: job.type,
      candidateId: payload?.candidateId ?? 'n/a',
      nowUtc,
      nowIst
    },
    '[executor] start'
  );

  /* -------------------------- create / prehire -------------------------- */
  if (type === 'create' || type === 'createfromcandidate') {
    try {
      const {
        firstname, lastname, email, employeeId, domain, candidateId,
        country, city, mobilePhone, department, zohoRole, company,
        employementType, employeeType, officelocation, joiningdate
      } = payload;

      const token = await getAzureAccessToken();

      // Short-circuit if user already exists (employeeId → email)
      let existingUser = null;
      try {
        if (employeeId) {
          existingUser = await findByEmployeeId(token, employeeId);
          if (existingUser) log.info({ employeeId }, '[create] user exists by employeeId');
        }
        if (!existingUser && email) {
          existingUser = await findByEmail(token, email);
          if (existingUser) log.info({ email }, '[create] user exists by email');
        }
      } catch (lookupErr) {
        log.warn({ err: lookupErr?.message }, '[create] lookup failed');
      }

      if (existingUser) {
        // cooldown to suppress Zoho echo webhook
        try {
          if (candidateId) {
            const cooldownMin = parseInt(process.env.PREHIRE_COOLDOWN_MINUTES || '3', 10);
            const cooldownMs = Math.max(0, cooldownMin) * 60 * 1000;
            setKV(`CANDIDATE_COOLDOWN_UNTIL:${candidateId}`, String(Date.now() + cooldownMs));
          }
        } catch (e) {
          log.warn({ err: e?.message }, '[create] set cooldown failed');
        }

        markJob(job.id, {
          status: 'done',
          result: {
            action: 'already_exists',
            userId: existingUser?.id || null,
            upn: existingUser?.userPrincipalName || null
          }
        });

        await sendSuccessMail({
          subject: `JOB createFromCandidate no-op (exists) (job ${job.id})`,
          text: `User already exists: ${existingUser.userPrincipalName || existingUser.id}`
        });
        return;
      }

      // Compute employeeId if missing (Zoho → KV → Graph)
      let effectiveEmployeeId = employeeId;
      if (!effectiveEmployeeId) {
        try {
          const last = await getLastEmployeeIdFromZoho();
          if (Number.isFinite(last)) {
            effectiveEmployeeId = String(last + 1);
            setKV('EMPLOYEE_ID_SEQ', last + 1);
            log.info({ last, next: last + 1 }, '[create] employeeId from Zoho');
          }
        } catch (e) {
          log.warn({ err: e?.message }, '[create] getLastEmployeeIdFromZoho failed');
        }
      }
      if (!effectiveEmployeeId) {
        try {
          const next = await getNextEmployeeId(token);
          effectiveEmployeeId = String(next);
          const n = parseInt(next, 10);
          if (Number.isFinite(n)) setKV('EMPLOYEE_ID_SEQ', n);
          log.info({ next }, '[create] employeeId from Graph scan');
        } catch (e) {
          log.warn({ err: e?.message }, '[create] getNextEmployeeId failed');
        }
      }

      const empType = employeeType || employementType || null;

      const result = await upsertUser(token, {
        firstname, lastname, email,
        employeeId: effectiveEmployeeId,
        domain,
        country, city, mobilePhone, department, zohoRole, company,
        employeeType: empType,
        employementType: empType,
        officelocation
      });

      // Hire date
      if (joiningdate) {
        try {
          const [dd, mm, yyyy] = String(joiningdate).split('-');
          const dt = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
          if (!isNaN(dt.getTime())) {
            await updateUser(token, result.userId, { employeeHireDate: dt.toISOString().replace(/\.\d{3}Z$/, 'Z') });
            log.info({}, '[create] employeeHireDate set');
          }
        } catch (e) {
          log.warn({ err: e?.message }, '[create] set employeeHireDate failed');
        }
      }

      // Push Official Email & Employee ID back to Zoho
      if (candidateId) {
        try {
          const official = officialEmailFromUpn(result.upn);
          const officialField = process.env.OFFICIAL_EMAIL_FIELD_LINK_NAME || 'Other_Email';
          const empIdField = process.env.ZOHO_EMPLOYEEID_FIELD_LINK_NAME || 'Employee_ID';
          const fields = { [officialField]: official };
          if (effectiveEmployeeId) fields[empIdField] = String(effectiveEmployeeId);
          await updateCandidateFields({ recordId: candidateId, fields });
          log.info({}, '[create] Zoho candidate updated (official email + employee id)');
        } catch (zerr) {
          log.warn({ err: zerr?.response?.data || zerr?.message }, '[create] Zoho update failed');
        }
      }

      // cooldown after success
      try {
        if (candidateId) {
          const cooldownMin = parseInt(process.env.PREHIRE_COOLDOWN_MINUTES || '3', 10);
          const cooldownMs = Math.max(0, cooldownMin) * 60 * 1000;
          setKV(`CANDIDATE_COOLDOWN_UNTIL:${candidateId}`, String(Date.now() + cooldownMs));
        }
      } catch (e) {
        log.warn({ err: e?.message }, '[create] set cooldown failed');
      }

      markJob(job.id, { status: 'done', result: { userId: result.userId, upn: result.upn, action: result.action } });

      await sendSuccessMail({
        subject: `JOB createFromCandidate succeeded (job ${job.id})`,
        text: `Action=${result.action}, upn=${result.upn || ''}, userId=${result.userId || ''}`
      });
      return;
    } catch (e) {
      const details = e?.response?.data || e?.message || String(e);
      log.error({ details }, '[create] failed');
      markJob(job.id, { status: 'failed', lastError: details });
      await sendFailureMail({ subject: `JOB createFromCandidate failed (job ${job.id})`, text: String(details) });
      return;
    }
  }

  /* ------------------------------ hard delete ------------------------------ */
  if (type === 'deleteuser') {
    const { employeeId, email, upn } = (typeof payload === 'string' ? JSON.parse(payload) : payload) || {};
    log.info({ employeeId, email, upn }, '[deleteUser] payload');

    try {
      const token = await getAzureAccessToken();

      let user = employeeId ? await findByEmployeeId(token, String(employeeId).trim()) : null;

      if (!user && email) {
        const byEmail = await findByEmail(token, String(email).trim());
        if (byEmail && (!employeeId || String(byEmail.employeeId ?? '').trim() === String(employeeId).trim())) {
          user = byEmail;
        } else if (byEmail) {
          log.warn(
            { azureEmployeeId: String(byEmail.employeeId ?? '').trim(), zohoEmployeeId: String(employeeId ?? '').trim() },
            '[deleteUser] email matched but employeeId mismatch'
          );
        }
      }
      if (!user && upn) {
        const byUpn = await findUserByUPN(token, String(upn).trim());
        if (byUpn && (!employeeId || String(byUpn.employeeId ?? '').trim() === String(employeeId).trim())) {
          user = byUpn;
        } else if (byUpn) {
          log.warn(
            { azureEmployeeId: String(byUpn.employeeId ?? '').trim(), zohoEmployeeId: String(employeeId ?? '').trim() },
            '[deleteUser] upn matched but employeeId mismatch'
          );
        }
      }

      if (!user) {
        log.warn({}, '[deleteUser] not found');
        markJob(job.id, { status: 'failed', lastError: 'User not found for delete' });
        await sendFailureMail({ subject: `JOB deleteUser failed (not found) (job ${job.id})`, text: 'User not found' });
        return;
      }

      try { await getUser(token, user.id, 'id,userPrincipalName,employeeId,accountEnabled'); } catch {}

      try {
        await revokeUserSessions(token, user.id);
      } catch (e) {
        log.warn({ err: e?.message }, '[deleteUser] revokeSignInSessions failed');
      }

      try {
        await deleteUser(token, user.id);
      } catch (e) {
        const details = e?.response?.data || e?.message || e;
        log.error({ details }, '[deleteUser] DELETE failed');
        markJob(job.id, { status: 'failed', lastError: details });
        await sendFailureMail({ subject: `JOB deleteUser failed (job ${job.id})`, text: String(details) });
        return;
      }

      try { await getUser(token, user.id, 'id'); } catch {}
      try { await getDeletedUser(token, user.id); } catch {}

      markJob(job.id, { status: 'done' });
      await sendSuccessMail({
        subject: `JOB deleteUser succeeded (job ${job.id})`,
        text: `Deleted userId=${user.id} upn=${user.userPrincipalName}`
      });
      return;
    } catch (e) {
      const details = e?.response?.data || e?.message || String(e);
      log.error({ details }, '[deleteUser] failed');
      markJob(job.id, { status: 'failed', lastError: details });
      await sendFailureMail({ subject: `JOB deleteUser failed (job ${job.id})`, text: String(details) });
      return;
    }
  }

  /* ------------------------------ disable user ----------------------------- */
  if (type === 'disableuser') {
    const { employeeId, email, upn } = payload || {};
    log.info({ employeeId, email, upn }, '[disableUser] payload');

    try {
      const token = await getAzureAccessToken();

      let user = employeeId ? await findByEmployeeId(token, String(employeeId).trim()) : null;
      if (!user && email) user = await findByEmail(token, String(email).trim());
      if (!user && upn) user = await findUserByUPN(token, String(upn).trim());

      if (!user) {
        log.warn({}, '[disableUser] not found');
        markJob(job.id, { status: 'failed', lastError: 'User not found for disable' });
        await sendFailureMail({ subject: `JOB disableUser failed (not found) (job ${job.id})`, text: 'User not found' });
        return;
      }

      await updateUser(token, user.id, { accountEnabled: false });
      markJob(job.id, { status: 'done' });

      await sendSuccessMail({
        subject: `JOB disableUser succeeded (job ${job.id})`,
        text: `Disabled userId=${user.id} upn=${user.userPrincipalName}`
      });
      return;
    } catch (e) {
      const details = e?.response?.data || e?.message || String(e);
      log.error({ details }, '[disableUser] failed');
      markJob(job.id, { status: 'failed', lastError: details });
      await sendFailureMail({ subject: `JOB disableUser failed (job ${job.id})`, text: String(details) });
      return;
    }
  }

  const msg = `Unknown job type: ${job.type}`;
  log.warn({ jobId: job.id, type: job.type }, '[executor] unknown type');
  markJob(job.id, { status: 'failed', lastError: msg });
}

/* ------------------------------ http server ------------------------------ */

function buildApp() {
  const app = express();
  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(httpLogger);

  app.use('/api', routes);

  app.use((req, res, next) => next(new AppError(404, 'Not Found')));
  app.use((err, req, res, next) => {
    const e = toAppError(err);
    log.error({ status: e.status, message: e.message, details: e.details }, '[http] error');
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
  app.listen(port, '0.0.0.0', () => log.info({ port }, '[http] listening'));

  tickRunner(executor);
}

bootstrap();
