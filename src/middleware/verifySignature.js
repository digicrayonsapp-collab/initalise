'use strict';

const crypto = require('crypto');
const { log } = require('../core/logger');

function timingSafeEq(a, b) {
  const ba = Buffer.isBuffer(a) ? a : Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.isBuffer(b) ? b : Buffer.from(String(b || ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function parseWebhookSignature(header) {
  // format: "t=1696420000,v1=abcdef..."
  const parts = String(header || '').split(',').map(s => s.trim());
  const map = {};
  for (const p of parts) {
    const [k, v] = p.split('=');
    if (k && v) map[k] = v;
  }
  return map.t && map.v1 ? { t: parseInt(map.t, 10), v1: map.v1 } : null;
}

function hmacHex(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}
function hmacB64(secret, payload) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64');
}

function getSecrets() {
  const raw = process.env.WEBHOOK_SECRET || process.env.ZOHO_WEBHOOK_SECRET || '';
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

function verifyV1Style(rawBody, header) {
  const parsed = parseWebhookSignature(header);
  if (!parsed) return false;

  const { t, v1 } = parsed;
  if (!Number.isFinite(t)) return false;

  const tolSecRaw = parseInt(process.env.WEBHOOK_TOLERANCE_SEC, 10);
  const tolSec = Number.isFinite(tolSecRaw) ? tolSecRaw : 300;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > tolSec) return false;

  const secrets = getSecrets();
  if (!secrets.length) return true; // allow if not configured

  const payloadToSign = Buffer.concat([
    Buffer.from(String(t)),
    Buffer.from('.'),
    Buffer.from(rawBody || '')
  ]);

  for (const sec of secrets) {
    const hex = hmacHex(sec, payloadToSign);
    if (timingSafeEq(hex, v1)) return true;
  }
  return false;
}

function verifyZohoHeader(rawBody, header) {
  if (!header) return false;
  const secrets = getSecrets();
  if (!secrets.length) return true;

  for (const sec of secrets) {
    const hex = hmacHex(sec, rawBody || '');
    const b64 = hmacB64(sec, rawBody || '');
    if (timingSafeEq(hex, header) || timingSafeEq(b64, header)) return true;
  }
  return false;
}

function verifySignature(req, res, next) {
  try {
    const secrets = getSecrets();
    const requireAuth = String(process.env.REQUIRE_WEBHOOK_AUTH || '').toLowerCase() === 'true';

    const raw = req.rawBody || Buffer.from('');
    const h1 = req.get('x-webhook-signature');
    const hZoho = req.get('x-zoho-signature');

    if (!secrets.length) {
      if (requireAuth) return res.status(401).json({ message: 'webhook auth not configured' });
      log.warn('[auth] webhook secret not configured; requests are not authenticated');
      return next();
    }

    const okV1 = h1 && verifyV1Style(raw, h1);
    const okZoho = !okV1 && hZoho && verifyZohoHeader(raw, hZoho);

    if (okV1 || okZoho) return next();

    return res.status(401).json({ message: 'invalid webhook signature' });
  } catch (e) {
    return res.status(401).json({ message: 'webhook signature verification error' });
  }
}

module.exports = { verifySignature };
