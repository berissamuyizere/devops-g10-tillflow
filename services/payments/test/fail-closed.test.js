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
  TEST_MSISDNS,
} = require('./support/helpers');

function withoutEnv(names, fn) {
  const saved = {};
  for (const n of names) {
    saved[n] = process.env[n];
    delete process.env[n];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const n of names) {
        if (saved[n] === undefined) delete process.env[n];
        else process.env[n] = saved[n];
      }
    });
}

describe('service tokens fail closed', () => {
  let app;
  let pos;

  before(async () => {
    await db.checkReady();
  });

  beforeEach(async () => {
    await resetData();
    ({ app, pos } = createTestApp());
  });

  after(async () => {
    await db.closePool();
  });

  it('there is no in-process default for the POS token', async () => {
    const sale = pos.addSale();
    await withoutEnv(['POS_SERVICE_TOKEN'], async () => {
      const res = await request(app)
        .post('/internal/v1/charges')
        .set({ 'x-pos-token': 'dev-pos-token', 'idempotency-key': 'k' })
        .send({ sale_id: sale.id, msisdn: TEST_MSISDNS.SUCCESS });

      assert.equal(res.status, 500, 'missing config must fail closed, not accept a known value');
      assert.equal(res.body.error, 'misconfigured');
    });
    assert.equal(await countRows('payments'), 0);
  });

  it('there is no in-process default for the Commission token', async () => {
    await withoutEnv(['COMMISSION_SERVICE_TOKEN'], async () => {
      const res = await request(app)
        .post('/internal/v1/payouts')
        .set({ 'x-commission-token': 'dev-commission-token' })
        .send({ tenant_id: randomUUID(), agent_id: randomUUID(), period: '2026-09-19' });

      assert.equal(res.status, 500);
      assert.equal(res.body.error, 'misconfigured');
    });
    assert.equal(await countRows('payout_ledger'), 0);
  });

  it('an empty token env is treated as unset', async () => {
    const saved = process.env.COMMISSION_SERVICE_TOKEN;
    process.env.COMMISSION_SERVICE_TOKEN = '   ';
    try {
      const res = await request(app)
        .post('/internal/v1/payouts')
        .set({ 'x-commission-token': '   ' })
        .send({ tenant_id: randomUUID(), agent_id: randomUUID(), period: '2026-09-19' });
      assert.equal(res.status, 500);
    } finally {
      process.env.COMMISSION_SERVICE_TOKEN = saved;
    }
  });

  it('still rejects a wrong token with 401 when configured', async () => {
    const res = await request(app)
      .post('/internal/v1/payouts')
      .set({ 'x-commission-token': 'nope' })
      .send({ tenant_id: randomUUID(), agent_id: randomUUID(), period: '2026-09-19' });
    assert.equal(res.status, 401);
  });

  it('callbacks fail closed when no signing secret is configured', async () => {
    const savedSecret = process.env.DARAJA_CALLBACK_SECRET;
    delete process.env.DARAJA_CALLBACK_SECRET;
    let built;
    try {
      built = createTestApp({ appOptions: { callbackSecret: null } });
    } finally {
      if (savedSecret === undefined) delete process.env.DARAJA_CALLBACK_SECRET;
      else process.env.DARAJA_CALLBACK_SECRET = savedSecret;
    }
    const { app: noSecret, mpesa, pos: pos2 } = built;
    const { payment } = await startCharge(noSecret, pos2, { key: 'nosecret' });
    const body = mpesa.buildCallback(payment.checkout_request_id);

    for (const path of ['/payments/callback', '/payments/b2c/callback']) {
      const res = await request(noSecret)
        .post(path)
        .set('content-type', 'application/json')
        .send(JSON.stringify(body));
      assert.equal(res.status, 500, `${path} must not process callbacks without a secret`);
      assert.equal(res.body.error, 'misconfigured');
    }

    const after = await db.query(`SELECT status FROM payments.payments WHERE id = $1`, [payment.id]);
    assert.equal(after.rows[0].status, 'pending');
  });
});

describe('a stranded pending payout is resumed', () => {
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
    const original = mpesa.b2c;
    mpesa.b2c = async (req) => {
      b2cCalls.push(req);
      return original(req);
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

  it('a replayed close sends a payout that was left pending by a crash', async () => {
    const tenantId = randomUUID();
    const agentId = randomUUID();
    const sale = await paidSale(tenantId, 'stranded');

    const body = {
      tenant_id: tenantId,
      agent_id: agentId,
      period: '2026-09-19',
      msisdn: '254700000000',
      commission_bps: 500,
      sales: [sale.id],
    };

    const first = await request(app)
      .post('/internal/v1/payouts')
      .set(commissionHeaders({ 'idempotency-key': `${agentId}:2026-09-19` }))
      .send(body);
    assert.equal(first.status, 201);
    assert.equal(b2cCalls.length, 1);

    // Simulate the crash: the row exists but the B2C never went out.
    await db.query(
      `UPDATE payments.payout_ledger
       SET status = 'pending', conversation_id = NULL, accepted_at = NULL
       WHERE id = $1`,
      [first.body.id]
    );
    b2cCalls.length = 0;

    const replay = await request(app)
      .post('/internal/v1/payouts')
      .set(commissionHeaders({ 'idempotency-key': `${agentId}:2026-09-19` }))
      .send(body);

    assert.equal(replay.status, 200);
    assert.equal(replay.body.id, first.body.id, 'still one ledger row');
    assert.equal(replay.body.resumed, true);
    assert.equal(replay.body.status, 'disbursing', 'the stranded payout was actually sent');
    assert.equal(b2cCalls.length, 1, 'exactly one B2C for the resumed payout');
    assert.equal(await countRows('payout_ledger'), 1);
  });

  it('a replayed close does not re-send an already disbursing payout', async () => {
    const tenantId = randomUUID();
    const agentId = randomUUID();
    const sale = await paidSale(tenantId, 'no-resend');

    const body = {
      tenant_id: tenantId,
      agent_id: agentId,
      period: '2026-09-19',
      msisdn: '254700000000',
      commission_bps: 500,
      sales: [sale.id],
    };
    const headers = commissionHeaders({ 'idempotency-key': `${agentId}:2026-09-19` });

    await request(app).post('/internal/v1/payouts').set(headers).send(body);
    assert.equal(b2cCalls.length, 1);

    const replay = await request(app).post('/internal/v1/payouts').set(headers).send(body);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replay, true);
    assert.notEqual(replay.body.resumed, true);
    assert.equal(b2cCalls.length, 1, 'no second B2C');
  });
});
