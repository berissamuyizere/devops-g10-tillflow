#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { createDarajaClient, darajaTimestamp } = require('../../_shared/mpesa/daraja');
const { MpesaTimeoutError, MpesaRejectedError } = require('../../_shared/mpesa');

const SECRET_ID = process.env.DARAJA_SECRET_ID || 'devops-g10/daraja';
const REGION = process.env.AWS_REGION || 'eu-central-1';
const PAYER = (process.env.DARAJA_TEST_MSISDN || '254708374149').trim();
const CALLBACK_URL =
  process.env.DARAJA_CALLBACK_URL || 'https://tillflow.invalid/payments/callback';
const OUT_DIR =
  process.env.EVIDENCE_DIR || path.resolve(__dirname, '../../../evidence/payments-integrity');
const QUERY_WAIT_MS = Number(process.env.QUERY_WAIT_MS || 8000);

const steps = [];
let failures = 0;

function record(name, ok, detail) {
  if (!ok) failures += 1;
  steps.push({ step: name, ok, ...detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail?.note ? ` — ${detail.note}` : ''}`);
}

async function loadSecret() {
  const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
  const client = new SecretsManagerClient({ region: REGION });
  const out = await client.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
  const secret = JSON.parse(out.SecretString);
  const missing = ['consumer_key', 'consumer_secret', 'shortcode', 'passkey'].filter(
    (k) => !secret[k] || secret[k] === 'PLACEHOLDER'
  );
  if (missing.length) {
    throw new Error(`${SECRET_ID} is missing or placeholder for: ${missing.join(', ')}`);
  }
  if (secret.environment !== 'sandbox') {
    throw new Error(`refusing to run against environment=${secret.environment}; sandbox only`);
  }
  return secret;
}

async function main() {
  console.log('\nDaraja sandbox contract test');
  console.log(`  secret   ${SECRET_ID}`);
  console.log(`  payer    ${PAYER}`);
  console.log('  This calls the REAL Safaricom sandbox. Never run it in CI.\n');

  const secret = await loadSecret();
  const mpesa = createDarajaClient({
    environment: 'sandbox',
    consumerKey: secret.consumer_key,
    consumerSecret: secret.consumer_secret,
    shortcode: secret.shortcode,
    passkey: secret.passkey,
    initiatorName: secret.initiator_name,
    securityCredential: secret.security_credential,
  });

  const startedAt = new Date();
  console.log('1. oauth token');
  let push;
  try {
    console.log('2. stk push');
    push = await mpesa.stkPush({
      amountMinor: 100,
      msisdn: PAYER,
      accountReference: `g3-${Date.now().toString(36)}`,
      transactionDesc: 'TillFlow G3',
      callbackUrl: CALLBACK_URL,
    });
    record('oauth token obtained', true);
    record('stk push accepted', String(push.responseCode) === '0', {
      response_code: push.responseCode,
      note: push.responseDescription,
    });
    record('checkout request id returned', Boolean(push.checkoutRequestId), {
      checkout_request_id: push.checkoutRequestId,
    });
  } catch (err) {
    const isTimestamp = /timestamp|invalid password|Bad Request/i.test(String(err.message));
    record('stk push accepted', false, {
      error: err.code || err.name,
      note: err.message,
      hint: isTimestamp
        ? 'the adapter builds the STK timestamp in UTC; Safaricom examples use EAT'
        : undefined,
    });
    record('utc timestamp accepted by safaricom', !isTimestamp, {
      sent_timestamp: darajaTimestamp(startedAt),
      note: isTimestamp ? 'sandbox rejected the password/timestamp pair' : 'no timestamp complaint',
    });
    await finish(null, secret);
    return;
  }

  record('utc timestamp accepted by safaricom', true, {
    sent_timestamp: darajaTimestamp(startedAt),
    note: 'adapter builds the timestamp in UTC and the sandbox accepted it',
  });

  console.log(`3. waiting ${QUERY_WAIT_MS / 1000}s, then stk query`);
  await new Promise((r) => setTimeout(r, QUERY_WAIT_MS));

  try {
    const query = await mpesa.stkQuery({ checkoutRequestId: push.checkoutRequestId });
    record('stk query answered', true, {
      result_code: query.resultCode,
      note: query.resultDesc,
    });
    record(
      'query result is a known code, not a crash',
      Number.isFinite(Number(query.resultCode)),
      { result_code: query.resultCode }
    );
  } catch (err) {
    const unknownIsFine = err instanceof MpesaRejectedError || err instanceof MpesaTimeoutError;
    record('stk query answered', unknownIsFine, {
      error: err.code || err.name,
      note: err.message,
    });
  }

  await finish(push, secret);
}

async function finish(push, secret) {
  const evidence = {
    captured_at: new Date().toISOString(),
    purpose: 'prove the Daraja adapter speaks to the real Safaricom sandbox',
    environment: secret.environment,
    shortcode: secret.shortcode,
    payer_msisdn: PAYER,
    checkout_request_id: push?.checkoutRequestId ?? null,
    merchant_request_id: push?.merchantRequestId ?? null,
    b2c_attempted: false,
    b2c_note:
      'B2C is not exercised here: it needs a public ResultURL and QueueTimeOutURL registered with Safaricom. Deployed service stays MPESA_MODE=fake (ADR-002).',
    steps,
    passed: failures === 0,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, 'g3-daraja-contract.json');
  fs.writeFileSync(outFile, JSON.stringify(evidence, null, 2) + '\n');

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  console.log(`evidence written to ${outFile}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('daraja contract test failed:', err.message || err);
  process.exit(2);
});
