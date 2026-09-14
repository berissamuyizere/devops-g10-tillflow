const { Pool } = require('pg');
const { resolveDbConfig } = require('./config');

let pool;
let initPromise;

async function createPool() {
  const cfg = await resolveDbConfig();
  const schema = cfg.schema || 'pos';
  const created = new Pool({
    connectionString: cfg.connectionString,
    ssl: cfg.ssl,
    max: Number(process.env.DB_POOL_MAX || 10),
    // Pin every connection to the service schema at startup (libpq option),
    // so unqualified SQL resolves in `pos` even though app queries are
    // already schema-qualified.
    options: `-c search_path=${schema},public`,
  });
  return created;
}

async function ensurePool() {
  if (pool) {
    return pool;
  }
  if (!initPromise) {
    initPromise = createPool();
  }
  pool = await initPromise;
  return pool;
}

async function query(text, params) {
  const p = await ensurePool();
  return p.query(text, params);
}

async function withTransaction(fn) {
  const p = await ensurePool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback failure
    }
    throw err;
  } finally {
    client.release();
  }
}

async function checkReady() {
  await query('SELECT 1');
}

async function closePool() {
  if (initPromise) {
    try {
      await initPromise;
    } catch {
      // pool never came up; nothing to close
    }
  }
  if (pool) {
    await pool.end();
    pool = null;
    initPromise = null;
  }
}

module.exports = {
  ensurePool,
  query,
  withTransaction,
  checkReady,
  closePool,
};
