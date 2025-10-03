'use strict';

const express = require('express');
const helmet = require('helmet');

const { httpLogger, log } = require('./core/logger');
const { AppError, toAppError, getSafeErrorPayload } = require('./core/errors');
const { initSQLite, markJob, setKV } = require('./infra/sqlite');
const { tickRunner } = require('./infra/scheduler');
const routes = require('./api/routes');
const { get, getInt } = require('./config/env');
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
  // optional helpers used during create flow
  getNextEmployeeId,
  upsertUser,
} = require('./services/graphUser');

const {
  officialEmailFromUpn,
  updateCandidateOfficialEmail,
  getLastEmployeeIdFromZoho,
  updateCandidateFields
} = require('./services/zohoPeople');

// optional: event bus and mailer (graceful no-op if absent)
let bus = null;
try { ({ initBus: require('./core/bus').initBus, bus } = require('./core/bus')); } catch (_) { }
let sendMail = null;
try { ({ sendMail } = require('./infra/email')); } catch (_) { }

require('dotenv').config();

/* ------------------------------ mail helpers ------------------------------- */

const EMAIL_MODE = (get('EMAIL_MODE', 'event') || 'event').toLowerCase(); // event|summary|both|off
const EMAIL_SUBJECT_PREFIX = get('EMAIL_SUBJECT_PREFIX', '[Zoho-Azure Sync]');
const TO_SUCCESS = (get('EMAIL_TO_SUCCESS', '') || '').trim();
const TO_FAILURE = (get('EMAIL_TO_FAILURE', '') || '').trim();

const mailEnabled = !!sendMail && EMAIL_MODE !== 'off';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
  } catch (e) {
    log.warn({ err: e && (e.message || String(e)) }, '[MAIL] success email failed');
  }
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
  } catch (e) {
    log.warn({ err: e && (e.message || String(e)) }, '[MAIL] failure email failed');
  }
}
function emitSafe(event, payload) { try { if (bus && bus.emit) bus.emit(event, payload); } catch (_) { } }

/* -------------------------------- utilities -------------------------------- */

function mask(s) {
  if (!s) return 'MISSING';
  const v = String(s);
  return v.length <= 6 ? '***' : `${v.slice(0, 3)}…${v.slice(-3)}`;
}

const TZ = process.env.TZ || 'Asia/Kolkata';

function toInt(v, d = 0) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; }

function normalizeType(t) { return String(t || '').trim().toLowerCase(); }

/* --------------------------------- executor -------------------------------- */

async function executor(job) {
  const startedUtc = new Date().toISOString();
  const startedIst = DateTime.now().setZone(TZ).toFormat('dd-LL-yyyy HH:mm:ss ZZZZ');
  const payload = typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload || {};

  const type = normalizeType(job.type);
  log.info({ jobId: job.id, type, startedUtc, startedIst }, '[EXEC] job start');

  // ----------------------------- CREATE / PREHIRE ----------------------------
  if (type === 'create' || type === 'createfromcandidate') {
    try {
      const {
        firstname, lastname, email, employeeId, domain, candidateId,
        country, city, mobilePhone, department, zohoRole, company,
        employementType, employeeType, officelocation, joiningdate
      } = payload;

      log.info({ candidateId, firstname: !!firstname, lastname: !!lastname, hasEmail: !!email, employeeId: !!employeeId }, '[CREATE] payload summary');

      // token
      const token = await getAzureAccessToken();

      // EXISTS? Prefer employeeId, then email
      let existingUser = null;
      try { if (employeeId) existingUser = await findByEmployeeId(token, employeeId); } catch (e) { log.warn({ err: e?.message || String(e) }, '[CREATE] findByEmployeeId failed'); }
      if (!existingUser && email) {
        try { existingUser = await findByEmail(token, email); } catch (e) { log.warn({ err: e?.message || String(e) }, '[CREATE] findByEmail failed'); }
      }

      if (existingUser) {
        log.info({ employeeId, upn: existingUser.userPrincipalName, id: existingUser.id }, '[CREATE] user exists → skip create');

        // cooldown to suppress echo webhook
        try {
          if (candidateId) {
            const cooldownMin = toInt(process.env.PREHIRE_COOLDOWN_MINUTES || '3', 3);
            const cooldownMs = Math.max(0, cooldownMin) * 60 * 1000;
            setKV(`CANDIDATE_COOLDOWN_UNTIL:${candidateId}`, String(Date.now() + cooldownMs));
          }
        } catch (e) { log.warn({ err: e?.message || String(e) }, '[CREATE] set cooldown failed'); }

        markJob(job.id, { status: 'done', result: { action: 'already_exists', userId: existingUser.id, upn: existingUser.userPrincipalName } });
        await mailSuccess('CREATE skipped (exists)', `jobId=${job.id}\nupn=${existingUser.userPrincipalName}\nuserId=${existingUser.id}`);
        emitSafe('sync:success', { action: 'user-create-skip', upn: existingUser.userPrincipalName, employee_id: existingUser.employeeId });
        return;
      }

      // determine employeeId if missing
      let effectiveEmployeeId = employeeId || null;

      if (!effectiveEmployeeId) {
        try {
          const last = await getLastEmployeeIdFromZoho();
          if (Number.isFinite(last)) {
            const next = last + 1;
            effectiveEmployeeId = String(next);
            setKV('EMPLOYEE_ID_SEQ', next);
            log.info({ last, next }, '[CREATE] employeeId from Zoho');
          }
        } catch (e) {
          log.warn({ err: e?.response?.data || e?.message || String(e) }, '[CREATE] Zoho last Employee_ID fetch failed');
        }
      }

      if (!effectiveEmployeeId) {
        try {
          const next = await getNextEmployeeId(token); // Graph scan
          effectiveEmployeeId = String(next);
          const n = parseInt(next, 10);
          if (Number.isFinite(n)) setKV('EMPLOYEE_ID_SEQ', n);
          log.info({ next }, '[CREATE] employeeId from Azure scan');
        } catch (e) {
          log.warn({ err: e?.response?.data || e?.message || String(e) }, '[CREATE] Azure scan for next employeeId failed');
        }
      }

      const empType = employeeType || employementType || null;

      const result = await upsertUser(token, {
        firstname, lastname, email,
        employeeId: effectiveEmployeeId,
        domain,
        country, city, mobilePhone, department, zohoRole, company,
        employeeType: empType,        // canonical
        employementType: empType,     // legacy mirror
        officelocation
      });

      log.info({ action: result.action, userId: result.userId, upn: result.upn }, '[CREATE] upsert result');

      // optional hire date
      if (joiningdate) {
        try {
          const [dd, mm, yyyy] = String(joiningdate).split('-');
          const dt = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
          if (!isNaN(dt.getTime())) {
            await updateUser(token, result.userId, { employeeHireDate: dt.toISOString().replace(/\.\d{3}Z$/, 'Z') });
            log.info({ hireDate: dt.toISOString() }, '[CREATE] employeeHireDate set');
          }
        } catch (e) { log.warn({ err: e?.message || String(e) }, '[CREATE] set employeeHireDate failed'); }
      }

      // push back to Zoho
      if (candidateId) {
        try {
          const official = officialEmailFromUpn(result.upn);
          const officialField = process.env.OFFICIAL_EMAIL_FIELD_LINK_NAME || 'Other_Email';
          const empIdField = process.env.ZOHO_EMPLOYEEID_FIELD_LINK_NAME || 'Employee_ID';
          const fields = { [officialField]: official };
          if (effectiveEmployeeId) fields[empIdField] = String(effectiveEmployeeId);
          await updateCandidateFields({ recordId: candidateId, fields });
          log.info({ candidateId, fields: Object.keys(fields) }, '[CREATE] Zoho candidate updated');
        } catch (zerr) { log.warn({ err: zerr?.response?.data || zerr?.message || String(zerr) }, '[CREATE] Zoho candidate update failed'); }
      }

      // cooldown + mark done
      try {
        if (candidateId) {
          const cooldownMin = toInt(process.env.PREHIRE_COOLDOWN_MINUTES || '3', 3);
          const cooldownMs = Math.max(0, cooldownMin) * 60 * 1000;
          setKV(`CANDIDATE_COOLDOWN_UNTIL:${candidateId}`, String(Date.now() + cooldownMs));
        }
      } catch (e) { log.warn({ err: e?.message || String(e) }, '[CREATE] set cooldown failed'); }

      markJob(job.id, { status: 'done', result: { userId: result.userId, upn: result.upn, action: result.action } });
      await mailSuccess('CREATE completed', `jobId=${job.id}\nuserId=${result.userId}\nupn=${result.upn}\nemployeeId=${effectiveEmployeeId || ''}`);
      emitSafe('sync:success', { action: 'user-create', upn: result.upn, employee_id: effectiveEmployeeId });
      return;
    } catch (e) {
      const details = e?.response?.data || e?.message || String(e);
      log.error({ details }, '[CREATE] failed');
      markJob(job.id, { status: 'failed', lastError: details });
      await mailFailure('CREATE failed', `jobId=${job.id}\nerror=${String(details)}`);
      emitSafe('sync:failure', { action: 'user-create', error: details });
      return;
    }
  }

  // --------------------------------- DELETE ---------------------------------
  if (type === 'deleteuser') {
    try {
      const { employeeId, email, upn } = payload || {};
      log.info({ employeeId, hasEmail: !!email, hasUpn: !!upn }, '[DELETE] payload summary');

      const token = await getAzureAccessToken();

      // Resolve strictly by employeeId; fallbacks must verify employeeId equality if provided
      let user = null;
      if (employeeId) {
        try { user = await findByEmployeeId(token, String(employeeId).trim()); } catch (e) { log.warn({ err: e?.message || String(e) }, '[DELETE] findByEmployeeId failed'); }
      }
      if (!user && email) {
        try {
          const byEmail = await findByEmail(token, String(email).trim());
          if (byEmail && (!employeeId || String(byEmail.employeeId ?? '').trim() === String(employeeId).trim())) user = byEmail;
          else if (byEmail && employeeId) log.warn({ azureEmpId: byEmail.employeeId, zohoEmpId: employeeId }, '[DELETE] email matched but employeeId mismatch');
        } catch (e) { log.warn({ err: e?.message || String(e) }, '[DELETE] findByEmail failed'); }
      }
      if (!user && upn) {
        try {
          const byUpn = await findUserByUPN(token, String(upn).trim());
          if (byUpn && (!employeeId || String(byUpn.employeeId ?? '').trim() === String(employeeId).trim())) user = byUpn;
          else if (byUpn && employeeId) log.warn({ azureEmpId: byUpn.employeeId, zohoEmpId: employeeId }, '[DELETE] UPN matched but employeeId mismatch');
        } catch (e) { log.warn({ err: e?.message || String(e) }, '[DELETE] findUserByUPN failed'); }
      }

      if (!user) {
        log.warn({}, '[DELETE] user not found with matching criteria');
        markJob(job.id, { status: 'failed', lastError: 'User not found for delete' });
        await mailFailure('DELETE failed: user not found', `jobId=${job.id}\nemployeeId=${employeeId || ''}\nemail=${email || ''}\nupn=${upn || ''}`);
        emitSafe('sync:failure', { action: 'user-delete', error: 'not-found' });
        return;
      }

      // before snapshot (best effort)
      try {
        const before = await getUser(token, user.id, 'id,userPrincipalName,employeeId,accountEnabled');
        log.info({ upn: before?.userPrincipalName, empId: before?.employeeId, enabled: before?.accountEnabled }, '[DELETE] pre-delete snapshot');
      } catch (e) { log.warn({ err: e?.response?.data || e?.message || String(e) }, '[DELETE] pre-read failed'); }

      // revoke sessions
      try { await revokeUserSessions(token, user.id); log.info({ userId: user.id }, '[DELETE] sessions revoked'); }
      catch (e) { log.warn({ err: e?.response?.data || e?.message || String(e) }, '[DELETE] revoke sessions failed'); }

      // delete
      try { await deleteUser(token, user.id); log.info({ userId: user.id }, '[DELETE] delete completed'); }
      catch (e) {
        const details = e?.response?.data || e?.message || String(e);
        log.error({ details }, '[DELETE] delete failed');
        markJob(job.id, { status: 'failed', lastError: details });
        await mailFailure('DELETE failed', `jobId=${job.id}\nerror=${String(details)}`);
        emitSafe('sync:failure', { action: 'user-delete', error: details });
        return;
      }

      // verification
      try { await getUser(token, user.id, 'id'); log.warn({}, '[DELETE] verification: user still resolvable'); }
      catch (e) { if (e?.response?.status === 404) log.info({}, '[DELETE] verification: user not resolvable (404)'); else log.warn({ err: e?.response?.data || e?.message || String(e) }, '[DELETE] verify read failed'); }
      try { const inBin = await getDeletedUser(token, user.id); log.info({ present: !!inBin }, '[DELETE] deleted items check'); }
      catch (e) { log.warn({ err: e?.response?.data || e?.message || String(e) }, '[DELETE] deleted items check failed'); }

      markJob(job.id, { status: 'done' });
      await mailSuccess('DELETE completed', `jobId=${job.id}\nuserId=${user.id}\nupn=${user.userPrincipalName}`);
      emitSafe('sync:success', { action: 'user-delete', upn: user.userPrincipalName, employee_id: user.employeeId });
      return;
    } catch (e) {
      const details = e?.response?.data || e?.message || String(e);
      log.error({ details }, '[DELETE] failed');
      markJob(job.id, { status: 'failed', lastError: details });
      await mailFailure('DELETE failed', `jobId=${job.id}\nerror=${String(details)}`);
      emitSafe('sync:failure', { action: 'user-delete', error: details });
      return;
    }
  }

  // -------------------------------- DISABLE ---------------------------------
  if (type === 'disableuser') {
    try {
      const { employeeId, email, upn } = payload || {};
      log.info({ employeeId, hasEmail: !!email, hasUpn: !!upn }, '[DISABLE] payload summary');

      const token = await getAzureAccessToken();

      let user = null;
      if (employeeId) { try { user = await findByEmployeeId(token, String(employeeId).trim()); } catch (e) { } }
      if (!user && email) { try { user = await findByEmail(token, String(email).trim()); } catch (e) { } }
      if (!user && upn) { try { user = await findUserByUPN(token, String(upn).trim()); } catch (e) { } }

      if (!user) {
        log.warn({}, '[DISABLE] user not found');
        markJob(job.id, { status: 'failed', lastError: 'User not found for disable' });
        await mailFailure('DISABLE failed: user not found', `jobId=${job.id}\nemployeeId=${employeeId || ''}\nemail=${email || ''}\nupn=${upn || ''}`);
        emitSafe('sync:failure', { action: 'user-disable', error: 'not-found' });
        return;
      }

      await updateUser(token, user.id, { accountEnabled: false });
      log.info({ userId: user.id, upn: user.userPrincipalName }, '[DISABLE] user disabled');

      markJob(job.id, { status: 'done' });
      await mailSuccess('DISABLE completed', `jobId=${job.id}\nuserId=${user.id}\nupn=${user.userPrincipalName}`);
      emitSafe('sync:success', { action: 'user-disable', upn: user.userPrincipalName, employee_id: user.employeeId });
      return;
    } catch (e) {
      const details = e?.response?.data || e?.message || String(e);
      log.error({ details }, '[DISABLE] failed');
      markJob(job.id, { status: 'failed', lastError: details });
      await mailFailure('DISABLE failed', `jobId=${job.id}\nerror=${String(details)}`);
      emitSafe('sync:failure', { action: 'user-disable', error: details });
      return;
    }
  }

  // ------------------------------ UNKNOWN TYPE ------------------------------
  const msg = `Unknown job type: ${job.type}`;
  log.warn({ type: job.type }, '[EXEC] unknown job type');
  markJob(job.id, { status: 'failed', lastError: msg });
  await mailFailure('JOB failed: unknown type', `jobId=${job.id}\ntype=${String(job.type)}`);
}

/* --------------------------------- server ---------------------------------- */

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
    const payload = getSafeErrorPayload(e);
    log.error({ url: req.originalUrl, status: payload.status, code: payload.code, details: payload.details }, '[HTTP] error');
    res.status(payload.status || 500).json(payload);
  });
  return app;
}

async function bootstrap() {
  // Azure env summary (masked)
  log.info(
    {
      tenant: mask(process.env.AZURE_TENANT_ID),
      clientId: mask(process.env.AZURE_CLIENT_ID),
      secretSet: !!process.env.AZURE_CLIENT_SECRET
    },
    '[BOOT] Azure environment'
  );

  process.on('unhandledRejection', (r) => console.error('[FATAL] unhandledRejection', r));
  process.on('uncaughtException', (e) => console.error('[FATAL] uncaughtException', e));

  try {
    if (bus && typeof require('./core/bus').initBus === 'function') {
      require('./core/bus').initBus();
      log.info({}, '[BOOT] bus initialized');
    }
  } catch (e) {
    log.warn({ err: e && (e.message || String(e)) }, '[BOOT] bus init failed');
  }

  await initSQLite();

  const app = buildApp();
  const port = getInt('PORT', 3008);
  app.listen(port, '0.0.0.0', () => log.info({ url: `http://0.0.0.0:${port}` }, '[BOOT] server listening'));

  // start scheduler
  try {
    tickRunner(executor);
    log.info({}, '[BOOT] scheduler started');
  } catch (e) {
    log.error({ err: e && (e.message || String(e)) }, '[BOOT] scheduler failed to start');
  }
}

bootstrap();
