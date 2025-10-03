'use strict';

// light, fail-soft env loader (won't crash your existing app)
function readBool(v, def) {
    if (v === undefined || v === null || v === '') return !!def;
    const s = String(v).toLowerCase();
    return s === '1' || s === 'true' || s === 'yes';
}
function readInt(v, def) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : def;
}

const env = {
    EMAIL_MODE: process.env.EMAIL_MODE || 'event', // event|summary|both|off
    EMAIL_SUBJECT_PREFIX: process.env.EMAIL_SUBJECT_PREFIX || '[Zoho-Azure Sync]',

    EMAIL_SMTP_HOST: process.env.EMAIL_SMTP_HOST || '',
    EMAIL_SMTP_PORT: readInt(process.env.EMAIL_SMTP_PORT, 587),
    EMAIL_SMTP_SECURE: readBool(process.env.EMAIL_SMTP_SECURE, false),
    EMAIL_SMTP_USER: process.env.EMAIL_SMTP_USER || '',
    EMAIL_SMTP_PASS: process.env.EMAIL_SMTP_PASS || '',

    EMAIL_FROM: process.env.EMAIL_FROM || 'sync@example.com',
    EMAIL_TO_SUCCESS: (process.env.EMAIL_TO_SUCCESS || '').trim(),
    EMAIL_TO_FAILURE: (process.env.EMAIL_TO_FAILURE || '').trim(),
    EMAIL_TO_SUMMARY: (process.env.EMAIL_TO_SUMMARY || '').trim(),

    EMAIL_RATE_PER_MINUTE: readInt(process.env.EMAIL_RATE_PER_MINUTE, 120),
    EMAIL_HIDE_PII: readBool(process.env.EMAIL_HIDE_PII, true),
};

function emailEnabled() {
    if (env.EMAIL_MODE === 'off') return false;
    // only require smtp config if enabled
    return !!(env.EMAIL_SMTP_HOST && env.EMAIL_SMTP_USER && env.EMAIL_SMTP_PASS);
}

module.exports = { env, emailEnabled };
