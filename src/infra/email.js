'use strict';

// src/infra/email.js
const nodemailer = require('nodemailer');
const { env, emailEnabled } = require('./env');
const { makeRateLimiter } = require('../utils/ratelimit');

let transporter = null;

// Rate limiter (no-op if EMAIL_RATE_PER_MINUTE <= 0)
const runLimited = makeRateLimiter(env.EMAIL_RATE_PER_MINUTE);

/* ------------------------------- utils -------------------------------- */

function maskEmail(s) {
  if (!s) return s;
  const str = String(s);
  const parts = str.split('@');
  if (parts.length !== 2) return str;
  const [local, domain] = parts;
  if (local.length <= 2) return '***@' + domain;
  return local.slice(0, 2) + '***@' + domain;
}

function maybeMaskPII(text) {
  if (!env.EMAIL_HIDE_PII || !text) return text;
  try {
    let t = String(text);

    // crude email mask
    t = t.replace(
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
      (m) => maskEmail(m)
    );

    // crude employeeId pattern (numbers of length >= 3)
    t = t.replace(/\b\d{3,}\b/g, (m) => m.slice(0, 1) + '***');

    return t;
  } catch {
    return text;
  }
}

function asList(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(Boolean).map(String);
  return String(v)
    .split(/[;,]/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

function pickRecipientsByType(type) {
  const t = String(type || 'event').toLowerCase();
  if (t === 'success') return env.EMAIL_TO_SUCCESS_LIST.length ? env.EMAIL_TO_SUCCESS_LIST : asList(env.EMAIL_TO_SUCCESS);
  if (t === 'failure') return env.EMAIL_TO_FAILURE_LIST.length ? env.EMAIL_TO_FAILURE_LIST : asList(env.EMAIL_TO_FAILURE);
  if (t === 'summary') return env.EMAIL_TO_SUMMARY_LIST.length ? env.EMAIL_TO_SUMMARY_LIST : asList(env.EMAIL_TO_SUMMARY);
  return env.EMAIL_TO_SUCCESS_LIST.length ? env.EMAIL_TO_SUCCESS_LIST : asList(env.EMAIL_TO_SUCCESS); // default to success/event list
}

function composeSubject(base) {
  const prefix = env.EMAIL_SUBJECT_PREFIX ? String(env.EMAIL_SUBJECT_PREFIX).trim() + ' ' : '';
  return (prefix + (base || '')).trim() || env.EMAIL_SUBJECT_PREFIX || 'Notification';
}

/* ------------------------------ transport ------------------------------ */

function ensureTransport() {
  if (!emailEnabled()) return null;
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: env.EMAIL_SMTP_HOST,
    port: env.EMAIL_SMTP_PORT,
    secure: !!env.EMAIL_SMTP_SECURE,
    auth: { user: env.EMAIL_SMTP_USER, pass: env.EMAIL_SMTP_PASS },
    pool: true,
    maxConnections: 5,
    maxMessages: 100,
    connectionTimeout: env.EMAIL_SMTP_TIMEOUT_MS,
    socketTimeout: env.EMAIL_SMTP_TIMEOUT_MS,
    tls: { rejectUnauthorized: !!env.EMAIL_SMTP_TLS_REJECT_UNAUTH }
  });

  // Do not throw on verify; treat as best-effort info.
  transporter.verify().catch((e) => {
    // keep this terse and professional; do not leak secrets
    console.warn('[email] transport verify failed:', (e && e.message) || String(e));
  });

  return transporter;
}

/* -------------------------------- send --------------------------------- */

/**
 * Low-level send. Swallows errors (logs locally) so mail never breaks the sync flow.
 * spec: { to, cc, bcc, subject, text, html }
 */
async function sendMail(spec) {
  try {
    const tx = ensureTransport();
    if (!tx) return; // disabled or not configured

    const to = asList(spec.to);
    if (!to.length) return;

    const cc = asList(spec.cc);
    const bcc = asList(spec.bcc);

    const subject = composeSubject(spec.subject);
    const text = maybeMaskPII(spec.text || '');
    const html = spec.html ? maybeMaskPII(spec.html) : undefined;

    await runLimited(async () => {
      await tx.sendMail({
        from: env.EMAIL_FROM,
        to: to.join(','),
        cc: cc.length ? cc.join(',') : undefined,
        bcc: bcc.length ? bcc.join(',') : undefined,
        subject,
        text,
        html
      });
    });
  } catch (err) {
    // Never throw upstream; email failures are non-blocking
    const msg = (err && err.message) || String(err);
    console.error('[email] send failed:', msg.slice(0, 400));
  }
}

/* --------------------------- convenience APIs --------------------------- */

/**
 * Event mail with automatic recipient selection by type.
 * type: 'success' | 'failure' | 'event' | 'summary'
 */
async function sendEventMail({ type = 'event', subject, text, html, to, cc, bcc }) {
  const mode = env.EMAIL_MODE; // event|summary|both|off
  if (mode === 'off') return;

  // If summary-only mode is on, skip event mails
  if (mode === 'summary') return;

  const targets = asList(to).length ? asList(to) : pickRecipientsByType(type);
  if (!targets.length) return;

  await sendMail({ to: targets, cc, bcc, subject, text, html });
}

async function sendSuccessMail(args) {
  await sendEventMail({ ...args, type: 'success' });
}

async function sendFailureMail(args) {
  await sendEventMail({ ...args, type: 'failure' });
}

async function sendSummaryMail(args) {
  const mode = env.EMAIL_MODE;
  if (mode === 'off') return;

  // If event-only mode is on, skip summary mails
  if (mode === 'event') return;

  const targets = asList(args && args.to).length ? asList(args.to) : pickRecipientsByType('summary');
  if (!targets.length) return;

  await sendMail({
    to: targets,
    cc: args && args.cc,
    bcc: args && args.bcc,
    subject: args && args.subject,
    text: args && args.text,
    html: args && args.html
  });
}

module.exports = {
  sendMail,
  sendEventMail,
  sendSuccessMail,
  sendFailureMail,
  sendSummaryMail
};
