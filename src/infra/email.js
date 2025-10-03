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

async function sendMail(spec) {
    try {
        const tx = ensureTransport();
        if (!tx) return; // mail disabled or not configured
        const to = (Array.isArray(spec.to) ? spec.to : String(spec.to || '')).split(',')
            .map(s => s.trim()).filter(Boolean);
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
        // swallow: email issues must not break sync
        console.error('[email:error]', (err && err.message) || String(err));
    }
}

module.exports = { sendMail };
