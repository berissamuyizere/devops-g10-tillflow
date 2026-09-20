const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const signature = require('../../_shared/mpesa/signature');
const { parseEnvelope } = require('../src/payments/callbacks');

let core;

describe('k6 callback helper', () => {
  before(async () => {
    core = await import('../scripts/k6/callback-core.mjs');
  });

  it('signs the same bytes the server verifies', () => {
    const body = JSON.stringify({ Body: { stkCallback: { ResultCode: 0 } } });
    const secret = 'shared-secret';
    const t = 1789900000;

    const mac = crypto
      .createHmac('sha256', secret)
      .update(core.signedPayload(t, body), 'utf8')
      .digest('hex');
    const header = core.signatureHeader(t, mac);

    assert.equal(
      header,
      signature.sign(body, secret, t),
      'the k6 header must be byte-identical to the server signer'
    );

    const verified = signature.verify(body, header, secret, { now: () => t * 1000 });
    assert.deepEqual(verified, { valid: true, reason: null });
  });

  it('uses the header name the server reads', () => {
    assert.equal(core.SIGNATURE_HEADER, signature.SIGNATURE_HEADER);
    assert.equal(core.SCHEME, signature.SCHEME);
  });

  it('builds an envelope the server can parse', () => {
    const body = core.buildStkCallback({
      checkoutRequestId: 'ws_CO_k6',
      amountMinor: 15000,
    });
    const parsed = parseEnvelope(body);

    assert.ok(parsed, 'the server parses it');
    assert.equal(parsed.checkoutRequestId, 'ws_CO_k6');
    assert.equal(parsed.resultCode, 0);
    assert.equal(parsed.amountMinor, 15000, 'whole KES on the wire, minor units parsed back');
    assert.ok(parsed.mpesaReceipt);
  });

  it('builds a decline envelope without metadata', () => {
    const body = core.buildStkCallback({
      checkoutRequestId: 'ws_CO_k6',
      amountMinor: 15000,
      resultCode: 1032,
      resultDesc: 'Request cancelled by user',
    });
    assert.equal(body.Body.stkCallback.CallbackMetadata, undefined);
    assert.equal(parseEnvelope(body).resultCode, 1032);
  });

  it('a signature outside the tolerance window is rejected, as the server would', () => {
    const body = JSON.stringify({ Body: { stkCallback: { ResultCode: 0 } } });
    const secret = 's';
    const t = 1789900000;
    const mac = crypto
      .createHmac('sha256', secret)
      .update(core.signedPayload(t, body), 'utf8')
      .digest('hex');

    const stale = signature.verify(body, core.signatureHeader(t, mac), secret, {
      now: () => (t + 3600) * 1000,
    });
    assert.equal(stale.reason, 'signature_timestamp_outside_tolerance');
  });
});
