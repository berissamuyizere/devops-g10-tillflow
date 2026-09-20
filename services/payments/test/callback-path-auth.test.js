const { describe, it, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  db,
  request,
  resetData,
  createTestApp,
  startCharge,
  countRows,
  TEST_MSISDNS,
} = require('./support/helpers');
const pathAuth = require('../src/payments/path-auth');

const PATH_SECRET = 'tillflow-sandbox-path-secret';
const SAFARICOM_IP = '196.201.212.69';
const SAFARICOM_RANGE = '196.201.212.0/24';

describe('secret-path callback auth', () => {
  it('accepts the configured secret', () => {
    const v = pathAuth.verifyPath({ presented: PATH_SECRET, configured: PATH_SECRET, ip: SAFARICOM_IP });
    assert.deepEqual(v, { valid: true, reason: 'secret_path', configured: true });
  });

  it('refuses a wrong secret without leaking length', () => {
    for (const presented of ['', 'x', `${PATH_SECRET}x`, PATH_SECRET.slice(0, -1)]) {
      const v = pathAuth.verifyPath({ presented, configured: PATH_SECRET, ip: SAFARICOM_IP });
      assert.equal(v.valid, false);
      assert.equal(v.reason, 'path_secret_mismatch');
    }
  });

  it('fails closed when no path secret is configured', () => {
    for (const configured of [undefined, null, '', '   ']) {
      const v = pathAuth.verifyPath({ presented: PATH_SECRET, configured, ip: SAFARICOM_IP });
      assert.equal(v.valid, false);
      assert.equal(v.configured, false);
    }
  });

  it('enforces the allowlist only when one is set', () => {
    const open = pathAuth.verifyPath({ presented: PATH_SECRET, configured: PATH_SECRET, ip: '8.8.8.8' });
    assert.equal(open.valid, true);

    const closed = pathAuth.verifyPath({
      presented: PATH_SECRET,
      configured: PATH_SECRET,
      ip: '8.8.8.8',
      allowlist: SAFARICOM_RANGE,
    });
    assert.equal(closed.valid, false);
    assert.equal(closed.reason, 'source_ip_not_allowed');
  });

  it('matches Safaricom addresses inside the published range', () => {
    for (const ip of [SAFARICOM_IP, '196.201.212.1', '196.201.212.255', '::ffff:196.201.212.69']) {
      assert.equal(pathAuth.ipMatches(ip, SAFARICOM_RANGE), true, ip);
    }
    for (const ip of ['196.201.213.69', '8.8.8.8', 'not-an-ip', '']) {
      assert.equal(pathAuth.ipMatches(ip, SAFARICOM_RANGE), false, ip);
    }
  });

  it('reads the client address from the edge header', () => {
    assert.equal(
      pathAuth.sourceIp({ headers: { 'x-forwarded-for': `${SAFARICOM_IP}, 10.20.0.1` } }),
      SAFARICOM_IP
    );
    assert.equal(pathAuth.sourceIp({ headers: {}, socket: { remoteAddress: '::ffff:10.0.0.9' } }), '10.0.0.9');
  });
});

describe('POST /callbacks/mpesa/:secret', () => {
  before(async () => {
    await db.checkReady();
  });

  beforeEach(async () => {
    await resetData();
  });

  function appWithPath(extra = {}) {
    return createTestApp({
      appOptions: {
        callbackPathSecret: PATH_SECRET,
        reconcileSweep: false,
        metricsRefresh: false,
        ...extra,
      },
    });
  }

  async function pendingPayment(app, pos, mpesa) {
    const { payment } = await startCharge(app, pos, { msisdn: TEST_MSISDNS.SUCCESS });
    const body = mpesa.buildCallback(payment.checkout_request_id);
    return { payment, body };
  }

  it('settles an unsigned Daraja callback on the secret path', async () => {
    const { app, mpesa, pos } = appWithPath();
    const { payment, body } = await pendingPayment(app, pos, mpesa);

    const res = await request(app)
      .post(`/callbacks/mpesa/${PATH_SECRET}`)
      .set('content-type', 'application/json')
      .send(body);

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, 'paid');

    const row = await db.query('SELECT status FROM payments.payments WHERE id = $1', [payment.id]);
    assert.equal(row.rows[0].status, 'paid');
  });

  it('refuses a wrong secret and logs the rejection', async () => {
    const { app, mpesa, pos } = appWithPath();
    const { payment, body } = await pendingPayment(app, pos, mpesa);

    const res = await request(app)
      .post('/callbacks/mpesa/not-the-secret')
      .set('content-type', 'application/json')
      .send(body);

    assert.equal(res.status, 401);
    assert.equal(res.body.reason, 'path_secret_mismatch');

    const row = await db.query('SELECT status FROM payments.payments WHERE id = $1', [payment.id]);
    assert.equal(row.rows[0].status, 'pending', 'a refused callback must not settle anything');
    assert.ok((await countRows('callback_log', "WHERE outcome = 'rejected_bad_signature'")) >= 1);
  });

  it('refuses a source address outside the allowlist', async () => {
    const { app, mpesa, pos } = appWithPath({ callbackIpAllowlist: SAFARICOM_RANGE });
    const { payment, body } = await pendingPayment(app, pos, mpesa);

    const blocked = await request(app)
      .post(`/callbacks/mpesa/${PATH_SECRET}`)
      .set('content-type', 'application/json')
      .set('x-forwarded-for', '8.8.8.8')
      .send(body);
    assert.equal(blocked.status, 401);
    assert.equal(blocked.body.reason, 'source_ip_not_allowed');

    const allowed = await request(app)
      .post(`/callbacks/mpesa/${PATH_SECRET}`)
      .set('content-type', 'application/json')
      .set('x-forwarded-for', `${SAFARICOM_IP}, 10.20.0.1`)
      .send(body);
    assert.equal(allowed.status, 200);

    const row = await db.query('SELECT status FROM payments.payments WHERE id = $1', [payment.id]);
    assert.equal(row.rows[0].status, 'paid');
  });

  it('is 500, not 401, when the path secret is unset', async () => {
    const { app, mpesa, pos } = createTestApp({
      appOptions: { callbackPathSecret: null, reconcileSweep: false, metricsRefresh: false },
    });
    const { body } = await pendingPayment(app, pos, mpesa);

    const res = await request(app)
      .post(`/callbacks/mpesa/${PATH_SECRET}`)
      .set('content-type', 'application/json')
      .send(body);

    assert.equal(res.status, 500);
    assert.equal(res.body.error, 'misconfigured');
  });

  it('is reachable on the edge-routed /payments prefix too', async () => {
    const { app, mpesa, pos } = appWithPath();
    const { payment, body } = await pendingPayment(app, pos, mpesa);

    const res = await request(app)
      .post(`/payments/callbacks/${PATH_SECRET}`)
      .set('content-type', 'application/json')
      .send(body);

    assert.equal(res.status, 200, 'the ALB only forwards /payments/* to this service');
    assert.equal((await db.query('SELECT status FROM payments.payments WHERE id = $1', [payment.id])).rows[0].status, 'paid');
  });

  it('absorbs a byte-identical replay on the secret path', async () => {
    const { app, mpesa, pos } = appWithPath();
    const { payment, body } = await pendingPayment(app, pos, mpesa);

    const send = () =>
      request(app)
        .post(`/callbacks/mpesa/${PATH_SECRET}`)
        .set('content-type', 'application/json')
        .send(body);

    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 200);

    const row = await db.query('SELECT status, paid_at, mpesa_receipt FROM payments.payments WHERE id = $1', [
      payment.id,
    ]);
    assert.equal(row.rows[0].status, 'paid');
    assert.equal(await countRows('callback_log', "WHERE outcome = 'applied'"), 1);
  });
});
