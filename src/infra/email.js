'use strict';

const nodemailer = require('nodemailer');
const { env, emailEnabled } = require('./env');

let transporter = null;

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
    maxMessages: 100
  });
  return transporter;
}

function redact(s) {
  if (!env.EMAIL_HIDE_PII) return s;
  try {
    let t = String(s || '');
    t = t.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]');
    t = t.replace(/\b[0-9]{10,}\b/g, '[num]');
    t = t.replace(/eyJ[A-Za-z0-9._-]{20,}/g, '[token]');
    return t;
  } catch {
    return s;
  }
}

async function sendMail(spec) {
  try {
    const tx = ensureTransport();
    if (!tx) return;
    const to = (Array.isArray(spec.to) ? spec.to : String(spec.to || ''))
      .split(',').map((s) => s.trim()).filter(Boolean);
    if (!to.length) return;
    const subject = (env.EMAIL_SUBJECT_PREFIX + ' ' + (spec.subject || '')).trim();
    await tx.sendMail({
      from: env.EMAIL_FROM,
      to: to.join(','),
      subject,
      text: redact(spec.text || ''),
      html: spec.html ? redact(spec.html) : undefined
    });
  } catch (err) {
    // do not throw from email path
    console.error('[email:error]', (err && err.message) || String(err));
  }
}

async function sendSuccessMail({ subject, text, html }) {
  if (env.EMAIL_MODE === 'off') return;
  if (env.EMAIL_MODE === 'summary') return; // event mails off
  if (!env.EMAIL_TO_SUCCESS) return;
  await sendMail({ to: env.EMAIL_TO_SUCCESS, subject: subject || 'Success', text, html });
}

async function sendFailureMail({ subject, text, html }) {
  if (env.EMAIL_MODE === 'off') return;
  if (env.EMAIL_MODE === 'summary') return; // event mails off
  const to = env.EMAIL_TO_FAILURE || env.EMAIL_TO_SUCCESS || env.EMAIL_TO_SUMMARY;
  if (!to) return;
  await sendMail({ to, subject: subject || 'Failure', text, html });
}

module.exports = { sendMail, sendSuccessMail, sendFailureMail };
