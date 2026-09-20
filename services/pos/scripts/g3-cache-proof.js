#!/usr/bin/env node
/**
 * G3 — Berissa cache-aside proof (B3).
 *
 * Public Gateway: create sale → GET /sales/:id twice (miss then hit).
 * In VPC (CACHE_HOST set): confirm Valkey key after first read.
 * With AWS CLI: read TillFlow pos_cache_requests_total from CloudWatch.
 *
 *   export API_URL=https://f9nla14lfh.execute-api.eu-central-1.amazonaws.com
 *   export TENANT_ID=11111111-1111-1111-1111-111111111111
 *   export ATTENDANT_ID=22222222-2222-2222-2222-222222222222
 *   node services/pos/scripts/g3-cache-proof.js
 *
 * In VPC:
 *   evidence/run-in-vpc.sh pos scripts/g3-cache-proof.js
 */
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const Redis = require('ioredis');
const { saleKey } = require('../src/cache/sales');

const API = (process.env.API_URL || process.env.POS_BASE_URL || '').replace(/\/+$/, '');
const TENANT_ID = (process.env.TENANT_ID || '11111111-1111-1111-1111-111111111111').trim();
const ATTENDANT_ID = (process.env.ATTENDANT_ID || '22222222-2222-2222-2222-222222222222').trim();
const REGION = process.env.AWS_REGION || 'eu-central-1';
const OUT_DIR =
  process.env.EVIDENCE_DIR || path.resolve(__dirname, '../../../evidence/product-pos');

const checks = [];

function check(name, ok, actual, expected) {
  checks.push({ check: name, ok, actual, expected });
  return ok;
}

function headers(extra = {}) {
  return {
    'content-type': 'application/json',
    'x-tenant-id': TENANT_ID,
    'x-user-id': ATTENDANT_ID,
    'x-role': 'attendant',
    ...extra,
  };
}

async function timedFetch(url, init = {}) {
  const started = performance.now();
  const res = await fetch(url, init);
  const latencyMs = Math.round(performance.now() - started);
  const body = res.status === 204 ? null : await res.json().catch(() => ({}));
  return { res, body, latencyMs };
}

function awsReady() {
  return awsJson(['sts', 'get-caller-identity']) != null;
}

function awsJson(args) {
  try {
    const out = execFileSync('aws', [...args, '--output', 'json', '--region', REGION], {
      encoding: 'utf8',
      env: process.env,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function cloudwatchCacheDelta(sinceIso) {
  if (!awsReady()) return null;
  const since = new Date(sinceIso);
  const start = new Date(since.getTime() - 60_000);
  const end = new Date(Date.now() + 60_000);
  const out = { miss: null, hit: null, error: null };
  for (const result of ['miss', 'hit', 'error']) {
    const data = awsJson([
      'cloudwatch',
      'get-metric-statistics',
      '--namespace',
      'TillFlow',
      '--metric-name',
      'pos_cache_requests_total',
      '--dimensions',
      `Name=result,Value=${result}`,
      '--start-time',
      start.toISOString(),
      '--end-time',
      end.toISOString(),
      '--period',
      '60',
      '--statistics',
      'Sum',
    ]);
    if (!data) return null;
    const pts = data.Datapoints || [];
    out[result] = pts.reduce((sum, p) => sum + (p.Sum || 0), 0);
  }
  return out;
}

async function valkeyProbe(tenantId, saleId) {
  const host = (process.env.CACHE_HOST || '').trim();
  if (!host) {
    return { enabled: false };
  }
  const client = new Redis({
    host,
    port: Number(process.env.CACHE_PORT || 6379),
    password: (process.env.CACHE_AUTH_TOKEN || '').trim() || undefined,
    tls: {},
    connectTimeout: 3000,
    commandTimeout: 2000,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  try {
    await client.connect();
    const key = saleKey(tenantId, saleId);
    const exists = (await client.exists(key)) === 1;
    return { enabled: true, key, exists };
  } catch (err) {
    return { enabled: true, error: String(err.message || err) };
  } finally {
    try {
      await client.quit();
    } catch {
      client.disconnect();
    }
  }
}

async function main() {
  if (!API) {
    throw new Error('API_URL or POS_BASE_URL is required');
  }

  const capturedAt = new Date().toISOString();
  const idempotencyKey = `g3-cache-${randomUUID().slice(0, 8)}`;

  const created = await timedFetch(`${API}/sales`, {
    method: 'POST',
    headers: headers({ 'idempotency-key': idempotencyKey }),
    body: JSON.stringify({
      lines: [{ description: 'G3 Valkey cache proof', quantity: 1, unit_price_minor: 1000 }],
    }),
  });
  check('sale created', created.res.status === 201, created.res.status, 201);
  const saleId = created.body?.id;
  check('sale id present', Boolean(saleId), saleId, 'uuid');

  const reads = [];
  for (let n = 1; n <= 2; n += 1) {
    const read = await timedFetch(`${API}/sales/${saleId}`, { headers: headers() });
    check(`GET ${n} status`, read.res.status === 200, read.res.status, 200);
    check(`GET ${n} same sale`, read.body?.id === saleId, read.body?.id, saleId);
    reads.push({ n, status: read.res.status, latency_ms: read.latencyMs, body_id: read.body?.id });
  }

  const valkeyAfterReads = await valkeyProbe(TENANT_ID, saleId);
  if (valkeyAfterReads.enabled && !valkeyAfterReads.error) {
    check('valkey key populated', valkeyAfterReads.exists === true, valkeyAfterReads.exists, true);
  }

  const cloudwatch = cloudwatchCacheDelta(capturedAt);
  if (cloudwatch) {
    check('cloudwatch cache miss >= 1', cloudwatch.miss >= 1, cloudwatch.miss, '>=1');
    check('cloudwatch cache hit >= 1', cloudwatch.hit >= 1, cloudwatch.hit, '>=1');
  } else if (reads.length === 2) {
    const faster = reads[1].latency_ms < reads[0].latency_ms * 0.75;
    check('second GET faster than first (cache hit signal)', faster, reads[1].latency_ms, `< ${reads[0].latency_ms}`);
  }

  const passed = checks.every((c) => c.ok);
  const evidence = {
    captured_at: capturedAt,
    api_url: API,
    tenant_id: TENANT_ID,
    attendant_id: ATTENDANT_ID,
    sale_id: saleId,
    idempotency_key: idempotencyKey,
    reads,
    valkey: valkeyAfterReads,
    cloudwatch: cloudwatch || null,
    fail_open: {
      note: 'Fail-open (Valkey down still returns sale) is covered by services/pos/test/cache.test.js',
      test: 'fail-open serves Postgres when cache errors',
    },
    checks,
    passed,
    hint: passed
      ? 'First GET miss + second GET hit — see cloudwatch and/or Valkey key'
      : 'Fix failing checks; ensure B3 image is live and CACHE_HOST is set on POS',
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, 'g3-cache-valkey.json');
  fs.writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
  if (!passed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(JSON.stringify({ error: String(err.message || err) }));
  process.exitCode = 1;
});
