'use strict';

const nodemailer = require('nodemailer');
const { env, emailEnabled } = require('./env');

let transporter = null;
let verifiedOnce = false;
let verifying = false;

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

async function verifyEmailTransport() {
  try {
    if (verifiedOnce || verifying) return;
    if (!emailEnabled()) {
      const reason = env.EMAIL_MODE === 'off'
        ? 'EMAIL_MODE=off'
        : 'missing SMTP config (host/user/pass)';
      console.warn('[email:disabled]', reason);
      verifiedOnce = true; // avoid repeating
      return;
    }
    const tx = ensureTransport();
    if (!tx) return; // already logged above
    verifying = true;
    await tx.verify();
    console.log('[email:ok]', `SMTP verified host=${env.EMAIL_SMTP_HOST} port=${env.EMAIL_SMTP_PORT} secure=${!!env.EMAIL_SMTP_SECURE}`);
  } catch (err) {
    console.warn('[email:verify_failed]', (err && err.message) || String(err));
  } finally {
    verifying = false;
    verifiedOnce = true;
  }
}

async function sendMail(spec) {
  try {
    const tx = ensureTransport();
    if (!tx) return;

    const to = (Array.isArray(spec.to) ? spec.to : String(spec.to || ''))
      .split(',').map(s => s.trim()).filter(Boolean);
    if (!to.length) return;

    const subject = (env.EMAIL_SUBJECT_PREFIX + ' ' + (spec.subject || '')).trim();
    await tx.sendMail({
      from: env.EMAIL_FROM,
      to: to.join(','),
      subject,
      text: spec.text || '',
      html: spec.html || undefined
    });
  } catch (err) {
    console.error('[email:error]', (err && err.message) || String(err));
  }
}

async function sendSuccessMail({ subject, text, html, to }) {
  return sendMail({ to: to || env.EMAIL_TO_SUCCESS, subject, text, html });
}
async function sendFailureMail({ subject, text, html, to }) {
  return sendMail({ to: to || env.EMAIL_TO_FAILURE, subject, text, html });
}

module.exports = { sendMail, sendSuccessMail, sendFailureMail, verifyEmailTransport };
