'use strict';

/**
 * src/infra/sqlite.js
 */

const fs = require('fs');
const path = require('path');
const { log } = require('../core/logger');

const dataDir = path.join(process.cwd(), 'data');
const dbFile = path.join(dataDir, 'jobs.sqlite');
const tmpFile = dbFile + '.tmp';

const JOB_FETCH_LIMIT = Number.isFinite(parseInt(process.env.JOB_FETCH_LIMIT, 10))
  ? parseInt(process.env.JOB_FETCH_LIMIT, 10)
  : 20;

let SQL = null;
let db = null;

/* column presence flags (for legacy DBs) */
let hasCreatedAt = false;
let hasUpdatedAt = false;
let hasResult = false;
let hasStatus = false;
let hasAttempts = false;
let hasLastError = false;

function ensureDataDir() {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (e) {
    // If directory exists or cannot be created, throw for visibility
    if (!fs.existsSync(dataDir)) throw e;
  }
}

function persist() {
  if (!db) return;
  try {
    const data = Buffer.from(db.export());
    // atomic-ish persist: write temp then rename
    fs.writeFileSync(tmpFile, data);
    fs.renameSync(tmpFile, dbFile);
  } catch (e) {
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch (_) { }
    log.warn('[SQLITE] persist failed: %s', e && (e.message || String(e)));
  }
}

function tableExists(name) {
  const res = db.exec(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=$name`,
    { $name: name }
  );
  return !!(res && res[0] && res[0].values && res[0].values.length > 0);
}

function columnExists(table, column) {
  const info = db.exec(`PRAGMA table_info('${table}')`);
  if (!info || !info[0] || !info[0].values) return false;
  return info[0].values.some((row) => row[1] === column);
}

function refreshJobsColumnsFlags() {
  hasCreatedAt = columnExists('jobs', 'createdAt');
  hasUpdatedAt = columnExists('jobs', 'updatedAt');
  hasResult = columnExists('jobs', 'result');
  hasStatus = columnExists('jobs', 'status');
  hasAttempts = columnExists('jobs', 'attempts');
  hasLastError = columnExists('jobs', 'lastError');
}

/* ------------------------------- migrations -------------------------------- */

function ensureJobsTable() {
  if (!tableExists('jobs')) {
    db.run(`
      CREATE TABLE jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        runAt INTEGER NOT NULL,
        status TEXT DEFAULT 'pending',
        attempts INTEGER DEFAULT 0,
        payload TEXT,
        lastError TEXT,
        result TEXT,
        createdAt INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
        updatedAt INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
      );
    `);
    db.run(`CREATE INDEX jobs_run_idx ON jobs(runAt, status);`);
    refreshJobsColumnsFlags();
    persist();
    return;
  }

  // Existing DB → add any missing columns/indexes
  refreshJobsColumnsFlags();

  if (!hasStatus) db.run(`ALTER TABLE jobs ADD COLUMN status TEXT DEFAULT 'pending';`);
  if (!hasAttempts) db.run(`ALTER TABLE jobs ADD COLUMN attempts INTEGER DEFAULT 0;`);
  if (!hasLastError) db.run(`ALTER TABLE jobs ADD COLUMN lastError TEXT;`);
  if (!hasResult) db.run(`ALTER TABLE jobs ADD COLUMN result TEXT;`);
  if (!hasCreatedAt) db.run(`ALTER TABLE jobs ADD COLUMN createdAt INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000);`);
  if (!hasUpdatedAt) db.run(`ALTER TABLE jobs ADD COLUMN updatedAt INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000);`);

  // Ensure index exists (create if missing)
  const idx = db.exec(`SELECT name FROM sqlite_master WHERE type='index' AND name='jobs_run_idx'`);
  if (!idx || !idx[0] || !idx[0].values || idx[0].values.length === 0) {
    db.run(`CREATE INDEX jobs_run_idx ON jobs(runAt, status);`);
  }

  refreshJobsColumnsFlags();
  persist();
}

function ensureKvTable() {
  db.run(`
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY,
      value TEXT,
      updatedAt INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
    );
  `);
  persist();
}

/* --------------------------------- init ------------------------------------ */

async function initSQLite() {
  ensureDataDir();
  const initSqlJs = require('sql.js');
  SQL = await initSqlJs({
    locateFile: (f) => require.resolve('sql.js/dist/' + f)
  });

  if (fs.existsSync(dbFile)) {
    const fileBuffer = fs.readFileSync(dbFile);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  ensureJobsTable();
  ensureKvTable();
  log.info('[SQLITE] ready at %s', dbFile);
}

/* ------------------------------ job utilities ------------------------------ */

function _likePatternsForCandidateId(candidateId) {
  // Support both `"candidateId":"123"` and `"candidateId":123`
  const id = String(candidateId);
  return [
    `%\"candidateId\":\"${id}\"%`,
    `%\"candidateId\":${id}%`
  ];
}

function findLatestJobByCandidate(type, candidateId) {
  if (!db) throw new Error('DB not initialized');

  const [pQuoted, pNumeric] = _likePatternsForCandidateId(candidateId);
  const sql = `
    SELECT id, type, status, runAt, createdAt, updatedAt
    FROM jobs
    WHERE type = ?
      AND (payload LIKE ? OR payload LIKE ?)
    ORDER BY createdAt DESC
    LIMIT 1
  `;
  const stmt = db.prepare(sql);
  stmt.bind([type, pQuoted, pNumeric]);
  let row = null;
  if (stmt.step()) row = stmt.getAsObject();
  stmt.free();
  return row;
}

function findActiveJobByCandidate(type, candidateId) {
  if (!db) throw new Error('DB not initialized');

  const [pQuoted, pNumeric] = _likePatternsForCandidateId(candidateId);
  const sql = `
    SELECT id, runAt, status
    FROM jobs
    WHERE type = ?
      AND status IN ('pending','running')
      AND (payload LIKE ? OR payload LIKE ?)
    ORDER BY runAt DESC
    LIMIT 1
  `;
  const stmt = db.prepare(sql);
  stmt.bind([type, pQuoted, pNumeric]);
  let row = null;
  if (stmt.step()) row = stmt.getAsObject();
  stmt.free();
  return row; // {id, runAt, status} or null
}

function upsertJob({ type, runAt, payload }) {
  if (!db) throw new Error('DB not initialized');

  const nowMs = Date.now();

  const cols = ['type', 'runAt', 'payload', 'status'];
  const vals = [type, runAt, JSON.stringify(payload || {}), 'pending'];

  if (hasCreatedAt) { cols.push('createdAt'); vals.push(nowMs); }
  if (hasUpdatedAt) { cols.push('updatedAt'); vals.push(nowMs); }

  const placeholders = cols.map(() => '?').join(', ');
  const sql = `INSERT INTO jobs (${cols.join(', ')}) VALUES (${placeholders})`;
  const stmt = db.prepare(sql);
  stmt.run(vals);
  stmt.free();

  const id = db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0];
  persist();
  return id;
}

function fetchDueJobs(nowMs) {
  if (!db) throw new Error('DB not initialized');

  const sql = `
    SELECT id, type, runAt, status, attempts, payload
    FROM jobs
    WHERE status = 'pending' AND runAt <= ?
    ORDER BY runAt ASC
    LIMIT ?
  `;
  const stmt = db.prepare(sql);
  stmt.bind([nowMs, JOB_FETCH_LIMIT]);

  const rows = [];
  while (stmt.step()) {
    const r = stmt.getAsObject();
    rows.push({
      id: r.id,
      type: r.type,
      runAt: r.runAt,
      status: r.status,
      attempts: r.attempts,
      payload: r.payload
    });
  }
  stmt.free();
  return rows;
}

function markJob(id, fields) {
  if (!db) throw new Error('DB not initialized');

  const updates = ['updatedAt = ?'];
  const vals = [Date.now()];

  for (const [k, v] of Object.entries(fields || {})) {
    updates.push(`${k} = ?`);
    if (v === null || v === undefined) {
      vals.push(null);
    } else if (typeof v === 'object') {
      vals.push(JSON.stringify(v));
    } else {
      vals.push(v);
    }
  }

  vals.push(id);
  const sql = `UPDATE jobs SET ${updates.join(', ')} WHERE id = ?`;
  db.run(sql, vals);
  persist();
}

/* ---------------------------------- KV ------------------------------------- */

function getKV(key) {
  if (!db) throw new Error('DB not initialized');
  const stmt = db.prepare(`SELECT value FROM kv WHERE key = ?`);
  stmt.bind([key]);
  let val = null;
  if (stmt.step()) {
    val = stmt.getAsObject().value;
  }
  stmt.free();
  return val;
}

function setKV(key, value) {
  if (!db) throw new Error('DB not initialized');
  const now = Date.now();

  // Try update; if no row changed, insert
  const upd = db.prepare(`UPDATE kv SET value = ?, updatedAt = ? WHERE key = ?`);
  upd.run([String(value), now, key]);
  upd.free();

  const changed = db.getRowsModified && db.getRowsModified();
  if (!changed) {
    const ins = db.prepare(`INSERT INTO kv (key, value, updatedAt) VALUES (?, ?, ?)`);
    ins.run([key, String(value), now]);
    ins.free();
  }

  persist();
}

function getKVInt(key, def = 0) {
  const v = parseInt(getKV(key), 10);
  return Number.isFinite(v) ? v : def;
}

function bumpKVInt(key, startAt = 1) {
  const cur = getKVInt(key, startAt - 1);
  const next = cur + 1;
  setKV(key, next);
  return next;
}

/* --------------------------------- exports --------------------------------- */

module.exports = {
  initSQLite,
  upsertJob,
  fetchDueJobs,
  markJob,
  getKV,
  setKV,
  getKVInt,
  bumpKVInt,
  findLatestJobByCandidate,
  findActiveJobByCandidate
};
