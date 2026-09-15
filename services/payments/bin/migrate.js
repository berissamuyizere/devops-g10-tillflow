#!/usr/bin/env node
// Migration entrypoint — local + one-off ECS migrate job.
// Resolves DATABASE_URL the same way the app does.

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { resolveDbConfig } = require('../src/config');

async function main() {
  const direction = process.argv[2] || 'up';
  const env = { ...process.env };

  if (!env.DATABASE_URL) {
    const cfg = await resolveDbConfig();
    env.DATABASE_URL = cfg.connectionString;
    console.log(
      JSON.stringify({
        level: 'info',
        service: 'payments',
        msg: 'migrate_db_resolved',
        source: cfg.source,
      })
    );
  }

  const schema = process.env.DB_SCHEMA || 'payments';
  const bin = path.join(__dirname, '..', 'node_modules', '.bin', 'node-pg-migrate');
  const args = [
    direction,
    '--migrations-dir',
    'migrations',
    '--schema',
    schema,
    '--create-schema',
    '--migrations-schema',
    schema,
    '--create-migrations-schema',
  ];
  const result = spawnSync(bin, args, { stdio: 'inherit', env });
  process.exit(result.status === null ? 1 : result.status);
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      level: 'error',
      service: 'payments',
      msg: 'migrate_failed',
      error: String(err.message || err),
    })
  );
  process.exit(1);
});
