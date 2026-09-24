#!/usr/bin/env node
/**
 * G5 — Berissa post-rebuild paid sale proof (PR to main).
 * sale → pay (254700000000) → signed callback → GET /sales/:id paid.
 *
 *   aws sso login --profile g10
 *   export AWS_PROFILE=g10 AWS_REGION=eu-central-1
 *   export API_URL=https://mww3x8g0k2.execute-api.eu-central-1.amazonaws.com
 *   export TENANT_ID=11111111-1111-1111-1111-111111111111
 *   export ATTENDANT_ID=22222222-2222-2222-2222-222222222222
 *   TOKENS=$(aws secretsmanager get-secret-value --secret-id devops-g10/service-tokens \
 *     --region eu-central-1 --query SecretString --output text)
 *   export DARAJA_CALLBACK_SECRET=$(echo "$TOKENS" | jq -r .daraja_callback_secret)
 *   node services/pos/scripts/g5-post-rebuild-e2e.js
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '../../..');
const API = (process.env.API_URL || '').replace(/\/+$/, '');
const OUT = path.join(repoRoot, 'evidence/product-pos/g5-post-rebuild-e2e.json');
const G3_OUT = path.join(repoRoot, 'evidence/payments-integrity/g3-trace-payment.json');
const PAYMENTS_DIR = path.join(repoRoot, 'services/payments');
const XRAY_CHECK_NAMES = new Set(['trace found in X-Ray', 'trace covers pos and payments']);

function moneyPathPassed(checks) {
  return (checks || []).filter((c) => !XRAY_CHECK_NAMES.has(c.check)).every((c) => c.ok);
}

function ensurePaymentsDeps() {
  const xrayPkg = path.join(PAYMENTS_DIR, 'node_modules/@aws-sdk/client-xray');
  if (fs.existsSync(xrayPkg)) return;
  console.log('installing services/payments deps (needed for optional X-Ray step)…');
  execFileSync('npm', ['ci', '--ignore-scripts'], { stdio: 'inherit', cwd: PAYMENTS_DIR });
}

function requireEnv() {
  const missing = [];
  if (!API) missing.push('API_URL');
  if (!(process.env.TENANT_ID || '').trim()) missing.push('TENANT_ID');
  if (!(process.env.ATTENDANT_ID || '').trim()) missing.push('ATTENDANT_ID');
  if (!(process.env.DARAJA_CALLBACK_SECRET || '').trim()) missing.push('DARAJA_CALLBACK_SECRET');
  if (missing.length) {
    console.error(`missing: ${missing.join(', ')}`);
    process.exit(2);
  }
}

async function healthOk() {
  const res = await fetch(`${API}/health`);
  const body = await res.json().catch(() => ({}));
  if (res.status !== 200) {
    console.error(`/health is ${res.status}, not 200 — wait for platform (#157)`);
    process.exit(1);
  }
  console.log('/health 200', body);
}

function runG3Trace() {
  ensurePaymentsDeps();
  const script = path.join(repoRoot, 'services/payments/scripts/g3-trace-payment.js');
  const env = { ...process.env, API_URL: API, SKIP_XRAY: '1' };
  try {
    execFileSync('node', [script], { stdio: 'inherit', env, cwd: PAYMENTS_DIR });
  } catch (err) {
    if (err.status !== 1 || !fs.existsSync(G3_OUT)) throw err;
    const g3 = JSON.parse(fs.readFileSync(G3_OUT, 'utf8'));
    if (!moneyPathPassed(g3.checks)) throw err;
    console.log('g3 exited non-zero but money-path checks passed — continuing G5 evidence');
  }
}

function writeG5Evidence() {
  if (!fs.existsSync(G3_OUT)) {
    console.error(`missing ${G3_OUT} — g3-trace-payment did not write evidence`);
    process.exit(1);
  }
  const g3 = JSON.parse(fs.readFileSync(G3_OUT, 'utf8'));
  const moneyOk = moneyPathPassed(g3.checks);
  const evidence = {
    ...g3,
    drill: 'g5-post-rebuild-e2e',
    purpose:
      'G5 post-rebuild: sale → POST /sales/:id/pay (fake STK 254700000000) → signed POST /payments/callback → GET /sales/:id status=paid',
    stack_note: 'New API Gateway after G5 rebuild; money path must pass, not /health alone',
    api_url: API,
    tenant_id: process.env.TENANT_ID.trim(),
    attendant_id: process.env.ATTENDANT_ID.trim(),
    skip_xray: true,
    money_path_passed: moneyOk,
    passed: moneyOk,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`evidence written to ${OUT}`);
  if (!moneyOk) process.exit(1);
}

async function main() {
  requireEnv();
  await healthOk();
  runG3Trace();
  writeG5Evidence();
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
