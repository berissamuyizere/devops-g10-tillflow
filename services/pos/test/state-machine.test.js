const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { STATUSES, ACTORS, canTransition, assertTransition } = require('../src/sales/state');

describe('sale state machine helpers', () => {
  it('allows Payments created → awaiting_payment → paid', () => {
    assert.equal(
      canTransition(STATUSES.CREATED, STATUSES.AWAITING_PAYMENT, ACTORS.PAYMENTS),
      true
    );
    assert.equal(
      canTransition(STATUSES.AWAITING_PAYMENT, STATUSES.PAID, ACTORS.PAYMENTS),
      true
    );
  });

  it('rejects POS attempting awaiting_payment or paid', () => {
    assert.equal(
      canTransition(STATUSES.CREATED, STATUSES.AWAITING_PAYMENT, ACTORS.POS),
      false
    );
    assert.equal(
      canTransition(STATUSES.AWAITING_PAYMENT, STATUSES.PAID, ACTORS.POS),
      false
    );
  });

  it('allows POS cancel from created or awaiting_payment, not from paid', () => {
    assert.equal(canTransition(STATUSES.CREATED, STATUSES.CANCELLED, ACTORS.POS), true);
    assert.equal(
      canTransition(STATUSES.AWAITING_PAYMENT, STATUSES.CANCELLED, ACTORS.POS),
      true
    );
    assert.equal(canTransition(STATUSES.PAID, STATUSES.CANCELLED, ACTORS.POS), false);
  });

  it('paid replay is a no-op for Payments', () => {
    const result = assertTransition(STATUSES.PAID, STATUSES.PAID, ACTORS.PAYMENTS);
    assert.equal(result.noop, true);
  });

  it('throws on illegal transition', () => {
    assert.throws(
      () => assertTransition(STATUSES.CREATED, STATUSES.PAID, ACTORS.PAYMENTS),
      (err) => err.code === 'ILLEGAL_TRANSITION'
    );
  });
});
