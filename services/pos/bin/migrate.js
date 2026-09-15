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

  if (!env.DATABASE_URL) {
    const cfg = await resolveDbConfig();
    env.DATABASE_URL = cfg.connectionString;
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
  // Pass schema flags explicitly: keep the migrations tracking table inside
  // the service schema so the least-privilege `pos` role owns it.
  // Schemas are pre-created by the one-off db-bootstrap task under the RDS
  // master role (ADR-003). The devops_g10_pos role only has USAGE/CREATE on
  // schema `pos`, so we must NOT pass --create-schema here — Postgres checks
  // CREATE-on-database before the IF-NOT-EXISTS shortcut and returns 42501.
  const args = [
    direction,
    '--migrations-dir', 'migrations',
    '--schema', schema,
    '--migrations-schema', schema,
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
