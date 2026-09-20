const { trace } = require('@opentelemetry/api');

const ATTR = Object.freeze({
  PAYMENT_ID: 'payment.id',
  SALE_ID: 'sale.id',
  CHECKOUT_REQUEST_ID: 'checkout_request_id',
  CALLBACK_OUTCOME: 'callback.outcome',
  LEDGER_ID: 'ledger.id',
});

function annotate(attributes = {}) {
  const span = trace.getActiveSpan();
  if (!span) return false;
  const clean = {};
  for (const [k, v] of Object.entries(attributes)) {
    if (v === undefined || v === null || v === '') continue;
    clean[k] = typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : String(v);
  }
  if (Object.keys(clean).length === 0) return false;
  span.setAttributes(clean);
  return true;
}

function annotatePayment(payment) {
  if (!payment) return false;
  return annotate({
    [ATTR.PAYMENT_ID]: payment.id,
    [ATTR.SALE_ID]: payment.sale_id,
    [ATTR.CHECKOUT_REQUEST_ID]: payment.checkout_request_id,
  });
}

function annotateLedger(ledger) {
  if (!ledger) return false;
  return annotate({ [ATTR.LEDGER_ID]: ledger.id });
}

function annotateCallbackOutcome(outcome) {
  return annotate({ [ATTR.CALLBACK_OUTCOME]: outcome });
}

module.exports = { ATTR, annotate, annotatePayment, annotateLedger, annotateCallbackOutcome };
