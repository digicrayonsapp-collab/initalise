'use strict';

// src/utils/dates.js
const { DateTime } = require('luxon');

/**
 * Try multiple common date formats used by Zoho payloads.
 * Priority: dd-LL-yyyy → dd/LL/yyyy → ISO.
 */
function parseJoinDate(input, zone = process.env.TZ || 'Asia/Kolkata') {
  if (input == null || input === '') return null;

  const s = String(input).trim();
  const candidates = [
    'dd-LL-yyyy',
    'd-L-yyyy',
    'dd/LL/yyyy',
    'd/L/yyyy',
    'yyyy-LL-dd',     // occasionally seen
  ];

  for (const fmt of candidates) {
    const dt = DateTime.fromFormat(s, fmt, { zone });
    if (dt.isValid) return dt;
  }

  // ISO fallback
  const iso = DateTime.fromISO(s, { zone });
  return iso.isValid ? iso : null;
}

/**
 * Compute the UTC Date to run a prehire job:
 *   runAt = (joinDt - offsetDays) @ PREHIRE_EXEC_HOUR:PREHIRE_EXEC_MIN (local TZ)
 *
 * @param {DateTime|string} joinDt  Luxon DateTime or string date. String will be parsed.
 * @param {number} offsetDays       Days to subtract from join date (clamped to >= 0).
 * @returns {Date|null}             JS Date in UTC, or null if joinDt invalid.
 */
function computeRunAtFromJoin(joinDt, offsetDays) {
  const zone = process.env.TZ || 'Asia/Kolkata';

  // Normalize joinDt to a valid DateTime
  let join = joinDt;
  if (!join || typeof join.minus !== 'function' || !join.isValid) {
    join = parseJoinDate(joinDt, zone);
  }
  if (!join || !join.isValid) return null;

  // Read exec time with sane defaults + clamping
  let hour = Number.parseInt(process.env.PREHIRE_EXEC_HOUR, 10);
  let minute = Number.parseInt(process.env.PREHIRE_EXEC_MIN, 10);
  hour = Number.isFinite(hour) ? Math.min(Math.max(hour, 0), 23) : 9;
  minute = Number.isFinite(minute) ? Math.min(Math.max(minute, 0), 59) : 0;

  const days = Number.isFinite(+offsetDays) ? Math.max(0, +offsetDays) : 0;

  const whenLocal = join
    .minus({ days })
    .set({ hour, minute, second: 0, millisecond: 0 });

  // Return an absolute moment in time (UTC)
  return whenLocal.toUTC().toJSDate();
}

module.exports = { parseJoinDate, computeRunAtFromJoin };
