const { describe, it, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  db,
  request,
  resetData,
  createTestApp,
  posHeaders,
  postCallback,
  startCharge,
  TEST_MSISDNS,
} = require('./support/helpers');

describe('POS wiring (frozen contract)', () => {
  let app;
  let mpesa;
  let pos;

  before(async () => {
    await db.checkReady();
  });

  beforeEach(async () => {
    await resetData();
    ({ app, mpesa, pos } = createTestApp());
  });

  after(async () => {
    await db.closePool();
  });

  it('drives the sale created -> awaiting_payment -> paid, and never writes sale rows', async () => {
    const { sale, payment } = await startCharge(app, pos);

    assert.equal(pos.calls.getSale, 1, 'the amount is read from POS, not from the request');
    assert.equal(pos.sales.get(sale.id).status, 'awaiting_payment');
    assert.equal(payment.amount_minor, 15000);

    const row = await db.query(
      `SELECT pos_awaiting_synced_at, pos_sync_error FROM payments.payments WHERE id = $1`,
      [payment.id]
    );
    assert.ok(row.rows[0].pos_awaiting_synced_at, 'the awaiting-payment sync is recorded');
    assert.equal(row.rows[0].pos_sync_error, null);

    const cb = await postCallback(app, mpesa, mpesa.buildCallback(payment.checkout_request_id));
    assert.equal(cb.body.status, 'paid');
    assert.equal(pos.sales.get(sale.id).status, 'paid');

    const after = await db.query(
      `SELECT pos_paid_synced_at FROM payments.payments WHERE id = $1`,
      [payment.id]
    );
    assert.ok(after.rows[0].pos_paid_synced_at);

    const tables = await db.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'payments'`
    );
    const names = tables.rows.map((r) => r.table_name);
    assert.ok(!names.includes('sales'), 'Payments must never own sale rows');
    assert.ok(!names.includes('sale_lines'));
  });

  it('a POS 409 on awaiting-payment is recorded, and never fails the payment', async () => {
    const sale = pos.addSale();
    const originalGet = pos.getSale;
    pos.getSale = async (id) => {
      const snapshot = { ...(await originalGet(id)) };

      pos.sales.get(id).status = 'cancelled';
      return snapshot;
    };

    const { payment } = await startCharge(app, pos, { sale, key: 'raced' });

    assert.equal(
      payment.status,
      'pending',
      'money may have moved — a POS conflict must not fail the payment'
    );

    const row = await db.query(
      `SELECT pos_sync_error, pos_awaiting_synced_at FROM payments.payments WHERE id = $1`,
      [payment.id]
    );
    assert.match(row.rows[0].pos_sync_error, /POS_CONFLICT/);
    assert.equal(row.rows[0].pos_awaiting_synced_at, null, 'not synced, and we know it');
  });

  it('a POS outage during charge leaves the payment pending and recoverable', async () => {
    const sale = pos.addSale();
    pos.control.down = true;

    const { payment } = await startCharge(app, pos, { sale, key: 'pos-down' });
    assert.equal(payment.status, 'pending');

    const row = await db.query(`SELECT pos_sync_error FROM payments.payments WHERE id = $1`, [
      payment.id,
    ]);
    assert.match(row.rows[0].pos_sync_error, /POS_UNAVAILABLE/);

    pos.control.down = false;
    const sweep = await request(app)
      .post('/internal/v1/pos-sync/sweep')
      .set(posHeaders())
      .send({});

    assert.equal(sweep.status, 200);
    assert.equal(sweep.body.resynced, 1);
    assert.equal(pos.sales.get(sale.id).status, 'awaiting_payment');

    const after = await db.query(
      `SELECT pos_awaiting_synced_at, pos_sync_error FROM payments.payments WHERE id = $1`,
      [payment.id]
    );
    assert.ok(after.rows[0].pos_awaiting_synced_at);
    assert.equal(after.rows[0].pos_sync_error, null);
  });

  it('a POS outage during settle leaves the payment confirmed, then the sweeper finishes it', async () => {
    const { sale, payment } = await startCharge(app, pos, { key: 'settle-outage' });

    pos.control.down = true;
    const cb = await postCallback(app, mpesa, mpesa.buildCallback(payment.checkout_request_id));
    assert.equal(cb.status, 503, 'a non-2xx makes Daraja retry rather than believe we handled it');

    const stuck = await db.query(
      `SELECT status, pos_sync_error, pos_paid_synced_at FROM payments.payments WHERE id = $1`,
      [payment.id]
    );
    assert.equal(stuck.rows[0].status, 'confirmed', 'confirmed, not paid — POS does not know yet');
    assert.match(stuck.rows[0].pos_sync_error, /POS_UNAVAILABLE/);
    assert.equal(stuck.rows[0].pos_paid_synced_at, null);
    assert.equal(pos.sales.get(sale.id).status, 'awaiting_payment');

    pos.control.down = false;
    const sweep = await request(app)
      .post('/internal/v1/pos-sync/sweep')
      .set(posHeaders())
      .send({});

    assert.equal(sweep.body.settled, 1);
    assert.equal(pos.sales.get(sale.id).status, 'paid');

    const settled = await db.query(
      `SELECT status, pos_paid_synced_at FROM payments.payments WHERE id = $1`,
      [payment.id]
    );
    assert.equal(settled.rows[0].status, 'paid');
    assert.ok(settled.rows[0].pos_paid_synced_at);
  });

  it('the sweeper is idempotent — a second run changes nothing', async () => {
    const { payment } = await startCharge(app, pos, { key: 'sweep-twice' });
    await postCallback(app, mpesa, mpesa.buildCallback(payment.checkout_request_id));

    const first = await request(app).post('/internal/v1/pos-sync/sweep').set(posHeaders()).send({});
    const second = await request(app).post('/internal/v1/pos-sync/sweep').set(posHeaders()).send({});

    assert.equal(first.body.scanned, 0, 'nothing is stuck after a clean happy path');
    assert.equal(second.body.scanned, 0);
    assert.equal(pos.calls.markPaid, 1, 'no redundant POS writes');
  });

  it('a declined payment never touches POS beyond awaiting_payment', async () => {
    const { sale, payment } = await startCharge(app, pos, {
      msisdn: TEST_MSISDNS.INSUFFICIENT_FUNDS,
      key: 'declined',
    });

    await postCallback(app, mpesa, mpesa.buildCallback(payment.checkout_request_id));

    assert.equal(pos.calls.markPaid, 0);
    assert.equal(
      pos.sales.get(sale.id).status,
      'awaiting_payment',
      'Payments never cancels a sale — POS decides that'
    );
  });

  it('presents the service token POS expects', async () => {
    const seen = [];
    const posClient = require('../src/pos/client').createPosClient({
      baseUrl: 'http://pos.test',
      token: 'tok-abc',
      fetch: async (url, init) => {
        seen.push({ url, headers: init.headers, method: init.method });
        return new Response(JSON.stringify({ id: 'x' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    await posClient.getSale('sale-1');
    await posClient.markAwaitingPayment('sale-1', 'pay-1');
    await posClient.markPaid('sale-1', 'pay-1', new Date('2026-09-14T12:00:00Z'));

    assert.equal(seen.length, 3);
    for (const call of seen) {
      assert.equal(call.headers['x-payments-token'], 'tok-abc');
    }
    assert.equal(seen[0].url, 'http://pos.test/internal/v1/sales/sale-1');
    assert.equal(seen[1].url, 'http://pos.test/internal/v1/sales/sale-1/awaiting-payment');
    assert.equal(seen[2].url, 'http://pos.test/internal/v1/sales/sale-1/paid');
  });

  it('maps POS responses to typed errors', async () => {
    const { createPosClient, PosConflictError, PosUnavailableError } = require('../src/pos/client');
    const clientFor = (status, body = {}) =>
      createPosClient({
        baseUrl: 'http://pos.test',
        fetch: async () =>
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          }),
      });

    assert.equal(await clientFor(404).getSale('x'), null);
    await assert.rejects(
      clientFor(409, { error: 'ILLEGAL_TRANSITION' }).markPaid('x', 'p', new Date()),
      PosConflictError
    );
    await assert.rejects(clientFor(503).getSale('x'), PosUnavailableError);
    await assert.rejects(clientFor(500).getSale('x'), PosUnavailableError);

    const unreachable = createPosClient({
      baseUrl: 'http://pos.test',
      fetch: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    await assert.rejects(unreachable.getSale('x'), PosUnavailableError);
  });
});
