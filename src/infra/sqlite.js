// src/infra/sqlite.js
const fs = require('fs');
const path = require('path');
const { log } = require('../core/logger');

const dataDir = path.join(process.cwd(), 'data');
const dbFile = path.join(dataDir, 'jobs.sqlite');

let SQL = null;
let db = null;
let hasCreatedAt = false;
let hasUpdatedAt = false;
let hasResult = false;

function ensureDataDir() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
}

function findLatestJobByCandidate(type, candidateId) {
  if (!db) throw new Error('DB not initialized');
  const pattern = `%\"candidateId\":\"${String(candidateId)}\"%`;
  const sql = `
    SELECT id, type, status, runAt, createdAt, updatedAt
    FROM jobs
    WHERE type = ?
      AND payload LIKE ?
    ORDER BY createdAt DESC
    LIMIT 1
  `;
  const stmt = db.prepare(sql);
  stmt.bind([type, pattern]);
  let row = null;
  if (stmt.step()) row = stmt.getAsObject();
  stmt.free();
  return row; // or null
}


function persist() {
  const data = Buffer.from(db.export());
  fs.writeFileSync(dbFile, data);
}

function tableExists(name) {
  const res = db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='${name}'`);
  return res && res[0] && res[0].values && res[0].values.length > 0;
}

function refreshJobsColumnsFlags() {
  const info = db.exec(`PRAGMA table_info('jobs')`);
  hasCreatedAt = false;
  hasUpdatedAt = false;
  hasResult = false;
  if (info && info[0]) {
    const rows = info[0].values; // [cid, name, type, notnull, dflt_value, pk]
    for (const r of rows) {
      const colName = r[1];
      if (colName === 'createdAt') hasCreatedAt = true;
      if (colName === 'updatedAt') hasUpdatedAt = true;
      if (colName === 'result') hasResult = true;
    }
  }
}

// In your `ensureJobsTable()` function, add a 'status' column
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
  createdAt INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),  -- Ensure it's not null
  updatedAt INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)   -- Ensure it's not null
);
      CREATE INDEX jobs_run_idx ON jobs(runAt, status);
    `);
    refreshJobsColumnsFlags();
    persist();
    return;
  }
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
  log.info('🗄️ SQLite ready at', dbFile);
}

function findActiveJobByCandidate(type, candidateId) {
  if (!db) throw new Error('DB not initialized');
  // We store payload as JSON text; search for `"candidateId":"<id>"`
  // (candidateId is numeric/string from Zoho; safe in LIKE)
  const pattern = `%\"candidateId\":\"${String(candidateId)}\"%`;
  const sql = `
    SELECT id, runAt, status
    FROM jobs
    WHERE type = ?
      AND status IN ('pending','running')
      AND payload LIKE ?
    ORDER BY runAt DESC
    LIMIT 1
  `;
  const stmt = db.prepare(sql);
  stmt.bind([type, pattern]);
  let row = null;
  if (stmt.step()) row = stmt.getAsObject();
  stmt.free();
  return row; // {id, runAt, status} or null
}


function upsertJob({ type, runAt, payload }) {
  if (!db) throw new Error('DB not initialized');

  const nowMs = Date.now(); // Get current timestamp in milliseconds

  const cols = ['type', 'runAt', 'payload', 'status', 'createdAt', 'updatedAt']; // Include 'updatedAt' column
  const vals = [type, runAt, JSON.stringify(payload || {}), 'pending', nowMs, nowMs]; // Assign 'createdAt' and 'updatedAt' with the current timestamp

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
  const stmt = db.prepare(
    'SELECT id, type, runAt, status, attempts, payload FROM jobs WHERE status = ? AND runAt <= ? ORDER BY runAt ASC LIMIT 20'
  );
  const rows = [];
  stmt.bind(['pending', nowMs]);
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
  const updates = [];
  const vals = [];

  // Always bump updatedAt
  updates.push('updatedAt = ?');
  vals.push(Date.now());

  for (const [k, v] of Object.entries(fields)) {
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

/* ----------------------------- KV convenience ------------------------------ */

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
  const existing = getKV(key);
  if (existing === null || existing === undefined) {
    db.run(`INSERT INTO kv (key, value, updatedAt) VALUES (?, ?, ?)`, [key, String(value), now]);
  } else {
    db.run(`UPDATE kv SET value = ?, updatedAt = ? WHERE key = ?`, [String(value), now, key]);
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
