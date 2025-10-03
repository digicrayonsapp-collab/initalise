// src/infra/scheduler.js
const { fetchDueJobs, markJob } = require("./sqlite");
const { log } = require("../core/logger");

const TICK_MS = 1000;

function safeMark(id, fields) {
  try { markJob(id, fields); }
  catch (e) { log.error("markJob failed:", e.message); }
}

function runJob(executor, job) {
  safeMark(job.id, { status: "running", attempts: (job.attempts || 0) + 1, lastError: null });

  Promise.resolve(executor(job)).catch((e) => {
    let errText = e?.response?.data ?? e?.stack ?? e?.message ?? String(e);
    if (typeof errText !== 'string') {
      try { errText = JSON.stringify(errText); } catch { errText = String(e); }
    }
    if (errText.length > 8000) errText = errText.slice(0, 8000);
    safeMark(job.id, { status: "failed", lastError: errText });
  });
}

function tickRunner(executor) {
  const INTERVAL_MS = parseInt(process.env.SCHED_INTERVAL_MS || "5000", 10); // tick every 5s
  let ticking = false;

  async function tick() {
    if (ticking) return;
    ticking = true;

    try {
      const now = Date.now();
      const due = fetchDueJobs(now); // returns ALL types: createFromCandidate, deleteUser, disableUser, etc.

      if (due.length) {
        log.info(`⏰ Scheduler: found ${due.length} due job(s) at ${new Date(now).toISOString()}`);
      }

      for (const job of due) {
        try {
          log.info(`⏩ Dispatching job ${job.id} [${job.type}] scheduledAt=${new Date(job.runAt).toISOString()}`);
          runJob(executor, job); 
        } catch (err) {
          const msg = err?.response?.data || err?.message || String(err);
          log.error(`❌ Executor failed for job ${job.id} [${job.type}]:`, msg);
          safeMark(job.id, { status: "failed", lastError: msg });
        }
      }
    } catch (e) {
      log.error("❌ tickRunner error:", e?.message || e);
    } finally {
      ticking = false;
    }
  }

  setInterval(tick, INTERVAL_MS);
  tick(); // run once immediately on boot
}


module.exports = { tickRunner };
