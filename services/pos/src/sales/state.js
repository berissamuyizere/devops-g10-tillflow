const STATUSES = Object.freeze({
  CREATED: 'created',
  AWAITING_PAYMENT: 'awaiting_payment',
  PAID: 'paid',
  CANCELLED: 'cancelled',
});

/** Who may request each transition. Payments-only for money path. */
const ACTORS = Object.freeze({
  POS: 'pos',
  PAYMENTS: 'payments',
});

/**
 * Legal transitions for the POS-owned sale state machine (ADR-001,
 * frozen for G2 by docs/contracts/pos-payments-api.md).
 *
 * G2 freeze: once a sale is `awaiting_payment` the attendant/owner can no
 * longer change it. Only Payments may transition it (→ paid), or leave it
 * pending for reconcile. This stops an attendant cancel from racing a
 * success callback and leaving money against a cancelled sale. A timeout
 * must never move awaiting_payment → cancelled/paid from POS.
 */
const ALLOWED = Object.freeze({
  [STATUSES.CREATED]: {
    [STATUSES.AWAITING_PAYMENT]: ACTORS.PAYMENTS,
    [STATUSES.CANCELLED]: ACTORS.POS,
  },
  [STATUSES.AWAITING_PAYMENT]: {
    [STATUSES.PAID]: ACTORS.PAYMENTS,
  },
  [STATUSES.PAID]: {},
  [STATUSES.CANCELLED]: {},
});

function canTransition(from, to, actor) {
  const next = ALLOWED[from];
  if (!next || !next[to]) {
    return false;
  }
  return next[to] === actor;
}

/**
 * Apply a transition. Replay of paid → paid is a no-op (returns same status).
 * Illegal transitions throw with code ILLEGAL_TRANSITION.
 */
function assertTransition(from, to, actor) {
  if (from === STATUSES.PAID && to === STATUSES.PAID && actor === ACTORS.PAYMENTS) {
    return { noop: true, status: STATUSES.PAID };
  }
  if (!canTransition(from, to, actor)) {
    const err = new Error(`illegal transition ${from} → ${to} by ${actor}`);
    err.code = 'ILLEGAL_TRANSITION';
    err.from = from;
    err.to = to;
    err.actor = actor;
    throw err;
  }
  return { noop: false, status: to };
}

module.exports = {
  STATUSES,
  ACTORS,
  canTransition,
  assertTransition,
};
