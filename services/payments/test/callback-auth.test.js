const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const signature = require('../../_shared/mpesa/signature');
const { hashCallback } = require('../src/hash');
const { parseEnvelope } = require('../src/payments/callbacks');

const SECRET = 'test-callback-secret';
const T = 1757505600;
const now = () => T * 1000;

describe('callback signature', () => {
  const body = JSON.stringify({ Body: { stkCallback: { ResultCode: 0 } } });

  it('round-trips a signature it produced', () => {
    const header = signature.sign(body, SECRET, T);
    assert.deepEqual(signature.verify(body, header, SECRET, { now }), {
      valid: true,
      reason: null,
    });
  });

  it('rejects a tampered body', () => {
    const header = signature.sign(body, SECRET, T);
    const tampered = JSON.stringify({ Body: { stkCallback: { ResultCode: 1 } } });
    assert.equal(signature.verify(tampered, header, SECRET, { now }).reason, 'signature_mismatch');
  });

  it('rejects the wrong secret', () => {
    const header = signature.sign(body, 'not-the-secret', T);
    assert.equal(signature.verify(body, header, SECRET, { now }).reason, 'signature_mismatch');
  });

  it('rejects a missing or malformed header', () => {
    for (const header of [undefined, '', 'garbage', 'v1=abc', 't=abc,v1=def']) {
      assert.equal(
        signature.verify(body, header, SECRET, { now }).reason,
        'signature_header_malformed'
      );
    }
  });

  it('rejects a stale timestamp in either direction', () => {
    const old = signature.sign(body, SECRET, T - 600);
    assert.equal(
      signature.verify(body, old, SECRET, { now }).reason,
      'signature_timestamp_outside_tolerance'
    );

    const future = signature.sign(body, SECRET, T + 600);
    assert.equal(
      signature.verify(body, future, SECRET, { now }).reason,
      'signature_timestamp_outside_tolerance'
    );
  });

  it('binds the timestamp into the MAC', () => {
    const header = signature.sign(body, SECRET, T - 600);
    const restamped = header.replace(/^t=\d+/, `t=${T}`);
    assert.equal(signature.verify(body, restamped, SECRET, { now }).reason, 'signature_mismatch');
  });

  it('refuses to verify when no secret is configured', () => {
    const header = signature.sign(body, SECRET, T);
    assert.equal(signature.verify(body, header, '', { now }).reason, 'signing_secret_missing');
  });
});

describe('callback canonicalisation', () => {
  const envelope = (overrides = {}) => ({
    Body: {
      stkCallback: {
        MerchantRequestID: 'mr-1',
        CheckoutRequestID: 'ws_CO-1',
        ResultCode: 0,
        ResultDesc: 'ok',
        CallbackMetadata: {
          Item: [
            { Name: 'Amount', Value: 150 },
            { Name: 'MpesaReceiptNumber', Value: 'RCP1' },
          ],
        },
        ...overrides,
      },
    },
  });

  it('hashes semantic content, so key order and whitespace do not matter', () => {
    const reordered = {
      Body: {
        stkCallback: {
          ResultDesc: 'ok',
          ResultCode: 0,
          CheckoutRequestID: 'ws_CO-1',
          MerchantRequestID: 'mr-1',
          CallbackMetadata: {
            Item: [
              { Name: 'MpesaReceiptNumber', Value: 'RCP1' },
              { Name: 'Amount', Value: 150 },
            ],
          },
        },
      },
    };
    assert.equal(hashCallback(envelope()), hashCallback(reordered));
  });

  it('gives a different hash to a different outcome', () => {
    assert.notEqual(hashCallback(envelope()), hashCallback(envelope({ ResultCode: 1032 })));
  });

  it('converts Daraja whole-KES amounts to minor units', () => {
    assert.equal(parseEnvelope(envelope()).amountMinor, 15000);
  });

  it('returns null for anything that is not a Daraja envelope', () => {
    for (const bad of [{}, { Body: {} }, { Body: { stkCallback: {} } }, null]) {
      assert.equal(parseEnvelope(bad), null);
    }
  });
});
