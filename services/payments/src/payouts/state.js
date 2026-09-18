const LEDGER_STATUSES = Object.freeze({
  PENDING: 'pending',
  DISBURSING: 'disbursing',
  DISBURSED: 'disbursed',
  FAILED: 'failed',
});

const TERMINAL = Object.freeze([LEDGER_STATUSES.DISBURSED, LEDGER_STATUSES.FAILED]);

const RANK = Object.freeze({
  [LEDGER_STATUSES.PENDING]: 0,
  [LEDGER_STATUSES.DISBURSING]: 1,
  [LEDGER_STATUSES.DISBURSED]: 2,
});

const ALLOWED = Object.freeze({
  [LEDGER_STATUSES.PENDING]: [LEDGER_STATUSES.DISBURSING, LEDGER_STATUSES.FAILED],
  [LEDGER_STATUSES.DISBURSING]: [LEDGER_STATUSES.DISBURSED, LEDGER_STATUSES.FAILED],
  [LEDGER_STATUSES.DISBURSED]: [],
  [LEDGER_STATUSES.FAILED]: [],
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

function illegal(from, to, why) {
  const err = new Error(`illegal payout transition ${from} -> ${to}: ${why}`);
  err.code = 'ILLEGAL_TRANSITION';
  err.status = 409;
  err.from = from;
  err.to = to;
  err.reason = why;
  return err;
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

function statusForB2cResultCode(resultCode) {
  const code = Number(resultCode);
  if (!Number.isFinite(code)) return null;
  if (code === 0) return LEDGER_STATUSES.DISBURSED;
  if (code === 1100) return null;
  return LEDGER_STATUSES.FAILED;
}

module.exports = {
  LEDGER_STATUSES,
  TERMINAL,
  RANK,
  ALLOWED,
  isTerminal,
  canTransition,
  evaluate,
  statusForB2cResultCode,
};
