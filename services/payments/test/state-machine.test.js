const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  STATUSES: S,
  evaluate,
  canTransition,
  isTerminal,
  statusForResultCode,
} = require('../src/payments/state');

describe('payment state machine', () => {
  it('walks the success path', () => {
    assert.equal(evaluate(S.INITIATED, S.PENDING).action, 'transition');
    assert.equal(evaluate(S.PENDING, S.CONFIRMED).action, 'transition');
    assert.equal(evaluate(S.CONFIRMED, S.PAID).action, 'transition');
  });

  it('never allows a jump straight to paid', () => {
    for (const from of [S.INITIATED, S.PENDING]) {
      assert.throws(() => evaluate(from, S.PAID), (err) => err.code === 'ILLEGAL_TRANSITION');
    }
  });

  it('treats an exact repeat as a re-affirming no-op', () => {
    for (const status of Object.values(S)) {
      const result = evaluate(status, status);
      assert.equal(result.action, 'noop');
      assert.equal(result.reason, 'reaffirm_same_state');
    }
  });

  it('treats an out-of-order earlier state as a re-affirming no-op', () => {
    const result = evaluate(S.PAID, S.CONFIRMED);
    assert.equal(result.action, 'noop');
    assert.equal(result.reason, 'reaffirm_earlier_state');
    assert.equal(result.status, S.PAID, 'the payment stays where it is');

    assert.equal(evaluate(S.CONFIRMED, S.PENDING).action, 'noop');
  });

  it('refuses to move out of any terminal state', () => {
    assert.equal(isTerminal(S.PAID), true);
    assert.equal(isTerminal(S.FAILED), true);
    assert.equal(isTerminal(S.TIMED_OUT), true);
    assert.equal(isTerminal(S.PENDING), false);

    assert.throws(() => evaluate(S.PAID, S.FAILED), (err) => err.code === 'ILLEGAL_TRANSITION');

    assert.throws(() => evaluate(S.FAILED, S.CONFIRMED), (err) => err.code === 'ILLEGAL_TRANSITION');
    assert.throws(() => evaluate(S.TIMED_OUT, S.PAID), (err) => err.code === 'ILLEGAL_TRANSITION');
  });

  it('does not allow timed_out from initiated — only from pending', () => {
    assert.equal(canTransition(S.INITIATED, S.TIMED_OUT), false);
    assert.equal(canTransition(S.PENDING, S.TIMED_OUT), true);
  });

  it('rejects unknown states rather than guessing', () => {
    assert.throws(() => evaluate('banana', S.PAID), (err) => err.code === 'ILLEGAL_TRANSITION');
    assert.throws(() => evaluate(S.PENDING, 'banana'), (err) => err.code === 'ILLEGAL_TRANSITION');
  });

  describe('result code mapping', () => {
    it('only 0 means money moved', () => {
      assert.equal(statusForResultCode(0), S.CONFIRMED);
    });

    it('maps explicit declines to failed', () => {
      assert.equal(statusForResultCode(1), S.FAILED, 'insufficient funds');
      assert.equal(statusForResultCode(1032), S.FAILED, 'cancelled by user');
      assert.equal(statusForResultCode(1001), S.FAILED, 'request failed');
    });

    it('treats 1037 as silence on a callback, and terminal only on reconcile', () => {
      assert.equal(statusForResultCode(1037), null);
      assert.equal(statusForResultCode(1037, { fromReconciliation: true }), S.TIMED_OUT);
    });

    it('maps "still processing" to no transition at all', () => {
      assert.equal(statusForResultCode(1100), null);
      assert.equal(statusForResultCode(1100, { fromReconciliation: true }), null);
    });
  });
});
