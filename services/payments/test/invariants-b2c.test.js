const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  db,
  request,
  randomUUID,
  resetData,
  createTestApp,
  commissionHeaders,
  postCallback,
  startCharge,
  countRows,
  NOW_MS,
} = require('./support/helpers');

const PERIOD = '2026-09-18';
const PAYEE_OK = '254700000000';
const PAYEE_TIMEOUT = '254700000003';
const PAYEE_REJECTED = '254700000001';

describe('b2c payout invariants', () => {
  let app;
  let mpesa;
  let pos;
  let b2cCalls;

  before(async () => {
    await db.checkReady();
  });

  beforeEach(async () => {
    await resetData();
    ({ app, mpesa, pos } = createTestApp());
    b2cCalls = [];
    const originalB2c = mpesa.b2c;
    mpesa.b2c = async (req) => {
      b2cCalls.push(req);
      return originalB2c(req);
    };
  });

  after(async () => {
    await db.closePool();
  });

  async function paidSale(tenantId, key) {
    const sale = pos.addSale({ tenant_id: tenantId });
    const { payment } = await startCharge(app, pos, { sale, key });
    const res = await postCallback(app, mpesa, mpesa.buildCallback(payment.checkout_request_id));
    assert.equal(res.body.status, 'paid');
    return sale;
  }

  async function openPayout({ msisdn = PAYEE_OK, agentId = randomUUID(), period = PERIOD } = {}) {
    const tenantId = randomUUID();
    const sale = await paidSale(tenantId, `b2c-${agentId.slice(0, 8)}`);
    const res = await request(app)
      .post('/internal/v1/payouts')
      .set(commissionHeaders({ 'idempotency-key': `${agentId}:${period}` }))
      .send({
        tenant_id: tenantId,
        agent_id: agentId,
        period,
        msisdn,
        commission_bps: 500,
        sales: [sale.id],
      });
    return { res, tenantId, agentId, period, sale };
  }

  function postB2cResult(body, { atMs = NOW_MS } = {}) {
    const signed = mpesa.signBody(body, atMs);
    return request(app)
      .post('/payments/b2c/callback')
      .set('content-type', 'application/json')
      .set(signed.headers)
      .send(signed.raw);
  }

  it('responseCode 0 means accepted, not disbursed', async () => {
    const { res } = await openPayout();

    assert.equal(res.status, 201);
    assert.equal(res.body.status, 'disbursing');
    assert.equal(res.body.disbursed_at, null, 'nothing is disbursed until the result callback');
    assert.ok(res.body.conversation_id, 'the accepted command is recorded');
    assert.ok(res.body.accepted_at);
    assert.equal(b2cCalls.length, 1);
  });

  it('the result callback is what moves a payout to disbursed', async () => {
    const { res } = await openPayout();
    const oc = res.body.originator_conversation_id;

    const cb = await postB2cResult(mpesa.buildB2cResultCallback(oc));
    assert.equal(cb.status, 200);
    assert.equal(cb.body.status, 'disbursed');

    const row = await db.query(
      `SELECT status, disbursed_at, b2c_transaction_id, b2c_result_code
       FROM payments.payout_ledger WHERE id = $1`,
      [res.body.id]
    );
    assert.equal(row.rows[0].status, 'disbursed');
    assert.ok(row.rows[0].disbursed_at);
    assert.ok(row.rows[0].b2c_transaction_id);
    assert.equal(row.rows[0].b2c_result_code, 0);
  });

  it('a Safaricom rejection in the result callback fails the payout', async () => {
    const { res } = await openPayout();
    const oc = res.body.originator_conversation_id;

    const cb = await postB2cResult(mpesa.buildB2cResultCallback(oc, { fail: true }));
    assert.equal(cb.status, 200);
    assert.equal(cb.body.status, 'failed');

    const row = await db.query(`SELECT status, disbursed_at FROM payments.payout_ledger WHERE id = $1`, [
      res.body.id,
    ]);
    assert.equal(row.rows[0].status, 'failed');
    assert.equal(row.rows[0].disbursed_at, null);
  });

  it('a replayed result callback does not disburse twice', async () => {
    const { res } = await openPayout();
    const oc = res.body.originator_conversation_id;
    const body = mpesa.buildB2cResultCallback(oc);

    const first = await postB2cResult(body);
    assert.equal(first.body.status, 'disbursed');
    const disbursedAt = (
      await db.query(`SELECT disbursed_at FROM payments.payout_ledger WHERE id = $1`, [res.body.id])
    ).rows[0].disbursed_at;

    for (let i = 0; i < 3; i += 1) {
      const replay = await postB2cResult(body);
      assert.equal(replay.status, 200);
      assert.equal(replay.body.applied, false);
    }

    const after = await db.query(
      `SELECT status, disbursed_at FROM payments.payout_ledger WHERE id = $1`,
      [res.body.id]
    );
    assert.equal(after.rows[0].status, 'disbursed');
    assert.deepEqual(after.rows[0].disbursed_at, disbursedAt, 'disbursed_at must not move');
    assert.equal(await countRows('payout_callback_log', "WHERE outcome = 'applied'"), 1);
    assert.equal(b2cCalls.length, 1);
  });

  it('a late failure cannot un-disburse a completed payout', async () => {
    const { res } = await openPayout();
    const oc = res.body.originator_conversation_id;

    await postB2cResult(mpesa.buildB2cResultCallback(oc));

    const late = await postB2cResult(mpesa.buildB2cResultCallback(oc, { fail: true }));
    assert.equal(late.status, 409);
    assert.equal(late.body.error, 'illegal_transition');

    const row = await db.query(`SELECT status FROM payments.payout_ledger WHERE id = $1`, [res.body.id]);
    assert.equal(row.rows[0].status, 'disbursed');
    assert.equal(
      await countRows('payout_callback_log', "WHERE outcome = 'rejected_illegal_transition'"),
      1
    );
  });

  it('a B2C timeout leaves the payout disbursing, never pending, and never retries', async () => {
    const { res } = await openPayout({ msisdn: PAYEE_TIMEOUT });

    assert.equal(res.status, 201);
    assert.equal(
      res.body.status,
      'disbursing',
      'a timeout is unknown — pending would let the daily close send a second B2C'
    );
    assert.notEqual(res.body.status, 'pending');
    assert.match(res.body.b2c_sync_error, /b2c_unknown|MPESA_TIMEOUT/);
    assert.equal(res.body.disbursed_at, null);
    assert.equal(b2cCalls.length, 1);
  });

  it('a replayed close after a B2C timeout does not send a second B2C', async () => {
    const agentId = randomUUID();
    const first = await openPayout({ msisdn: PAYEE_TIMEOUT, agentId });
    assert.equal(first.res.body.status, 'disbursing');

    const replay = await request(app)
      .post('/internal/v1/payouts')
      .set(commissionHeaders({ 'idempotency-key': `${agentId}:${PERIOD}` }))
      .send({
        tenant_id: first.tenantId,
        agent_id: agentId,
        period: PERIOD,
        msisdn: PAYEE_TIMEOUT,
        commission_bps: 500,
        sales: [first.sale.id],
      });

    assert.equal(replay.status, 200);
    assert.equal(replay.body.replay, true);
    assert.equal(b2cCalls.length, 1, 'exactly one B2C command despite the timeout');
    assert.equal(await countRows('payout_ledger'), 1);
  });

  it('reconciliation settles a payout whose result callback never arrived', async () => {
    const { res } = await openPayout({ msisdn: PAYEE_TIMEOUT });
    const oc = res.body.originator_conversation_id;

    const stillUnknown = await request(app)
      .post(`/internal/v1/payouts/${res.body.id}/reconcile`)
      .set(commissionHeaders())
      .send({});
    assert.equal(stillUnknown.body.status, 'disbursing');
    assert.equal(stillUnknown.body.reconcile_reason, 'still_processing');

    mpesa.settleB2c(oc);

    const settled = await request(app)
      .post(`/internal/v1/payouts/${res.body.id}/reconcile`)
      .set(commissionHeaders())
      .send({});
    assert.equal(settled.body.status, 'disbursed');
    assert.equal(b2cCalls.length, 1, 'reconciliation queries, it never re-sends');
  });

  it('a synchronous Daraja rejection fails the payout without a retry', async () => {
    const { res } = await openPayout({ msisdn: PAYEE_REJECTED });

    assert.equal(res.body.status, 'failed');
    assert.notEqual(res.body.status, 'pending');
    assert.match(res.body.failure_reason, /b2c_rejected/);
    assert.equal(b2cCalls.length, 1);
  });

  it('rejects unsigned, forged and unknown result callbacks', async () => {
    const { res } = await openPayout();
    const oc = res.body.originator_conversation_id;
    const body = mpesa.buildB2cResultCallback(oc);

    const unsigned = await request(app)
      .post('/payments/b2c/callback')
      .set('content-type', 'application/json')
      .send(JSON.stringify(body));
    assert.equal(unsigned.status, 401);

    const stale = await postB2cResult(body, { atMs: NOW_MS - 3600_000 });
    assert.equal(stale.status, 401);

    const unknown = await postB2cResult({
      Result: {
        ResultCode: 0,
        ResultDesc: 'ok',
        OriginatorConversationID: 'tillflow-nobody-2026-09-18',
        ConversationID: 'AG-forged',
        TransactionID: 'TXFORGED',
      },
    });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error, 'unknown_payout');

    const row = await db.query(`SELECT status FROM payments.payout_ledger WHERE id = $1`, [res.body.id]);
    assert.equal(row.rows[0].status, 'disbursing', 'no unauthenticated callback may disburse');
    assert.equal(await countRows('payout_callback_log', "WHERE outcome = 'rejected_bad_signature'"), 2);
  });

  it('a result callback carrying the wrong amount is rejected', async () => {
    const { res } = await openPayout();
    const oc = res.body.originator_conversation_id;
    const body = mpesa.buildB2cResultCallback(oc);
    body.Result.ResultParameters.ResultParameter = [
      { Key: 'TransactionAmount', Value: 99999 },
      { Key: 'TransactionReceipt', Value: 'TXWRONG' },
    ];

    const cb = await postB2cResult(body);
    assert.equal(cb.status, 409);
    assert.equal(cb.body.error, 'amount_mismatch');

    const row = await db.query(`SELECT status FROM payments.payout_ledger WHERE id = $1`, [res.body.id]);
    assert.equal(row.rows[0].status, 'disbursing');
  });
});
