// src/utils/dates.js
const { DateTime } = require('luxon');


function parseJoinDate(input, zone = process.env.TZ || 'Asia/Kolkata') {
  if (!input) return null;

  let dt = DateTime.fromFormat(String(input).trim(), 'dd-LL-yyyy', { zone });
  if (dt.isValid) return dt;

  // Try ISO
  dt = DateTime.fromISO(String(input).trim(), { zone });
  return dt.isValid ? dt : null;
}


function computeRunAtFromJoin(joinDt, offsetDays) {
  const zone = process.env.TZ || 'Asia/Kolkata';

  const hour = Number.isFinite(parseInt(process.env.PREHIRE_EXEC_HOUR,10))
    ? parseInt(process.env.PREHIRE_EXEC_HOUR,10) : 9;
  const minute = Number.isFinite(parseInt(process.env.PREHIRE_EXEC_MIN,10))
    ? parseInt(process.env.PREHIRE_EXEC_MIN,10) : 0;

  const when = joinDt
    .minus({ days: offsetDays })
    .set({ hour, minute, second: 0, millisecond: 0 });

  return when.setZone('utc').toJSDate();
}

module.exports = { parseJoinDate, computeRunAtFromJoin };
