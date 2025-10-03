const axios = require('axios');
const { getKV, setKV } = require('../infra/sqlite');
const { log } = require('../core/logger');
const { getLastEmployeeIdFromZoho } = require('./zohoPeople');

const KV_KEY = 'last_employee_id';

/** Last resort: scan Graph users ($select=employeeId) and compute max. */
async function getMaxEmployeeIdFromGraph(token) {
    let url = 'https://graph.microsoft.com/v1.0/users?$select=employeeId&$top=999';
    let maxNum = 0;

    while (url) {
        const res = await axios.get(url, { headers: { Authorization: `Bearer ${token}` } });
        const users = res.data?.value || [];
        for (const u of users) {
            const raw = (u.employeeId ?? '').toString().trim();
            if (!raw) continue;
            const m = raw.match(/\d+/);
            if (!m) continue;
            const n = parseInt(m[0], 10);
            if (Number.isFinite(n) && n > maxNum) maxNum = n;
        }
        url = res.data?.['@odata.nextLink'] || null;
    }

    return maxNum || null;
}

/**
 * Get next Employee ID with fallbacks:
 *  1) Zoho (by email alias) -> last + 1
 *  2) KV cache -> last + 1
 *  3) Graph scan -> max + 1
 * Persists the chosen "last" in KV for next time.
 */
async function getNextEmployeeIdSmart({ email, graphToken, strictZoho = false }) {
    // 1) Try Zoho
    try {
        const { fetchEmployeeByEmailAlias, extractEmployeeIdNumber } = require('./zohoPeople');
        if (email) {
            const row = await fetchEmployeeByEmailAlias({ email });
            const last = extractEmployeeIdNumber(row);
            if (Number.isFinite(last)) {
                const next = String(last + 1);
                setKV(KV_KEY, next);
                log.info(`🆔 [source=zoho] Last: ${last} → New: ${next}`);
                return next;
            }
        }
    } catch (e) {
        // fall through to cache/graph; if you want Zoho-only, throw here
        if (strictZoho) throw e;
    }

    // 2) KV cache
    const cached = getKV(KV_KEY);
    if (cached != null) {
        const base = parseInt(String(cached), 10);
        if (Number.isFinite(base)) {
            const next = String(base + 1);
            setKV(KV_KEY, next);
            log.warn(`🆔 [source=cache] ${base} → ${next} (Zoho unavailable)`);
            return next;
        }
    }

    // 3) Graph fallback
    if (graphToken) {
        const maxGraph = await getMaxEmployeeIdFromGraph(graphToken);
        if (Number.isFinite(maxGraph)) {
            const next = String(maxGraph + 1);
            setKV(KV_KEY, next);
            log.warn(`🆔 [source=graph] ${maxGraph} → ${next}`);
            return next;
        }
    }

    setKV(KV_KEY, '1');
    log.warn('🆔 [source=default] starting at 1');
    return '1';
}


module.exports = { getNextEmployeeIdSmart };
