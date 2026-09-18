const crypto = require('crypto');
const { RESULT_CODES, MpesaTimeoutError, MpesaRejectedError } = require('./interface');
const signature = require('./signature');

const OUTCOMES = Object.freeze({
  SUCCESS: 'success',
  INSUFFICIENT_FUNDS: 'insufficient_funds',
  CANCELLED: 'cancelled',
  PUSH_TIMEOUT: 'push_timeout',
  NO_CALLBACK: 'no_callback',
});

const TEST_MSISDNS = Object.freeze({
  SUCCESS: '254700000000',
  INSUFFICIENT_FUNDS: '254700000001',
  CANCELLED: '254700000002',
  PUSH_TIMEOUT: '254700000003',
  NO_CALLBACK: '254700000004',
});

const B2C_OUTCOMES = Object.freeze({
  ACCEPTED: 'accepted',
  TIMEOUT: 'timeout',
  REJECTED: 'rejected',
});

const B2C_RESULT_CODES = Object.freeze({
  SUCCESS: 0,
  INSUFFICIENT_BALANCE: 2001,
  INVALID_RECIPIENT: 2006,
});

function b2cOutcomeFor(msisdn) {
  switch (String(msisdn).slice(-1)) {
    case '3':
      return B2C_OUTCOMES.TIMEOUT;
    case '1':
      return B2C_OUTCOMES.REJECTED;
    default:
      return B2C_OUTCOMES.ACCEPTED;
  }
}

function outcomeFor(msisdn) {
  switch (String(msisdn).slice(-1)) {
    case '1':
      return OUTCOMES.INSUFFICIENT_FUNDS;
    case '2':
      return OUTCOMES.CANCELLED;
    case '3':
      return OUTCOMES.PUSH_TIMEOUT;
    case '4':
      return OUTCOMES.NO_CALLBACK;
    default:
      return OUTCOMES.SUCCESS;
  }
}

function derivedId(prefix, ...parts) {
  const digest = crypto
    .createHash('sha256')
    .update(parts.map(String).join('|'), 'utf8')
    .digest('hex');
  return `${prefix}-${digest.slice(0, 12)}`;
}

function validateMsisdn(msisdn) {
  if (!/^2547\d{8}$/.test(String(msisdn || ''))) {
    throw new MpesaRejectedError('invalid msisdn', { field: 'msisdn' });
  }
}

function validateAmount(amountMinor) {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw new MpesaRejectedError('amount must be a positive integer', {
      field: 'amountMinor',
    });
  }
}

function createFakeMpesaClient(options = {}) {
  const callbackSecret = options.callbackSecret || 'dev-callback-secret';
  const now = options.now || (() => Date.now());

    const inflight = new Map();

  async function stkPush(req) {
    validateMsisdn(req.msisdn);
    validateAmount(req.amountMinor);
    if (!req.accountReference) {
      throw new MpesaRejectedError('accountReference required', {
        field: 'accountReference',
      });
    }

    const outcome = outcomeFor(req.msisdn);
    const merchantRequestId = derivedId('mr', req.accountReference, req.msisdn);
    const checkoutRequestId = derivedId(
      'ws_CO',
      req.accountReference,
      req.msisdn,
      req.amountMinor
    );

    if (outcome === OUTCOMES.PUSH_TIMEOUT) {
      inflight.set(checkoutRequestId, {
        outcome,
        req,
        merchantRequestId,
        acceptedAt: now(),
        settled: false,
      });
      throw new MpesaTimeoutError('daraja did not respond to stk push', {
        checkoutRequestId,
        merchantRequestId,
      });
    }

    inflight.set(checkoutRequestId, {
      outcome,
      req,
      merchantRequestId,
      acceptedAt: now(),
      settled: false,
    });

    return {
      merchantRequestId,
      checkoutRequestId,
      responseCode: '0',
      responseDescription: 'Success. Request accepted for processing',
      customerMessage: 'Success. Request accepted for processing',
    };
  }

  function resultFor(outcome) {
    switch (outcome) {
      case OUTCOMES.SUCCESS:
        return { resultCode: RESULT_CODES.SUCCESS, resultDesc: 'The service request is processed successfully.' };
      case OUTCOMES.INSUFFICIENT_FUNDS:
        return { resultCode: RESULT_CODES.INSUFFICIENT_FUNDS, resultDesc: 'The balance is insufficient for the transaction.' };
      case OUTCOMES.CANCELLED:
        return { resultCode: RESULT_CODES.CANCELLED_BY_USER, resultDesc: 'Request cancelled by user' };
      case OUTCOMES.PUSH_TIMEOUT:
      case OUTCOMES.NO_CALLBACK:

        return { resultCode: RESULT_CODES.STILL_PROCESSING, resultDesc: 'The transaction is being processed' };
      default:
        return { resultCode: RESULT_CODES.REQUEST_FAILED, resultDesc: 'Unknown' };
    }
  }

  async function stkQuery(req) {
    const entry = inflight.get(req.checkoutRequestId);
    if (!entry) {
      throw new MpesaRejectedError('unknown checkoutRequestId', {
        checkoutRequestId: req.checkoutRequestId,
      });
    }
    const { resultCode, resultDesc } = resultFor(entry.outcome);
    const success = resultCode === RESULT_CODES.SUCCESS;
    return {
      merchantRequestId: entry.merchantRequestId,
      checkoutRequestId: req.checkoutRequestId,
      resultCode,
      resultDesc,
      mpesaReceipt: success ? receiptFor(req.checkoutRequestId) : null,
      amountMinor: success ? entry.req.amountMinor : null,
    };
  }

  function receiptFor(checkoutRequestId) {
    return derivedId('R', checkoutRequestId).replace('-', '').toUpperCase().slice(0, 10);
  }

  function verifyCallback(rawBody, headers = {}) {
    const header =
      headers[signature.SIGNATURE_HEADER] || headers[signature.SIGNATURE_HEADER.toUpperCase()];
    return signature.verify(rawBody, header, callbackSecret, { now });
  }

  const b2cInflight = new Map();

  async function b2c(req) {
    validateMsisdn(req.msisdn);
    validateAmount(req.amountMinor);
    if (!req.originatorConversationId) {
      throw new MpesaRejectedError('originatorConversationId required', {
        field: 'originatorConversationId',
      });
    }

    const outcome = b2cOutcomeFor(req.msisdn);
    const conversationId = derivedId('AG', req.originatorConversationId);

    b2cInflight.set(req.originatorConversationId, {
      outcome,
      req,
      conversationId,
      acceptedAt: now(),
    });

    if (outcome === B2C_OUTCOMES.TIMEOUT) {
      throw new MpesaTimeoutError('daraja did not respond to b2c', {
        originatorConversationId: req.originatorConversationId,
        conversationId,
      });
    }

    if (outcome === B2C_OUTCOMES.REJECTED) {
      throw new MpesaRejectedError('insufficient balance on the shortcode', {
        originatorConversationId: req.originatorConversationId,
        responseCode: '1',
      });
    }

    return {
      conversationId,
      originatorConversationId: req.originatorConversationId,
      responseCode: '0',
      responseDescription: 'Accept the service request successfully.',
    };
  }

  async function b2cQuery(req) {
    const entry = b2cInflight.get(req.originatorConversationId);
    if (!entry) {
      throw new MpesaRejectedError('unknown originatorConversationId', {
        originatorConversationId: req.originatorConversationId,
      });
    }
    const settled = entry.outcome !== B2C_OUTCOMES.TIMEOUT || entry.settled === true;
    if (!settled) {
      return {
        originatorConversationId: req.originatorConversationId,
        conversationId: entry.conversationId,
        resultCode: RESULT_CODES.STILL_PROCESSING,
        resultDesc: 'The transaction is being processed',
        transactionId: null,
      };
    }
    const failed = entry.outcome === B2C_OUTCOMES.REJECTED;
    return {
      originatorConversationId: req.originatorConversationId,
      conversationId: entry.conversationId,
      resultCode: failed ? B2C_RESULT_CODES.INSUFFICIENT_BALANCE : B2C_RESULT_CODES.SUCCESS,
      resultDesc: failed ? 'Insufficient balance' : 'The service request is processed successfully.',
      transactionId: failed ? null : derivedId('TX', req.originatorConversationId).toUpperCase(),
    };
  }

  function buildB2cResultCallback(originatorConversationId, overrides = {}) {
    const entry = b2cInflight.get(originatorConversationId);
    if (!entry) return null;
    const failed = overrides.fail === true || entry.outcome === B2C_OUTCOMES.REJECTED;
    const resultCode =
      overrides.resultCode ?? (failed ? B2C_RESULT_CODES.INSUFFICIENT_BALANCE : 0);
    const transactionId =
      overrides.transactionId ?? derivedId('TX', originatorConversationId).toUpperCase();

    return {
      Result: {
        ResultType: 0,
        ResultCode: resultCode,
        ResultDesc: overrides.resultDesc ?? (failed ? 'Insufficient balance' : 'The service request is processed successfully.'),
        OriginatorConversationID: overrides.originatorConversationId ?? originatorConversationId,
        ConversationID: entry.conversationId,
        TransactionID: resultCode === 0 ? transactionId : null,
        ResultParameters:
          resultCode === 0
            ? {
                ResultParameter: [
                  { Key: 'TransactionAmount', Value: entry.req.amountMinor / 100 },
                  { Key: 'TransactionReceipt', Value: transactionId },
                  { Key: 'ReceiverPartyPublicName', Value: entry.req.msisdn },
                ],
              }
            : undefined,
      },
    };
  }

  function settleB2c(originatorConversationId) {
    const entry = b2cInflight.get(originatorConversationId);
    if (entry) entry.settled = true;
  }

    function buildCallback(checkoutRequestId, overrides = {}) {
    const entry = inflight.get(checkoutRequestId);
    if (!entry) return null;
    if (entry.outcome === OUTCOMES.NO_CALLBACK || entry.outcome === OUTCOMES.PUSH_TIMEOUT) {
      return null;
    }
    return buildCallbackBody(entry, checkoutRequestId, overrides);
  }

  function buildCallbackBody(entry, checkoutRequestId, overrides = {}) {
    const { resultCode, resultDesc } = resultFor(entry.outcome);
    const code = overrides.resultCode ?? resultCode;
    const amountMinor = overrides.amountMinor ?? entry.req.amountMinor;
    const metadata =
      code === RESULT_CODES.SUCCESS
        ? {
            Item: [
              { Name: 'Amount', Value: amountMinor / 100 },
              { Name: 'MpesaReceiptNumber', Value: overrides.mpesaReceipt ?? receiptFor(checkoutRequestId) },
              { Name: 'PhoneNumber', Value: Number(entry.req.msisdn) },
              { Name: 'TransactionDate', Value: 20260910120000 },
            ],
          }
        : undefined;

    return {
      Body: {
        stkCallback: {
          MerchantRequestID: entry.merchantRequestId,
          CheckoutRequestID: overrides.checkoutRequestId ?? checkoutRequestId,
          ResultCode: code,
          ResultDesc: overrides.resultDesc ?? resultDesc,
          ...(metadata ? { CallbackMetadata: metadata } : {}),
        },
      },
    };
  }

    function signBody(body, atMs = now()) {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    return {
      raw,
      headers: { [signature.SIGNATURE_HEADER]: signature.sign(raw, callbackSecret, atMs / 1000) },
    };
  }

    function settle(checkoutRequestId, outcome) {
    const entry = inflight.get(checkoutRequestId);
    if (entry) {
      entry.outcome = outcome;
      entry.settled = true;
    }
  }

  function reset() {
    inflight.clear();
    b2cInflight.clear();
  }

  return {
    stkPush,
    stkQuery,
    verifyCallback,
    b2c,
    b2cQuery,

    buildCallback,
    buildB2cResultCallback,
    signBody,
    settle,
    settleB2c,
    reset,
    mode: 'fake',
  };
}

module.exports = {
  createFakeMpesaClient,
  outcomeFor,
  b2cOutcomeFor,
  OUTCOMES,
  B2C_OUTCOMES,
  B2C_RESULT_CODES,
  TEST_MSISDNS,
};
