#!/usr/bin/env node

const { Client } = require('pg');
const { resolveDbConfig, buildUrlFromParts } = require('../src/config');

const TABLES = (process.env.COUNT_TABLES || 'pos.sales,pos.sale_lines').split(',').map((s) => s.trim());
const RESTORE_HOST = (process.env.RESTORE_HOST || '').trim();

async function countOn(connectionString, ssl, label) {
  const client = new Client({ connectionString, ssl });
  await client.connect();
  const out = { label, host: client.host, counts: {} };
  try {
    for (const table of TABLES) {
      if (!/^[a-z_]+\.[a-z_]+$/.test(table)) {
        throw new Error(`refusing table ${table}`);
      }
      const res = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
      out.counts[table] = res.rows[0].n;
    }
  } finally {
    await client.end();
  }
  return out;
}

function swapHost(url, host) {
  const u = new URL(url);
  u.hostname = host;
  return u.toString();
}

async function main() {
  if (!RESTORE_HOST) throw new Error('RESTORE_HOST is required');
  const cfg = await resolveDbConfig();
  const live = await countOn(cfg.connectionString, cfg.ssl, 'live');
  const restoreUrl = swapHost(cfg.connectionString, RESTORE_HOST);
  const restore = await countOn(restoreUrl, cfg.ssl, 'restore');
  const evidence = {
    captured_at: new Date().toISOString(),
    schema: 'pos',
    tables: TABLES,
    live,
    restore,
    delta: Object.fromEntries(
      TABLES.map((t) => [t, (live.counts[t] || 0) - (restore.counts[t] || 0)])
    ),
  };
  console.log(JSON.stringify(evidence, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ error: String(err.message || err) }));
  process.exit(1);
});
