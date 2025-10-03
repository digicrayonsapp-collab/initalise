'use strict';

// src/infra/env.js
// Lightweight, fail-soft email env loader.
// No external logger here to avoid dependency loops.

require('dotenv').config();

function readBool(v, def) {
    if (v === undefined || v === null || v === '') return !!def;
    const s = String(v).trim().toLowerCase();
    if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
    if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
    return !!def;
}

function readInt(v, def) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : def;
}

function readList(v) {
    if (!v) return [];
    return String(v)
        .split(/[;,]/g)
        .map(s => s.trim())
        .filter(Boolean)
        .filter((x, i, a) => a.indexOf(x) === i); // dedupe
}

function clampMode(v) {
    const m = String(v || '').trim().toLowerCase();
    return ['event', 'summary', 'both', 'off'].includes(m) ? m : 'event';
}

const env = {
    // Mode: event -> fire per event; summary -> only digests; both -> both; off -> disabled
    EMAIL_MODE: clampMode(process.env.EMAIL_MODE),

    EMAIL_SUBJECT_PREFIX: process.env.EMAIL_SUBJECT_PREFIX || '[Zoho-Azure Sync]',

    EMAIL_SMTP_HOST: process.env.EMAIL_SMTP_HOST || '',
    EMAIL_SMTP_PORT: readInt(process.env.EMAIL_SMTP_PORT, 587),
    EMAIL_SMTP_SECURE: readBool(process.env.EMAIL_SMTP_SECURE, false), // true = use TLS from start
    EMAIL_SMTP_USER: process.env.EMAIL_SMTP_USER || '',
    EMAIL_SMTP_PASS: process.env.EMAIL_SMTP_PASS || '',

    // Optional transport knobs
    EMAIL_SMTP_TIMEOUT_MS: readInt(process.env.EMAIL_SMTP_TIMEOUT_MS, 20000),
    EMAIL_SMTP_TLS_REJECT_UNAUTH: readBool(process.env.EMAIL_SMTP_TLS_REJECT_UNAUTH, true),

    // From/To
    EMAIL_FROM: process.env.EMAIL_FROM || 'sync@example.com',

    // Raw strings (kept for backward compatibility)
    EMAIL_TO_SUCCESS: (process.env.EMAIL_TO_SUCCESS || '').trim(),
    EMAIL_TO_FAILURE: (process.env.EMAIL_TO_FAILURE || '').trim(),
    EMAIL_TO_SUMMARY: (process.env.EMAIL_TO_SUMMARY || '').trim(),

    // Parsed lists (new, non-breaking convenience)
    EMAIL_TO_SUCCESS_LIST: readList(process.env.EMAIL_TO_SUCCESS),
    EMAIL_TO_FAILURE_LIST: readList(process.env.EMAIL_TO_FAILURE),
    EMAIL_TO_SUMMARY_LIST: readList(process.env.EMAIL_TO_SUMMARY),

    // Rate limiting + privacy
    EMAIL_RATE_PER_MINUTE: readInt(process.env.EMAIL_RATE_PER_MINUTE, 120),
    EMAIL_HIDE_PII: readBool(process.env.EMAIL_HIDE_PII, true)
};

/**
 * Returns true if email sending is enabled and minimally configured.
 * Does not throw. Safe to call at startup.
 */
function emailEnabled() {
    if (env.EMAIL_MODE === 'off') return false;
    // Minimal SMTP config for nodemailer SMTP transport
    const ok =
        !!env.EMAIL_SMTP_HOST &&
        !!env.EMAIL_SMTP_USER &&
        !!env.EMAIL_SMTP_PASS &&
        Number.isFinite(env.EMAIL_SMTP_PORT);

    return ok;
}

module.exports = { env, emailEnabled };
