const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  createMpesaClient,
  createFakeMpesaClient,
  TEST_MSISDNS,
  OUTCOMES,
  outcomeFor,
  MpesaTimeoutError,
  MpesaRejectedError,
  RESULT_CODES,
} = require('../../_shared/mpesa');

const NOW = Date.UTC(2026, 8, 10, 12, 0, 0);
const push = (msisdn, overrides = {}) => ({
  shortcode: '174379',
  amountMinor: 15000,
  msisdn,
  accountReference: 'sale-1',
  transactionDesc: 'TillFlow',
  callbackUrl: 'https://tillflow.test/payments/callback',
  ...overrides,
});

describe('fake daraja adapter', () => {
  let mpesa;

  beforeEach(() => {
    mpesa = createFakeMpesaClient({ callbackSecret: 'sekret', now: () => NOW });
  });

  it('is deterministic across clients and processes', async () => {
    const other = createFakeMpesaClient({ callbackSecret: 'sekret', now: () => NOW });
    const a = await mpesa.stkPush(push(TEST_MSISDNS.SUCCESS));
    const b = await other.stkPush(push(TEST_MSISDNS.SUCCESS));

    assert.equal(a.checkoutRequestId, b.checkoutRequestId);
    assert.equal(a.merchantRequestId, b.merchantRequestId);
  });

  it('derives different correlation ids for different sales', async () => {
    const a = await mpesa.stkPush(push(TEST_MSISDNS.SUCCESS, { accountReference: 'sale-1' }));
    const b = await mpesa.stkPush(push(TEST_MSISDNS.SUCCESS, { accountReference: 'sale-2' }));
    assert.notEqual(a.checkoutRequestId, b.checkoutRequestId);
  });

  it('maps each test MSISDN to its documented outcome', () => {
    assert.equal(outcomeFor(TEST_MSISDNS.SUCCESS), OUTCOMES.SUCCESS);
    assert.equal(outcomeFor(TEST_MSISDNS.INSUFFICIENT_FUNDS), OUTCOMES.INSUFFICIENT_FUNDS);
    assert.equal(outcomeFor(TEST_MSISDNS.CANCELLED), OUTCOMES.CANCELLED);
    assert.equal(outcomeFor(TEST_MSISDNS.PUSH_TIMEOUT), OUTCOMES.PUSH_TIMEOUT);
    assert.equal(outcomeFor(TEST_MSISDNS.NO_CALLBACK), OUTCOMES.NO_CALLBACK);
  });

  it('throws a timeout error that admits the outcome is unknown', async () => {
    await assert.rejects(
      mpesa.stkPush(push(TEST_MSISDNS.PUSH_TIMEOUT)),
      (err) => {
        assert.ok(err instanceof MpesaTimeoutError);
        assert.equal(err.outcomeKnown, false);
        assert.ok(err.checkoutRequestId, 'the correlation id must survive the timeout');
        return true;
      }
    );
  });

  it('keeps a timed-out push queryable, so reconciliation can settle it', async () => {
    let checkoutRequestId;
    try {
      await mpesa.stkPush(push(TEST_MSISDNS.PUSH_TIMEOUT));
    } catch (err) {
      checkoutRequestId = err.checkoutRequestId;
    }
    const query = await mpesa.stkQuery({ shortcode: '174379', checkoutRequestId });
    assert.equal(query.resultCode, RESULT_CODES.STILL_PROCESSING);
  });

  it('stays silent for the no-callback number', async () => {
    const res = await mpesa.stkPush(push(TEST_MSISDNS.NO_CALLBACK));
    assert.equal(res.responseCode, '0');
    assert.equal(mpesa.buildCallback(res.checkoutRequestId), null);
  });

  it('builds a Daraja-shaped success callback', async () => {
    const res = await mpesa.stkPush(push(TEST_MSISDNS.SUCCESS));
    const cb = mpesa.buildCallback(res.checkoutRequestId).Body.stkCallback;

    assert.equal(cb.ResultCode, 0);
    assert.equal(cb.CheckoutRequestID, res.checkoutRequestId);
    const amount = cb.CallbackMetadata.Item.find((i) => i.Name === 'Amount');
    assert.equal(amount.Value, 150, 'Daraja reports whole KES');
    assert.ok(cb.CallbackMetadata.Item.find((i) => i.Name === 'MpesaReceiptNumber').Value);
  });

  it('omits metadata on a declined callback', async () => {
    const res = await mpesa.stkPush(push(TEST_MSISDNS.INSUFFICIENT_FUNDS));
    const cb = mpesa.buildCallback(res.checkoutRequestId).Body.stkCallback;
    assert.equal(cb.ResultCode, 1);
    assert.equal(cb.CallbackMetadata, undefined);
  });

  it('validates its inputs rather than inventing a transaction', async () => {
    await assert.rejects(mpesa.stkPush(push('0700000000')), MpesaRejectedError);
    await assert.rejects(mpesa.stkPush(push(TEST_MSISDNS.SUCCESS, { amountMinor: 0 })), MpesaRejectedError);
    await assert.rejects(
      mpesa.stkPush(push(TEST_MSISDNS.SUCCESS, { accountReference: '' })),
      MpesaRejectedError
    );
    await assert.rejects(
      mpesa.stkQuery({ shortcode: '174379', checkoutRequestId: 'nope' }),
      MpesaRejectedError
    );
  });

  it('echoes our own idempotency key back from b2c', async () => {
    const result = await mpesa.b2c({
      shortcode: '600000',
      amountMinor: 1500,
      msisdn: TEST_MSISDNS.SUCCESS,
      remarks: 'commission',
      originatorConversationId: 'tillflow-agent-2026-09-10',
    });
    assert.equal(result.originatorConversationId, 'tillflow-agent-2026-09-10');
    assert.equal(result.responseCode, '0');

    const again = await mpesa.b2c({
      shortcode: '600000',
      amountMinor: 1500,
      msisdn: TEST_MSISDNS.SUCCESS,
      remarks: 'commission',
      originatorConversationId: 'tillflow-agent-2026-09-10',
    });
    assert.equal(again.conversationId, result.conversationId, 'deterministic');
  });
});

describe('client selection', () => {
  it('defaults to the fake', () => {
    assert.equal(createMpesaClient().mode, 'fake');
  });

  it('refuses to build a real client instead of silently reaching Safaricom', () => {
    assert.throws(
      () => createMpesaClient({ mode: 'daraja' }),
      (err) => err.code === 'MPESA_MODE_UNAVAILABLE'
    );
    assert.throws(
      () => createMpesaClient({ mode: 'nonsense' }),
      (err) => err.code === 'MPESA_MODE_INVALID'
    );
  });
});
