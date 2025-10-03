'use strict';

const { env } = require('../infra/env');
const { sendMail } = require('../infra/email');
const { makeRateLimiter } = require('../infra/rateLimit');

const limit = makeRateLimiter(env.EMAIL_RATE_PER_MINUTE);

function mask(s) {
    if (!s || !env.EMAIL_HIDE_PII) return s || '';
    return String(s)
        .replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@|$)/g, '$1***$2')
        .replace(/\d(?=\d{2,})/g, '*');
}

function escapeHtml(s) {
    return String(s).replace(/[&<>\"']/g, function (c) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]);
    });
}

async function notifySuccess(ev) {
    if (env.EMAIL_MODE === 'summary' || env.EMAIL_MODE === 'off') return;
    const to = (env.EMAIL_TO_SUCCESS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!to.length) return;
    const subject = 'SUCCESS ' + (ev.action || '').toUpperCase() + ' ' + (ev.upn || ev.employee_id || '');
    const body = [
        'Action: ' + (ev.action || ''),
        'Employee: ' + (ev.employee_id == null ? '-' : ev.employee_id),
        'UPN: ' + mask(ev.upn),
        ev.details ? 'Details: ' + JSON.stringify(ev.details) : null
    ].filter(Boolean).join('\n');
    await limit(() => sendMail({ to, subject, text: body, html: '<pre>' + escapeHtml(body) + '</pre>' }));
}

async function notifyFailure(ev) {
    if (env.EMAIL_MODE === 'summary' || env.EMAIL_MODE === 'off') return;
    const to = (env.EMAIL_TO_FAILURE || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!to.length) return;
    const err = ev && ev.error ? (ev.error.message || String(ev.error)) : '';
    const subject = 'FAIL ' + (ev.upn || ev.employee_id || '') + ' :: ' + (ev.action || '').toUpperCase();
    const body = [
        'Action: ' + (ev.action || ''),
        'Employee: ' + (ev.employee_id == null ? '-' : ev.employee_id),
        'UPN: ' + mask(ev.upn),
        'Error: ' + err,
        ev.details ? 'Details: ' + JSON.stringify(ev.details) : null
    ].filter(Boolean).join('\n');
    await limit(() => sendMail({ to, subject, text: body, html: '<pre>' + escapeHtml(body) + '</pre>' }));
}

async function notifySummary(stats) {
    if (env.EMAIL_MODE === 'event' || env.EMAIL_MODE === 'off') return;
    const to = (env.EMAIL_TO_SUMMARY || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!to.length) return;
    const subject = 'SUMMARY scanned=' + stats.scanned + ' touched=' + stats.touched + ' dryRun=' + (!!stats.dryRun);
    const failLines = (stats.failures || []).slice(0, 100).map(function (f) {
        return '- ' + (mask(f.upn) || f.employee_id || '-') + ' :: ' + f.error;
    }).join('\n');
    const body = [
        'Started: ' + stats.startedAtISO,
        'Ended:   ' + stats.endedAtISO,
        'DryRun:  ' + (!!stats.dryRun),
        'Scanned: ' + stats.scanned,
        'Touched: ' + stats.touched,
        'Failures (' + (stats.failures ? stats.failures.length : 0) + '):',
        failLines || '- none -'
    ].join('\n');
    await sendMail({ to, subject, text: body, html: '<pre>' + escapeHtml(body) + '</pre>' });
}

module.exports = { notifySuccess, notifyFailure, notifySummary };
