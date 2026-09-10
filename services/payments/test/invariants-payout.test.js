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
} = require('./support/helpers');

const PERIOD = '2026-09-10';

describe('payout invariants', () => {
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

  function payoutBody(overrides = {}) {
    return {
      tenant_id: overrides.tenant_id,
      agent_id: overrides.agent_id,
      period: overrides.period || PERIOD,
      msisdn: overrides.msisdn || '254700000000',
      commission_bps: overrides.commission_bps ?? 500,
      sales: overrides.sales || [],
    };
  }

  it('replayed daily close → one ledger entry, one B2C', async () => {
    const tenantId = randomUUID();
    const agentId = randomUUID();
    const saleA = await paidSale(tenantId, 'p-a');
    const saleB = await paidSale(tenantId, 'p-b');

    const body = payoutBody({
      tenant_id: tenantId,
      agent_id: agentId,
      sales: [saleA.id, saleB.id],
    });

    const first = await request(app)
      .post('/internal/v1/payouts')
      .set(commissionHeaders({ 'idempotency-key': `${agentId}:${PERIOD}` }))
      .send(body);

    assert.equal(first.status, 201);
    assert.equal(first.body.status, 'disbursed');

    assert.equal(first.body.gross_sales_minor, 30000);
    assert.equal(first.body.amount_minor, 1500);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const replay = await request(app)
        .post('/internal/v1/payouts')
        .set(commissionHeaders({ 'idempotency-key': `${agentId}:${PERIOD}` }))
        .send(body);
      assert.equal(replay.status, 200);
      assert.equal(replay.body.replay, true);
      assert.equal(replay.body.id, first.body.id);
    }

    assert.equal(await countRows('payout_ledger'), 1, 'one ledger entry');
    assert.equal(b2cCalls.length, 1, 'one B2C disbursement');
    assert.equal(
      b2cCalls[0].originatorConversationId,
      `tillflow-${agentId}-${PERIOD}`,
      'the B2C command carries our own idempotency key'
    );
  });

  it('a second close for the same agent and period cannot create a second row', async () => {
    const tenantId = randomUUID();
    const agentId = randomUUID();
    const sale = await paidSale(tenantId, 'p-c');

    const res = await request(app)
      .post('/internal/v1/payouts')
      .set(commissionHeaders())
      .send(payoutBody({ tenant_id: tenantId, agent_id: agentId, sales: [sale.id] }));
    assert.equal(res.status, 201);

    await assert.rejects(
      db.query(
        `INSERT INTO payments.payout_ledger (
           tenant_id, agent_id, period, idempotency_key, request_hash, status,
           gross_sales_minor, commission_bps, amount_minor, msisdn,
           originator_conversation_id
         ) VALUES ($1, $2, $3, 'other-key', 'other-hash', 'pending',
                   15000, 500, 750, '254700000000', 'other-originator')`,
        [tenantId, agentId, PERIOD]
      ),
      (err) => err.constraint === 'payout_ledger_agent_period_unique',
      'the (agent_id, period) unique constraint is the real guard'
    );
  });

  it('unpaid sales are never eligible for payout', async () => {
    const tenantId = randomUUID();
    const agentId = randomUUID();

    const unpaid = pos.addSale({ tenant_id: tenantId });
    await startCharge(app, pos, { sale: unpaid, key: 'unpaid' });

    const res = await request(app)
      .post('/internal/v1/payouts')
      .set(commissionHeaders())
      .send(payoutBody({ tenant_id: tenantId, agent_id: agentId, sales: [unpaid.id] }));

    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'NO_ELIGIBLE_SALES');
    assert.equal(await countRows('payout_ledger'), 0);
    assert.equal(b2cCalls.length, 0);
  });

  it('commission is computed from our own paid payments, not from Commission input', async () => {
    const tenantId = randomUUID();
    const agentId = randomUUID();
    const paid = await paidSale(tenantId, 'mixed-paid');
    const unpaid = pos.addSale({ tenant_id: tenantId });
    await startCharge(app, pos, { sale: unpaid, key: 'mixed-unpaid' });
    const ghost = randomUUID();

    const res = await request(app)
      .post('/internal/v1/payouts')
      .set(commissionHeaders())
      .send(
        payoutBody({
          tenant_id: tenantId,
          agent_id: agentId,
          sales: [paid.id, unpaid.id, ghost],
        })
      );

    assert.equal(res.status, 201);
    assert.equal(res.body.gross_sales_minor, 15000, 'only the paid sale counts');
    assert.equal(res.body.amount_minor, 750);

    const backing = await db.query(
      `SELECT sale_id FROM payments.payout_ledger_sales WHERE ledger_id = $1`,
      [res.body.id]
    );
    assert.equal(backing.rowCount, 1);
    assert.equal(backing.rows[0].sale_id, paid.id);
  });

  it('a sale cannot back two payouts', async () => {
    const tenantId = randomUUID();
    const sale = await paidSale(tenantId, 'double-dip');

    const first = await request(app)
      .post('/internal/v1/payouts')
      .set(commissionHeaders())
      .send(payoutBody({ tenant_id: tenantId, agent_id: randomUUID(), sales: [sale.id] }));
    assert.equal(first.status, 201);

    const second = await request(app)
      .post('/internal/v1/payouts')
      .set(commissionHeaders())
      .send(
        payoutBody({
          tenant_id: tenantId,
          agent_id: randomUUID(),
          period: '2026-09-11',
          sales: [sale.id],
        })
      );

    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'SALE_ALREADY_PAID_OUT');
    assert.equal(await countRows('payout_ledger'), 1);
    assert.equal(b2cCalls.length, 1);
  });

  it('requires the Commission service token, and the POS token does not work', async () => {
    const body = payoutBody({ tenant_id: randomUUID(), agent_id: randomUUID(), sales: [] });

    const none = await request(app).post('/internal/v1/payouts').send(body);
    assert.equal(none.status, 401);

    const wrongToken = await request(app)
      .post('/internal/v1/payouts')
      .set({ 'x-pos-token': 'dev-pos-token' })
      .send(body);
    assert.equal(wrongToken.status, 401);
    assert.equal(b2cCalls.length, 0);
  });

  it('validates period, msisdn and commission_bps', async () => {
    const base = { tenant_id: randomUUID(), agent_id: randomUUID(), sales: [randomUUID()] };

    for (const bad of [
      { ...base, period: '10-09-2026', msisdn: '254700000000', commission_bps: 500 },
      { ...base, period: PERIOD, msisdn: '0700000000', commission_bps: 500 },
      { ...base, period: PERIOD, msisdn: '254700000000', commission_bps: 20000 },
    ]) {
      const res = await request(app).post('/internal/v1/payouts').set(commissionHeaders()).send(bad);
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.equal(res.body.error, 'VALIDATION');
    }
    assert.equal(await countRows('payout_ledger'), 0);
  });
});
