#!/usr/bin/env node
const { randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createFakeMpesaClient, TEST_MSISDNS } = require('../../_shared/mpesa');
const { runDailyClose, eatDate } = require('../../commission/src/close');

const SQS_QUEUE_URL = (process.env.SQS_QUEUE_URL || '').trim();
const CLOSE_TRIGGER = (process.env.CLOSE_TRIGGER || '').trim();
const AWS_REGION = process.env.AWS_REGION || 'eu-central-1';
const CLOSE_WAIT_MS = Number(process.env.CLOSE_WAIT_MS || 120000);
const CLOSE_POLL_MS = Number(process.env.CLOSE_POLL_MS || 3000);

const POS = (process.env.POS_BASE_URL || 'http://127.0.0.1:18081').replace(/\/+$/, '');
const PAYMENTS = (process.env.PAYMENTS_BASE_URL || 'http://127.0.0.1:18082').replace(/\/+$/, '');
const POS_TOKEN = (process.env.POS_SERVICE_TOKEN || 'dev-pos-token').trim();
const PAYMENTS_TOKEN = (process.env.PAYMENTS_SERVICE_TOKEN || 'dev-payments-token').trim();
const COMMISSION_TOKEN = (process.env.COMMISSION_SERVICE_TOKEN || 'dev-commission-token').trim();
const CALLBACK_SECRET = (process.env.DARAJA_CALLBACK_SECRET || 'dev-callback-secret').trim();
const TENANT_ID = (process.env.TENANT_ID || '').trim();
const ATTENDANT_ID = (process.env.ATTENDANT_ID || '').trim();
const OUT_DIR =
  process.env.EVIDENCE_DIR || path.resolve(__dirname, '../../../evidence/payments-integrity');

const steps = [];
let failures = 0;

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  steps.push({ check: name, ok, actual, expected });
  console.log(
    `  [${ok ? 'PASS' : 'FAIL'}] ${name}${ok ? '' : `  got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`
  );
  return ok;
}

function xrayTraceId() {
  return Math.floor(Date.now() / 1000).toString(16).padStart(8, '0') + randomBytes(12).toString('hex');
}

async function sendCloseMessage(scheduledAt) {
  const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
  const client = new SQSClient({ region: AWS_REGION });
  const body = JSON.stringify({ type: 'commission.daily-close', scheduled_at: scheduledAt });
  const out = await client.send(
    new SendMessageCommand({ QueueUrl: SQS_QUEUE_URL, MessageBody: body })
  );
  return out.MessageId;
}

async function waitForPayout(headers, agentId, period) {
  const deadline = Date.now() + CLOSE_WAIT_MS;
  let last = null;
  while (Date.now() < deadline) {
    const res = await fetch(
      `${PAYMENTS}/internal/v1/payouts/by-agent-period?agent_id=${agentId}&period=${period}`,
      { headers }
    );
    if (res.status === 200) return res.json();
    last = res.status;
    await new Promise((r) => setTimeout(r, CLOSE_POLL_MS));
  }
  throw new Error(
    `the deployed worker did not create a payout within ${CLOSE_WAIT_MS / 1000}s (last lookup ${last})`
  );
}

async function main() {
  if (!TENANT_ID || !ATTENDANT_ID) {
    console.error('TENANT_ID and ATTENDANT_ID are required (a seeded active attendant in POS).');
    process.exit(2);
  }

  const traceId = xrayTraceId();
  const traceparent = `00-${traceId}-${randomBytes(8).toString('hex')}-01`;
  const trace = (extra = {}) => ({ traceparent, 'content-type': 'application/json', ...extra });
  const mpesa = createFakeMpesaClient({ callbackSecret: CALLBACK_SECRET });

  console.log(`\nG2 close -> B2C\n  POS      ${POS}\n  Payments ${PAYMENTS}\n  trace_id ${traceId}\n`);

  console.log('1. create and pay a sale for the seed attendant');
  const saleRes = await fetch(`${POS}/sales`, {
    method: 'POST',
    headers: trace({
      'x-tenant-id': TENANT_ID,
      'x-user-id': ATTENDANT_ID,
      'x-role': 'attendant',
      'idempotency-key': `g2-close-sale-${randomUUID().slice(0, 8)}`,
    }),
    body: JSON.stringify({ lines: [{ description: 'Chai', quantity: 2, unit_price_minor: 7500 }] }),
  });
  const sale = await saleRes.json();
  check('sale created', saleRes.status, 201);

  const chargeRes = await fetch(`${PAYMENTS}/internal/v1/charges`, {
    method: 'POST',
    headers: trace({ 'x-pos-token': POS_TOKEN, 'idempotency-key': `g2-close-charge-${randomUUID().slice(0, 8)}` }),
    body: JSON.stringify({ sale_id: sale.id, msisdn: TEST_MSISDNS.SUCCESS }),
  });
  const payment = await chargeRes.json();
  check('charge accepted', chargeRes.status, 201);

  await mpesa.stkPush({
    shortcode: sale.mpesa_till || '174379',
    amountMinor: payment.amount_minor,
    msisdn: TEST_MSISDNS.SUCCESS,
    accountReference: sale.id,
    transactionDesc: 'TillFlow',
    callbackUrl: `${PAYMENTS}/payments/callback`,
  });
  const stk = mpesa.signBody(mpesa.buildCallback(payment.checkout_request_id), Date.now());
  const stkRes = await fetch(`${PAYMENTS}/payments/callback`, {
    method: 'POST',
    headers: trace(stk.headers),
    body: stk.raw,
  });
  check('sale is paid', (await stkRes.json()).status, 'paid');

  const period = eatDate(new Date());

  const commissionHeaders = trace({ 'x-commission-token': COMMISSION_TOKEN });

  const preflight = await fetch(
    `${PAYMENTS}/internal/v1/payouts/by-agent-period?agent_id=${ATTENDANT_ID}&period=${period}`,
    { headers: commissionHeaders }
  );
  if (preflight.status === 200) {
    const existing = await preflight.json();
    if (existing.status === 'disbursed' || existing.status === 'failed') {
      console.error(`\nagent ${ATTENDANT_ID} already has a ${existing.status} payout for ${period}.`);
      console.error('payout_ledger is unique per (agent_id, period), so a close for this');
      console.error('agent-period returns the existing row and the run cannot prove');
      console.error('"disbursing before the result callback".\n');
      console.error('Options:');
      console.error('  - run on the next Africa/Nairobi business day, or');
      console.error('  - set ATTENDANT_ID to a different seeded attendant in this tenant.\n');
      console.error(`existing ledger: ${existing.id} (${existing.status})`);
      process.exit(2);
    }
    console.log(`  note: resuming an existing ${existing.status} payout ${existing.id}`);
  } else if (preflight.status !== 404) {
    console.error(
      `\npreflight lookup returned ${preflight.status}. If this is 500, the deployed Payments`
    );
    console.error('does not have GET /internal/v1/payouts/by-agent-period yet.\n');
    process.exit(2);
  }

  const manual = CLOSE_TRIGGER === 'manual';
  const triggeredVia = manual ? 'sqs_manual' : SQS_QUEUE_URL ? 'sqs' : 'in_process';
  let ledger;
  let messageId = null;

  if (manual) {
    const payload = JSON.stringify({
      type: 'commission.daily-close',
      scheduled_at: new Date().toISOString(),
    });
    console.log('2. trigger the daily close from the SQS console');
    console.log('   Queue: devops-g10-commission-close -> Send and receive messages');
    console.log('   Message body:');
    console.log(`\n${payload}\n`);
    console.log(`   waiting up to ${CLOSE_WAIT_MS / 1000}s for the worker to create the payout...`);
    ledger = await waitForPayout(commissionHeaders, ATTENDANT_ID, period);
    check('the deployed worker created the payout', Boolean(ledger.id), true);
  } else if (SQS_QUEUE_URL) {
    console.log('2. trigger the daily close via SQS (deployed worker consumes it)');
    messageId = await sendCloseMessage(new Date().toISOString());
    console.log(`   sent commission.daily-close message ${messageId}`);
    ledger = await waitForPayout(commissionHeaders, ATTENDANT_ID, period);
    check('the deployed worker created the payout', Boolean(ledger.id), true);
  } else {
    console.log('2. run the daily close in-process (set SQS_QUEUE_URL to use the deployed worker)');
    const close = await runDailyClose({
      posBaseUrl: POS,
      paymentsBaseUrl: PAYMENTS,
      paymentsToken: PAYMENTS_TOKEN,
      commissionToken: COMMISSION_TOKEN,
      tenantIds: [TENANT_ID],
      scheduledAt: new Date().toISOString(),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    const payout = (close.payouts || []).find(
      (p) => p.ledger && p.ledger.id && p.ledger.agent_id === ATTENDANT_ID
    );
    if (!payout) {
      console.error(`close produced no payout for agent ${ATTENDANT_ID}.`);
      console.error('is there a paid sale for this attendant today (EAT)?');
      console.error(JSON.stringify(close, null, 2));
      process.exit(2);
    }
    ledger = payout.ledger;
    check('payout ledger row created', Boolean(ledger.id), true);
  }

  const ledgerId = ledger.id;
  const originator = ledger.originator_conversation_id;

  check('status is disbursing, not disbursed', ledger.status, 'disbursing');
  check('nothing disbursed before the result callback', ledger.disbursed_at, null);

  console.log('3. replay the close');
  if (manual) {
    console.log('   send the SAME message body again from the console, then wait...');
    await new Promise((r) => setTimeout(r, CLOSE_POLL_MS * 5));
    const replayed = await waitForPayout(commissionHeaders, ATTENDANT_ID, period);
    check('replayed close returns the same payout', replayed.id, ledgerId);
  } else if (SQS_QUEUE_URL) {
    await sendCloseMessage(new Date().toISOString());
    await new Promise((r) => setTimeout(r, CLOSE_POLL_MS * 3));
    const replayed = await waitForPayout(commissionHeaders, ATTENDANT_ID, period);
    check('replayed close returns the same payout', replayed.id, ledgerId);
  } else {
    const closeAgain = await runDailyClose({
      posBaseUrl: POS,
      paymentsBaseUrl: PAYMENTS,
      paymentsToken: PAYMENTS_TOKEN,
      commissionToken: COMMISSION_TOKEN,
      tenantIds: [TENANT_ID],
      scheduledAt: new Date().toISOString(),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    const replayPayout = (closeAgain.payouts || []).find(
      (p) => p.ledger && p.ledger.id && p.ledger.agent_id === ATTENDANT_ID
    );
    check('replayed close returns the same payout', replayPayout?.ledger?.id, ledgerId);
  }

  const afterReplay = await (
    await fetch(`${PAYMENTS}/internal/v1/payouts/${ledgerId}`, {
      headers: trace({ 'x-commission-token': COMMISSION_TOKEN }),
    })
  ).json();
  check('still disbursing after the replayed close', afterReplay.status, 'disbursing');

  console.log('4. B2C result callback');
  await mpesa.b2c({
    shortcode: process.env.MPESA_B2C_SHORTCODE || '600000',
    amountMinor: afterReplay.amount_minor,
    msisdn: afterReplay.msisdn,
    remarks: `TillFlow commission ${period}`,
    originatorConversationId: originator,
  });
  const resultBody = mpesa.buildB2cResultCallback(originator);
  const signedResult = mpesa.signBody(resultBody, Date.now());
  const resultRes = await fetch(`${PAYMENTS}/payments/b2c/callback`, {
    method: 'POST',
    headers: trace(signedResult.headers),
    body: signedResult.raw,
  });
  const resultJson = await resultRes.json();
  check('result callback accepted', resultRes.status, 200);
  check('payout disbursed only after the result callback', resultJson.status, 'disbursed');

  const disbursed = await (
    await fetch(`${PAYMENTS}/internal/v1/payouts/${ledgerId}`, {
      headers: trace({ 'x-commission-token': COMMISSION_TOKEN }),
    })
  ).json();
  check('disbursed_at is set', Boolean(disbursed.disbursed_at), true);
  check('b2c transaction recorded', Boolean(disbursed.b2c_transaction_id), true);

  console.log('5. replay the result callback');
  const replayResult = await fetch(`${PAYMENTS}/payments/b2c/callback`, {
    method: 'POST',
    headers: trace(signedResult.headers),
    body: signedResult.raw,
  });
  check('replayed result callback is a no-op', (await replayResult.json()).applied, false);

  const afterResultReplay = await (
    await fetch(`${PAYMENTS}/internal/v1/payouts/${ledgerId}`, {
      headers: trace({ 'x-commission-token': COMMISSION_TOKEN }),
    })
  ).json();
  check('disbursed_at did not move', afterResultReplay.disbursed_at, disbursed.disbursed_at);

  console.log('6. timeout payer never lands in pending');
  const timeoutSaleRes = await fetch(`${POS}/sales`, {
    method: 'POST',
    headers: trace({
      'x-tenant-id': TENANT_ID,
      'x-user-id': ATTENDANT_ID,
      'x-role': 'attendant',
      'idempotency-key': `g2-close-to-sale-${randomUUID().slice(0, 8)}`,
    }),
    body: JSON.stringify({ lines: [{ description: 'Mandazi', quantity: 1, unit_price_minor: 5000 }] }),
  });
  const timeoutSale = await timeoutSaleRes.json();
  const timeoutCharge = await (
    await fetch(`${PAYMENTS}/internal/v1/charges`, {
      method: 'POST',
      headers: trace({ 'x-pos-token': POS_TOKEN, 'idempotency-key': `g2-close-to-chg-${randomUUID().slice(0, 8)}` }),
      body: JSON.stringify({ sale_id: timeoutSale.id, msisdn: TEST_MSISDNS.SUCCESS }),
    })
  ).json();
  await mpesa.stkPush({
    shortcode: timeoutSale.mpesa_till || '174379',
    amountMinor: timeoutCharge.amount_minor,
    msisdn: TEST_MSISDNS.SUCCESS,
    accountReference: timeoutSale.id,
    transactionDesc: 'TillFlow',
    callbackUrl: `${PAYMENTS}/payments/callback`,
  });
  const stk2 = mpesa.signBody(mpesa.buildCallback(timeoutCharge.checkout_request_id), Date.now());
  await fetch(`${PAYMENTS}/payments/callback`, { method: 'POST', headers: trace(stk2.headers), body: stk2.raw });

  const timeoutAgent = randomUUID();
  const timeoutPeriod = period;
  const payoutBody = {
    tenant_id: TENANT_ID,
    agent_id: timeoutAgent,
    period: timeoutPeriod,
    msisdn: TEST_MSISDNS.PUSH_TIMEOUT,
    commission_bps: 500,
    sales: [timeoutSale.id],
  };
  const timeoutPayout = await fetch(`${PAYMENTS}/internal/v1/payouts`, {
    method: 'POST',
    headers: trace({ 'x-commission-token': COMMISSION_TOKEN, 'idempotency-key': `${timeoutAgent}:${timeoutPeriod}` }),
    body: JSON.stringify(payoutBody),
  });
  const timeoutLedger = await timeoutPayout.json();
  check('timeout payout is disbursing', timeoutLedger.status, 'disbursing');
  check('timeout payout is never pending', timeoutLedger.status === 'pending', false);
  check('timeout payout is never disbursed', timeoutLedger.status === 'disbursed', false);

  const timeoutReplay = await fetch(`${PAYMENTS}/internal/v1/payouts`, {
    method: 'POST',
    headers: trace({ 'x-commission-token': COMMISSION_TOKEN, 'idempotency-key': `${timeoutAgent}:${timeoutPeriod}` }),
    body: JSON.stringify(payoutBody),
  });
  const timeoutReplayBody = await timeoutReplay.json();
  check('replayed timeout close returns the same payout', timeoutReplayBody.id, timeoutLedger.id);
  check('replayed timeout close is flagged a replay', timeoutReplayBody.replay, true);

  const evidence = {
    captured_at: new Date().toISOString(),
    invariants: [
      'daily close creates one payout ledger row per agent per period',
      'daraja acceptance (responseCode 0) is not disbursement',
      'only the B2C result callback sets disbursed',
      'a replayed close creates no second ledger row and no second B2C',
      'a B2C timeout stays disbursing, never pending, never disbursed',
    ],
    trace_id: traceId,
    xray_trace_id: `1-${traceId.slice(0, 8)}-${traceId.slice(8)}`,
    traceparent,
    pos_base_url: POS,
    payments_base_url: PAYMENTS,
    mpesa_mode: 'fake',
    triggered_via: triggeredVia,
    sqs_message_id: messageId,
    period,
    sale_id: sale.id,
    payment_id: payment.id,
    ledger_id: ledgerId,
    originator_conversation_id: originator,
    b2c_transaction_id: disbursed.b2c_transaction_id,
    timeout_ledger_id: timeoutLedger.id,
    checks: steps,
    passed: failures === 0,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, 'g2-close-b2c.json');
  fs.writeFileSync(outFile, JSON.stringify(evidence, null, 2) + '\n');

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
  console.log(`evidence written to ${outFile}`);
  console.log(`X-Ray trace id: 1-${traceId.slice(0, 8)}-${traceId.slice(8)}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('close -> b2c evidence failed:', err);
  process.exit(2);
});
