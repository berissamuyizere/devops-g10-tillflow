const RESULT_CODES = Object.freeze({
  SUCCESS: 0,
  INSUFFICIENT_FUNDS: 1,
    TIMEOUT_NO_USER_RESPONSE: 1037,
    CANCELLED_BY_USER: 1032,
    REQUEST_FAILED: 1001,
    STILL_PROCESSING: 1100,
});

class MpesaError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'MpesaError';
    this.code = code || 'MPESA_ERROR';
  }
}

class MpesaTimeoutError extends MpesaError {
  constructor(message, details = {}) {
    super(message || 'daraja did not respond', 'MPESA_TIMEOUT');
    this.name = 'MpesaTimeoutError';
    this.outcomeKnown = false;
    Object.assign(this, details);
  }
}

class MpesaRejectedError extends MpesaError {
  constructor(message, details = {}) {
    super(message || 'daraja rejected the command', 'MPESA_REJECTED');
    this.name = 'MpesaRejectedError';
    this.outcomeKnown = true;
    Object.assign(this, details);
  }
}

module.exports = {
  RESULT_CODES,
  MpesaError,
  MpesaTimeoutError,
  MpesaRejectedError,
};
