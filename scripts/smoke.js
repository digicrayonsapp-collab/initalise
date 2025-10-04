'use strict';

const { spawn } = require('child_process');
const axios = require('axios');

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function startServer(entry, port, startedMatcher) {
  const env = { ...process.env, PORT: String(port) };
  const child = spawn(process.execPath, [entry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let started = false;
  let stdoutBuf = '';
  let stderrBuf = '';
  child.stdout.on('data', (d) => {
    const s = d.toString();
    stdoutBuf += s;
    if (!started && startedMatcher(stdoutBuf)) started = true;
  });
  child.stderr.on('data', (d) => { stderrBuf += d.toString(); });

  const t0 = Date.now();
  while (!started && Date.now() - t0 < 12000) { await delay(200); }
  return { child, started, stdout: stdoutBuf, stderr: stderrBuf };
}

async function doChecks(base, cases) {
  const checks = [];
  for (const c of cases) {
    const path = c.path;
    try {
      const method = (c.method || 'GET').toUpperCase();
      const url = base + path;
      const opts = { timeout: 6000, validateStatus: () => true };
      let res;
      if (method === 'POST') res = await axios.post(url, c.body || {}, opts);
      else res = await axios.get(url, opts);
      const ok = c.expect(res.status);
      checks.push({ path, status: res.status, ok, data: res.data });
    } catch (e) {
      checks.push({ path, ok: false, error: e.message || String(e) });
    }
  }
  return checks;
}

async function run() {
  const port = Number(process.env.PORT || 3008);
  const results = { index: null, server: null, passed: false };

  // Phase 1: src/index.js
  const s1 = await startServer('src/index.js', port, (out) => out.includes(`:${port}`));
  const base1 = `http://127.0.0.1:${port}`;
  let checks1 = [];
  if (s1.started) {
    checks1 = await doChecks(base1, [
      { path: '/api/health', expect: (st) => st === 200 },
      { path: '/api/email/test?to=noreply@example.com', expect: (st) => st === 200 || st === 503 },
      { path: '/api/notfound', expect: (st) => st === 404 }
    ]);
  }
  try { s1.child.kill('SIGTERM'); } catch {}
  try { s1.child.kill(); } catch {}
  results.index = {
    started: s1.started,
    stdout: s1.stdout.slice(-4000),
    stderr: s1.stderr.slice(-4000),
    checks: checks1,
    passed: s1.started && checks1.every(c => c.ok)
  };

  // Phase 2: server.js (alternate entry)
  const s2 = await startServer('server.js', port, (out) => out.includes('Server running at'));
  const base2 = `http://127.0.0.1:${port}`;
  let checks2 = [];
  if (s2.started) {
    checks2 = await doChecks(base2, [
      { path: '/health', expect: (st) => st === 200 },
      { path: '/email/test?to=noreply@example.com', expect: (st) => st === 200 || st === 503 },
      { path: '/notfound', expect: (st) => st === 404 },
      { method: 'POST', path: '/zoho-webhook/edit', body: { upn: 'john.doe@example.com', firstname: 'John', lastname: 'Doe' }, expect: (st) => st === 200 }
    ]);
  }
  try { s2.child.kill('SIGTERM'); } catch {}
  try { s2.child.kill(); } catch {}
  results.server = {
    started: s2.started,
    stdout: s2.stdout.slice(-4000),
    stderr: s2.stderr.slice(-4000),
    checks: checks2,
    passed: s2.started && checks2.every(c => c.ok)
  };

  results.passed = (!!results.index?.passed) && (!!results.server?.passed);
  console.log(JSON.stringify(results, null, 2));
  process.exit(results.passed ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(1); });
