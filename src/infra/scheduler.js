'use strict';

// src/infra/scheduler.js
const { fetchDueJobs, markJob } = require('./sqlite');
const { log } = require('../core/logger');

const INTERVAL_MS = Number.parseInt(process.env.SCHED_INTERVAL_MS || '5000', 10); // poll every 5s
const MAX_CONCURRENCY = Number.parseInt(process.env.SCHED_MAX_CONCURRENCY || '4', 10);

const MAX_ATTEMPTS = Number.parseInt(process.env.SCHED_MAX_ATTEMPTS || '3', 10);      // total attempts
const BACKOFF_BASE_MS = Number.parseInt(process.env.SCHED_BACKOFF_MS || '15000', 10); // initial backoff
const BACKOFF_MULT = Number.parseFloat(process.env.SCHED_BACKOFF_MULT || '2.0');      // exponential factor
const BACKOFF_JITTER = Number.parseFloat(process.env.SCHED_BACKOFF_JITTER || '0.20'); // +/-20%

function safeMark(id, fields) {
  try { markJob(id, fields); }
  catch (e) { log.error({ jobId: id, err: e?.message || String(e) }, '[SCHED] markJob failed'); }
}

function clip(str, n = 8000) {
  try {
    const s = typeof str === 'string' ? str : JSON.stringify(str);
    return s.length > n ? s.slice(0, n) : s;
  } catch {
    const s = String(str);
    return s.length > n ? s.slice(0, n) : s;
  }
}

function computeBackoffMs(attempt) {
  // attempt is 1-based
  const exp = Math.max(0, attempt - 1);
  const base = BACKOFF_BASE_MS * Math.pow(BACKOFF_MULT, exp);
  const jitterFrac = Math.max(0, Math.min(1, BACKOFF_JITTER));
  const jitter = base * jitterFrac * (Math.random() * 2 - 1); // uniform in [-jitter, +jitter]
  return Math.max(1000, Math.round(base + jitter));
}

async function runJob(executor, job) {
  const attemptsNew = (job.attempts || 0) + 1;
  safeMark(job.id, { status: 'running', attempts: attemptsNew, lastError: null });

  try {
    await Promise.resolve(executor(job));

    // If the executor didn't set terminal status, mark as done.
    safeMark(job.id, { status: 'done' });
    log.info(
      { jobId: job.id, type: job.type, attempts: attemptsNew },
      '[SCHED] job completed'
    );
  } catch (e) {
    const errText =
      e?.response?.data ?? e?.stack ?? e?.message ?? String(e);
    const clipped = clip(errText);

    if (attemptsNew < MAX_ATTEMPTS) {
      const delay = computeBackoffMs(attemptsNew);
      const nextRun = Date.now() + delay;

      safeMark(job.id, {
        status: 'pending',
        runAt: nextRun,
        lastError: clipped,
        attempts: attemptsNew
      });

      log.warn(
        { jobId: job.id, type: job.type, attempts: attemptsNew, nextRunAt: new Date(nextRun).toISOString() },
        '[SCHED] job retry scheduled'
      );
    } else {
      safeMark(job.id, { status: 'failed', lastError: clipped });
      log.error(
        { jobId: job.id, type: job.type, attempts: attemptsNew },
        '[SCHED] job failed (max attempts reached)'
      );
    }
  }
}

function tickRunner(executor) {
  const running = new Set();   // jobIds currently executing
  let ticking = false;

  async function tick() {
    if (ticking) return;
    ticking = true;

    try {
      const now = Date.now();
      const due = fetchDueJobs(now); // pending only

      if (due.length) {
        log.info(
          { count: due.length, now: new Date(now).toISOString() },
          '[SCHED] due jobs fetched'
        );
      }

      for (const job of due) {
        if (running.size >= MAX_CONCURRENCY) break;
        if (running.has(job.id)) continue; // guard (shouldn’t happen)

        running.add(job.id);

        // fire and detach; we still await per job to contain errors and free the slot
        runJob(executor, job)
          .catch((e) => {
            // defensive catch (runJob already catches); log just in case
            log.error(
              { jobId: job.id, type: job.type, err: e?.message || String(e) },
              '[SCHED] unexpected runJob error'
            );
          })
          .finally(() => {
            running.delete(job.id);
          });
      }
    } catch (e) {
      log.error({ err: e?.message || String(e) }, '[SCHED] tick error');
    } finally {
      ticking = false;
    }
  }

  setInterval(tick, Math.max(1000, INTERVAL_MS));
  tick(); // immediate kick
}

module.exports = { tickRunner };
