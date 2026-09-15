#!/usr/bin/env node
// Migration entrypoint used both locally and by the one-off RDS migrate job.
//
// Resolves DATABASE_URL the same way the app does (DATABASE_URL, else the
// Secrets Manager secret named by DB_SECRET_ID), then runs node-pg-migrate.
// node-pg-migrate reads DATABASE_URL from the environment.

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveDbConfig } = require('../src/config');

async function main() {
  const direction = process.argv[2] || 'up';
  const env = { ...process.env };

  // Track whether the caller's role owns the DB (local/CI compose) vs. a
  // least-privilege RDS role (ECS via Secrets Manager). Only the former can
  // CREATE SCHEMA — the latter would hit 42501 on IF NOT EXISTS.
  let canCreateSchema = Boolean(env.DATABASE_URL);

  if (!env.DATABASE_URL) {
    const cfg = await resolveDbConfig();
    env.DATABASE_URL = cfg.connectionString;
    canCreateSchema = cfg.source === 'DATABASE_URL';
    // RDS requires TLS; mirror the app pool's rejectUnauthorized:false via
    // libpq's PGSSLMODE. Skip only when caller already set it or DB_SSL=false.
    if (!env.PGSSLMODE && cfg.source !== 'DATABASE_URL' && env.DB_SSL !== 'false') {
      env.PGSSLMODE = 'no-verify';
    }
    console.log(
      JSON.stringify({
        level: 'info',
        service: 'pos',
        msg: 'migrate_db_resolved',
        source: cfg.source,
        sslmode: env.PGSSLMODE || 'default',
      })
    );
  }

  const schema = process.env.DB_SCHEMA || 'pos';
  const bin = path.join(__dirname, '..', 'node_modules', '.bin', 'node-pg-migrate');
  // Local/CI (DATABASE_URL): connecting user owns the DB — safe to create
  // schemas. RDS (Secrets Manager): schemas are pre-created by db-bootstrap
  // under master; the least-priv role has no CREATE on database, so passing
  // --create-schema would return 42501 even on IF NOT EXISTS.
  const args = [
    direction,
    '--migrations-dir', 'migrations',
    '--schema', schema,
    '--migrations-schema', schema,
    ...(canCreateSchema ? ['--create-schema', '--create-migrations-schema'] : []),
  ];
  const result = spawnSync(bin, args, { stdio: 'inherit', env });
  process.exit(result.status === null ? 1 : result.status);
}

main().catch((err) => {
  console.error(
    JSON.stringify({ level: 'error', service: 'pos', msg: 'migrate_failed', error: String(err.message || err) })
  );
  process.exit(1);
});
