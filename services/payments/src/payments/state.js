const STATUSES = Object.freeze({
  INITIATED: 'initiated',
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  PAID: 'paid',
  FAILED: 'failed',
  TIMED_OUT: 'timed_out',
});

const TERMINAL = Object.freeze([STATUSES.PAID, STATUSES.FAILED, STATUSES.TIMED_OUT]);

const RANK = Object.freeze({
  [STATUSES.INITIATED]: 0,
  [STATUSES.PENDING]: 1,
  [STATUSES.CONFIRMED]: 2,
  [STATUSES.PAID]: 3,
});

const ALLOWED = Object.freeze({
  [STATUSES.INITIATED]: [STATUSES.PENDING, STATUSES.FAILED],
  [STATUSES.PENDING]: [STATUSES.CONFIRMED, STATUSES.FAILED, STATUSES.TIMED_OUT],
  [STATUSES.CONFIRMED]: [STATUSES.PAID],
  [STATUSES.PAID]: [],
  [STATUSES.FAILED]: [],
  [STATUSES.TIMED_OUT]: [],
});

function isTerminal(status) {
  return TERMINAL.includes(status);
}

function onSuccessPath(status) {
  return Object.prototype.hasOwnProperty.call(RANK, status);
}

function canTransition(from, to) {
  return (ALLOWED[from] || []).includes(to);
}

function evaluate(from, to) {
  if (!Object.prototype.hasOwnProperty.call(ALLOWED, from)) {
    throw illegal(from, to, 'unknown current status');
  }
  if (!Object.prototype.hasOwnProperty.call(ALLOWED, to)) {
    throw illegal(from, to, 'unknown target status');
  }

  if (from === to) {
    return { action: 'noop', status: from, reason: 'reaffirm_same_state' };
  }

  if (onSuccessPath(from) && onSuccessPath(to) && RANK[to] < RANK[from]) {
    return { action: 'noop', status: from, reason: 'reaffirm_earlier_state' };
  }

  if (isTerminal(from)) {
    throw illegal(from, to, `${from} is terminal`);
  }

  if (!canTransition(from, to)) {
    throw illegal(from, to, 'not a legal edge');
  }

  return { action: 'transition', status: to };
}

function illegal(from, to, why) {
  const err = new Error(`illegal transition ${from} → ${to}: ${why}`);
  err.code = 'ILLEGAL_TRANSITION';
  err.status = 409;
  err.from = from;
  err.to = to;
  err.reason = why;
  return err;
}

function statusForResultCode(resultCode, { fromReconciliation = false } = {}) {
  const code = Number(resultCode);
  if (code === 0) return STATUSES.CONFIRMED;
  if (code === 1 || code === 1032 || code === 1001) return STATUSES.FAILED;
  if (code === 1037) {
    return fromReconciliation ? STATUSES.TIMED_OUT : null;
  }
  return null;
}

module.exports = {
  STATUSES,
  TERMINAL,
  RANK,
  ALLOWED,
  isTerminal,
  canTransition,
  evaluate,
  statusForResultCode,
};
