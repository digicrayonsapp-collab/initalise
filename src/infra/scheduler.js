'use strict';

const { fetchDueJobs, markJob } = require('./sqlite');
const { log } = require('../core/logger');

function safeMark(id, fields) {
  try { markJob(id, fields); }
  catch (e) { log.error({ id, err: e.message }, '[scheduler] markJob failed'); }
}

function runJob(executor, job) {
  safeMark(job.id, { status: 'running', attempts: (job.attempts || 0) + 1, lastError: null });
  Promise.resolve(executor(job)).catch((e) => {
    let errText = e?.response?.data ?? e?.stack ?? e?.message ?? String(e);
    if (typeof errText !== 'string') {
      try { errText = JSON.stringify(errText); } catch { errText = String(e); }
    }
    if (errText.length > 8000) errText = errText.slice(0, 8000);
    safeMark(job.id, { status: 'failed', lastError: errText });
  });
}

function tickRunner(executor) {
  const INTERVAL_MS = parseInt(process.env.SCHED_INTERVAL_MS || '5000', 10);
  let ticking = false;

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const now = Date.now();
      const due = fetchDueJobs(now);
      if (due.length) log.info({ count: due.length, ts: new Date(now).toISOString() }, '[scheduler] due jobs');
      for (const job of due) {
        try {
          log.info({ id: job.id, type: job.type, runAt: new Date(job.runAt).toISOString() }, '[scheduler] dispatch');
          runJob(executor, job);
        } catch (err) {
          const msg = err?.response?.data || err?.message || String(err);
          log.error({ id: job.id, type: job.type, err: msg }, '[scheduler] executor failed');
          safeMark(job.id, { status: 'failed', lastError: msg });
        }
      }
    } catch (e) {
      log.error({ err: e?.message || e }, '[scheduler] tick error');
    } finally {
      ticking = false;
    }
  }

  setInterval(tick, INTERVAL_MS);
  tick();
}

module.exports = { tickRunner };
