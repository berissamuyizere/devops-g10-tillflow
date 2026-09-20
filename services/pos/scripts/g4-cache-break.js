#!/usr/bin/env node
/**
 * G4 — Berissa cache-break drill.
 * Revokes ECS→Valkey ingress, proves fail-open, restores rule, captures evidence.
 *
 *   export AWS_PROFILE=g10 AWS_REGION=eu-central-1
 *   export API_URL=https://f9nla14lfh.execute-api.eu-central-1.amazonaws.com
 *   node services/pos/scripts/g4-cache-break.js
 */
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const API = (process.env.API_URL || '').replace(/\/+$/, '');
const TENANT_ID = (process.env.TENANT_ID || '11111111-1111-1111-1111-111111111111').trim();
const ATTENDANT_ID = (process.env.ATTENDANT_ID || '22222222-2222-2222-2222-222222222222').trim();
const REGION = process.env.AWS_REGION || 'eu-central-1';
const CACHE_RULE_ID = process.env.CACHE_SG_RULE_ID || 'sgr-07f88466a6ed37640';
const OUT_DIR =
  process.env.EVIDENCE_DIR || path.resolve(__dirname, '../../../evidence/product-pos');

function aws(args, { json = true } = {}) {
  const out = execFileSync('aws', [...args, '--region', REGION], {
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return json ? JSON.parse(out) : out.trim();
}

function eatNow() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Africa/Nairobi', hour12: false }) + '+03:00';
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

async function timedGet(saleId) {
  const started = performance.now();
  const res = await fetch(`${API}/sales/${saleId}`, { headers: headers() });
  const latencyMs = Math.round(performance.now() - started);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, latencyMs, body };
}

function cacheMetricSum(sinceIso, result) {
  const since = new Date(sinceIso);
  const data = aws([
    'cloudwatch',
    'get-metric-statistics',
    '--namespace',
    'TillFlow',
    '--metric-name',
    'pos_cache_requests_total',
    '--dimensions',
    `Name=result,Value=${result}`,
    'Name=OTelLib,Value=tillflow.pos',
    '--start-time',
    new Date(since.getTime() - 120_000).toISOString(),
    '--end-time',
    new Date(Date.now() + 120_000).toISOString(),
    '--period',
    '60',
    '--statistics',
    'Sum',
  ]);
  return (data.Datapoints || []).reduce((s, p) => s + (p.Sum || 0), 0);
}

function httpErrorSum(sinceIso) {
  const since = new Date(sinceIso);
  const data = aws([
    'cloudwatch',
    'get-metric-statistics',
    '--namespace',
    'TillFlow',
    '--metric-name',
    'pos_http_requests_total',
    '--dimensions',
    'Name=status,Value=5xx',
    '--start-time',
    new Date(since.getTime() - 120_000).toISOString(),
    '--end-time',
    new Date(Date.now() + 120_000).toISOString(),
    '--period',
    '60',
    '--statistics',
    'Sum',
  ]);
  return (data.Datapoints || []).reduce((s, p) => s + (p.Sum || 0), 0);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  if (!API) throw new Error('API_URL required');

  const drillStart = new Date().toISOString();
  const drillStartEat = eatNow();

  // Create a sale before breaking cache.
  const createRes = await fetch(`${API}/sales`, {
    method: 'POST',
    headers: headers({ 'idempotency-key': `g4-cache-${randomUUID().slice(0, 8)}` }),
    body: JSON.stringify({
      lines: [{ description: 'G4 cache break drill', quantity: 1, unit_price_minor: 500 }],
    }),
  });
  const created = await createRes.json().catch(() => ({}));
  const saleId = created.id;
  if (createRes.status !== 201 || !saleId) {
    throw new Error(`create sale failed: ${createRes.status} ${JSON.stringify(created)}`);
  }

  const baselineError = cacheMetricSum(drillStart, 'error');

  // Break cache: revoke ECS→Valkey ingress.
  const breakAt = new Date().toISOString();
  aws(['ec2', 'revoke-security-group-ingress', '--group-id', 'sg-09f5f26c6b661d778', '--security-group-rule-ids', CACHE_RULE_ID], {
    json: false,
  });

  const reads = [];
  for (let i = 0; i < 8; i += 1) {
    reads.push(await timedGet(saleId));
    await sleep(2000);
  }

  // Wait for EMF flush.
  await sleep(90_000);

  const duringError = cacheMetricSum(breakAt, 'error');
  const during5xx = httpErrorSum(breakAt);
  const allOk = reads.every((r) => r.status === 200);

  // Restore cache rule (same as Terraform cache_from_ecs).
  const restoreAt = new Date().toISOString();
  aws([
    'ec2',
    'authorize-security-group-ingress',
    '--group-id',
    'sg-09f5f26c6b661d778',
    '--ip-permissions',
    JSON.stringify([
      {
        IpProtocol: 'tcp',
        FromPort: 6379,
        ToPort: 6379,
        UserIdGroupPairs: [{ GroupId: 'sg-05cc34784cf1ed3e2', Description: 'Valkey from ECS tasks.' }],
      },
    ]),
  ], { json: false });

  await sleep(5000);
  const restoredReads = [];
  for (let i = 0; i < 2; i += 1) {
    restoredReads.push(await timedGet(saleId));
  }

  const drillEnd = new Date().toISOString();
  const drillEndEat = eatNow();

  const evidence = {
    drill: 'g4-cache-break',
    owner: 'Berissa',
    runbook: 'docs/runbook.md (cache fail-open — Valkey unreachable, Postgres serves)',
    times: {
      started_utc: drillStart,
      started_eat: drillStartEat,
      cache_rule_revoked_utc: breakAt,
      cache_rule_restored_utc: restoreAt,
      ended_utc: drillEnd,
      ended_eat: drillEndEat,
      recovery_seconds: Math.round((new Date(restoreAt) - new Date(breakAt)) / 1000),
    },
    break_action: {
      type: 'revoke_security_group_ingress',
      rule_id: CACHE_RULE_ID,
      cache_sg: 'sg-09f5f26c6b661d778',
      description: 'Removed ECS tasks → Valkey :6379 ingress on devops-g10-cache',
    },
    restore_action: {
      type: 'authorize_security_group_ingress',
      note: 'Re-applied same rule; run terraform plan to confirm no drift',
    },
    api_url: API,
    sale_id: saleId,
    reads_during_break: reads,
    reads_after_restore: restoredReads,
    metrics: {
      baseline_cache_error: baselineError,
      during_cache_error_delta: duringError - baselineError,
      during_cache_error_total: duringError,
      http_5xx_during_break: during5xx,
    },
    detection: {
      method: 'CloudWatch TillFlow pos_cache_requests_total{result=error}',
      note: 'No dedicated cache alarm; metric rise is the detection proof',
    },
    first_safe_action: 'Confirm GET /sales/:id still 200 from Postgres (fail-open); do not restart ECS',
    checks: [
      { check: 'all GETs 200 during break', ok: allOk, actual: reads.map((r) => r.status), expected: 'all 200' },
      { check: 'cache error metric rose', ok: duringError > baselineError, actual: duringError, expected: `> ${baselineError}` },
      { check: 'zero HTTP 5xx during break', ok: during5xx === 0, actual: during5xx, expected: 0 },
      { check: 'restore GETs 200', ok: restoredReads.every((r) => r.status === 200), actual: restoredReads.map((r) => r.status), expected: 'all 200' },
    ],
    passed: allOk && duringError > baselineError && during5xx === 0,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, 'g4-cache-break.json');
  fs.writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify(evidence, null, 2));
  if (!evidence.passed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
