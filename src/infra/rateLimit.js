'use strict';

/**
 * Lightweight rate limiter.
 *
 * Default mode: fixed-interval between task starts (previous behavior).
 *   const run = makeRateLimiter(60); // 60 ops/min, ~1 per second
 *   await run(() => doSomething());
 *
 * Options:
 *   - mode: 'interval' | 'token-bucket' (default: 'interval')
 *   - burst: number (token-bucket capacity; default: 1)
 *   - jitterMs: number (add +/- jitter to waits; default: 0)
 *
 * Extras:
 *   - Abort per call: await run(task, signal)
 */

function clamp(n, min, max) {
  return Math.min(Math.max(n, min), max);
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function sleep(ms, signal) {
  if (!isFiniteNumber(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(new Error('aborted'));
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(t);
        signal.removeEventListener('abort', onAbort);
        reject(new Error('aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function jittered(waitMs, jitterMs) {
  if (!isFiniteNumber(waitMs) || waitMs <= 0) return 0;
  const j = Math.max(0, jitterMs || 0);
  if (!j) return Math.max(0, Math.round(waitMs));
  const delta = (Math.random() * 2 - 1) * j; // [-j, +j]
  const w = waitMs + delta;
  return Math.max(0, Math.round(w));
}

/**
 * Factory
 * @param {number} perMinute - allowed operations per minute (>0). If falsy/<=0, limiter is a no-op.
 * @param {Object} [opts]
 * @param {'interval'|'token-bucket'} [opts.mode='interval']
 * @param {number} [opts.burst=1] - token-bucket capacity (>=1)
 * @param {number} [opts.jitterMs=0] - +/- jitter applied to waits
 * @returns {(fn:Function, signal?:AbortSignal)=>Promise<any>}
 */
function makeRateLimiter(perMinute, opts) {
  const rate = Number(perMinute);
  if (!isFiniteNumber(rate) || rate <= 0) {
    return async function run(fn) { return fn(); };
  }

  const mode = (opts && opts.mode) === 'token-bucket' ? 'token-bucket' : 'interval';
  const jitterMs = opts && isFiniteNumber(opts.jitterMs) ? Math.max(0, opts.jitterMs) : 0;

  if (mode === 'interval') {
    const interval = 60000 / rate; // ms between task starts
    let last = 0;

    /**
     * Ensures at least `interval` ms between task START times.
     * @param {Function} fn - sync or async function
     * @param {AbortSignal} [signal]
     */
    return async function run(fn, signal) {
      const now = Date.now();
      const baseWait = Math.max(0, last + interval - now);
      const wait = jittered(baseWait, jitterMs);
      last = now + baseWait; // reserve slot deterministically (before await)
      if (wait) await sleep(wait, signal);
      return fn();
    };
  }

  // token-bucket mode (burst-friendly)
  const capacity = clamp(Math.floor((opts && opts.burst) || 1), 1, 10_000);
  const refillPerMs = rate / 60000; // tokens/ms

  let tokens = capacity;           // start full
  let lastRefill = Date.now();

  function refill(now) {
    const dt = Math.max(0, now - lastRefill);
    if (dt <= 0) return;
    tokens = Math.min(capacity, tokens + dt * refillPerMs);
    lastRefill = now;
  }

  /**
   * Token-bucket runner: executes immediately if a token is available;
   * otherwise waits until the next token refills.
   * @param {Function} fn
   * @param {AbortSignal} [signal]
   */
  return async function run(fn, signal) {
    const now = Date.now();
    refill(now);

    if (tokens >= 1) {
      tokens -= 1;
      return fn();
    }

    const needed = 1 - tokens;
    const waitMs = needed / refillPerMs; // time to get to one full token
    const wait = jittered(waitMs, jitterMs);
    await sleep(wait, signal);

    // After wait, try again (single-shot, no loop to keep semantics simple)
    const now2 = Date.now();
    refill(now2);
    if (tokens < 1) {
      // extremely rare: timing precision; wait minimally
      const tiny = Math.ceil((1 - tokens) / refillPerMs);
      await sleep(jittered(tiny, jitterMs), signal);
      refill(Date.now());
    }
    tokens = Math.max(0, tokens - 1);
    return fn();
  };
}

module.exports = { makeRateLimiter };
