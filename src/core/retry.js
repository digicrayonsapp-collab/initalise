'use strict';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Attach a retry interceptor to any axios instance
function attachRetry(axiosInstance, opts = {}) {
  const {
    retries = 3,
    baseDelayMs = 300,
    maxDelayMs = 5000,
    // retry only on idempotent-ish methods by default
    methods = ['get', 'head', 'options', 'put', 'delete', 'patch'],
    // allow 5xx and 429, plus network-ish errors
    shouldRetry = (error, cfg, attempt) => {
      const method = (cfg.method || 'get').toLowerCase();
      if (!methods.includes(method)) return false;

      if (error && error.response) {
        const s = error.response.status;
        return (s >= 500 && s <= 599) || s === 429;
      }
      // no response: network, timeout, etc.
      const code = (error && error.code) || '';
      return ['ECONNABORTED', 'ECONNRESET', 'EAI_AGAIN', 'ETIMEDOUT'].includes(code);
    },
    // backoff with jitter: min(base*2^(n-1), max) + 0-100ms
    computeDelay = (attempt) => {
      const exp = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
      return exp + Math.floor(Math.random() * 100);
    }
  } = opts;

  axiosInstance.interceptors.response.use(
    (res) => res,
    async (error) => {
      const cfg = error && error.config;
      if (!cfg) throw error;

      cfg.__retryCount = (cfg.__retryCount || 0) + 1;
      const attempt = cfg.__retryCount;

      if (attempt > retries || !shouldRetry(error, cfg, attempt)) {
        throw error;
      }

      const delay = computeDelay(attempt);
      await sleep(delay);
      return axiosInstance.request(cfg);
    }
  );

  return axiosInstance;
}

module.exports = { attachRetry };
