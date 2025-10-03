'use strict';

function makeRateLimiter(perMinute) {
  if (!perMinute || perMinute <= 0) {
    return async function run(fn) { return fn(); };
  }
  const interval = 60000 / perMinute;
  let last = 0;
  return async function run(fn) {
    const now = Date.now();
    const wait = Math.max(0, last + interval - now);
    last = now + wait;
    if (wait) await new Promise(r => setTimeout(r, wait));
    return fn();
  };
}

module.exports = { makeRateLimiter };
