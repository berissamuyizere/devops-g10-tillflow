const { STATUSES, statusForResultCode, evaluate } = require('./state');
const { hashCallback } = require('../hash');
const paymentsService = require('./service');
const signature = require('../../../_shared/mpesa/signature');

const UNIQUE_VIOLATION = '23505';

const OUTCOMES = Object.freeze({
  APPLIED: 'applied',
  REPLAY_NOOP: 'replay_noop',
  REJECTED_BAD_SIGNATURE: 'rejected_bad_signature',
  REJECTED_UNKNOWN_PAYMENT: 'rejected_unknown_payment',
  REJECTED_AMOUNT_MISMATCH: 'rejected_amount_mismatch',
  REJECTED_ILLEGAL_TRANSITION: 'rejected_illegal_transition',
  REJECTED_MALFORMED: 'rejected_malformed',
});

const HTTP_STATUS = Object.freeze({
  [OUTCOMES.APPLIED]: 200,
  [OUTCOMES.REPLAY_NOOP]: 200,
  [OUTCOMES.REJECTED_BAD_SIGNATURE]: 401,
  [OUTCOMES.REJECTED_UNKNOWN_PAYMENT]: 404,
  [OUTCOMES.REJECTED_AMOUNT_MISMATCH]: 409,
  [OUTCOMES.REJECTED_ILLEGAL_TRANSITION]: 409,
  [OUTCOMES.REJECTED_MALFORMED]: 400,
});

function parseEnvelope(body) {
  const stk = body?.Body?.stkCallback;
  if (!stk || typeof stk !== 'object') return null;
  const checkoutRequestId = stk.CheckoutRequestID;
  const resultCode = Number(stk.ResultCode);
  if (!checkoutRequestId || !Number.isFinite(resultCode)) return null;

  const items = Array.isArray(stk.CallbackMetadata?.Item) ? stk.CallbackMetadata.Item : [];
  const meta = {};
  for (const item of items) {
    if (item && typeof item.Name === 'string') meta[item.Name] = item.Value;
  }

  const amount = meta.Amount;
  const amountMinor =
    amount === undefined || amount === null ? null : Math.round(Number(amount) * 100);

  return {
    merchantRequestId: stk.MerchantRequestID ?? null,
    checkoutRequestId: String(checkoutRequestId),
    resultCode,
    resultDesc: stk.ResultDesc ?? null,
    mpesaReceipt: meta.MpesaReceiptNumber ? String(meta.MpesaReceiptNumber) : null,
    amountMinor: Number.isFinite(amountMinor) ? amountMinor : null,
  };
}

async function insertLog(client, entry) {
  const res = await client.query(
    `INSERT INTO payments.callback_log (
       payment_id, checkout_request_id, callback_hash, signature_valid,
       signature_reason, outcome, result_code, notes, raw_body
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      entry.paymentId || null,
      entry.checkoutRequestId || null,
      entry.callbackHash,
      entry.signatureValid,
      entry.signatureReason || null,
      entry.outcome,
      entry.resultCode ?? null,
      entry.notes || null,
      entry.rawBody,
    ]
  );
  return res.rows[0].id;
}

async function writeLog(db, entry) {
  try {
    await db.withTransaction((client) => insertLog(client, entry));
    return { logged: true, duplicate: false };
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION) {
      return { logged: false, duplicate: true };
    }
    throw err;
  }
}


async function handleCallback(
  db,
  pos,
  { rawBody, headers, secret, now = () => Date.now(), logger }
) {
  const log = (outcome, extra = {}) => ({ outcome, ...extra });

  const headerValue = headers?.[signature.SIGNATURE_HEADER];
  const verification = signature.verify(rawBody, headerValue, secret, { now });

  let parsedBody;
  try {
    parsedBody = JSON.parse(rawBody);
  } catch {
    parsedBody = null;
  }

  const callbackHash = parsedBody
    ? hashCallback(parsedBody)
    : require('../hash').sha256(String(rawBody));

  if (!verification.valid) {
    await writeLog(db, {
      callbackHash,
      signatureValid: false,
      signatureReason: verification.reason,
      outcome: OUTCOMES.REJECTED_BAD_SIGNATURE,
      rawBody: parsedBody ?? { unparseable: String(rawBody).slice(0, 2000) },
    });
    logger?.warn({ reason: verification.reason }, 'callback_signature_rejected');
    return {
      status: HTTP_STATUS[OUTCOMES.REJECTED_BAD_SIGNATURE],
      ...log(OUTCOMES.REJECTED_BAD_SIGNATURE),
      body: { error: 'unauthorized', reason: verification.reason },
    };
  }

  const envelope = parsedBody ? parseEnvelope(parsedBody) : null;
  if (!envelope) {
    await writeLog(db, {
      callbackHash,
      signatureValid: true,
      outcome: OUTCOMES.REJECTED_MALFORMED,
      rawBody: parsedBody ?? { unparseable: String(rawBody).slice(0, 2000) },
    });
    return {
      status: HTTP_STATUS[OUTCOMES.REJECTED_MALFORMED],
      ...log(OUTCOMES.REJECTED_MALFORMED),
      body: { error: 'malformed_callback' },
    };
  }

  const payment = await paymentsService.findByCheckoutRequestId(
    db,
    envelope.checkoutRequestId
  );

  if (!payment) {
    await writeLog(db, {
      checkoutRequestId: envelope.checkoutRequestId,
      callbackHash,
      signatureValid: true,
      outcome: OUTCOMES.REJECTED_UNKNOWN_PAYMENT,
      resultCode: envelope.resultCode,
      rawBody: parsedBody,
    });
    logger?.warn(
      { checkout_request_id: envelope.checkoutRequestId },
      'callback_unknown_payment'
    );
    return {
      status: HTTP_STATUS[OUTCOMES.REJECTED_UNKNOWN_PAYMENT],
      ...log(OUTCOMES.REJECTED_UNKNOWN_PAYMENT),
      body: { error: 'unknown_payment' },
    };
  }

  const settled = await db
    .withTransaction(async (client) => {
      const row = await paymentsService.lockPayment(client, payment.id);
      if (!row) {
        return { outcome: OUTCOMES.REJECTED_UNKNOWN_PAYMENT, body: { error: 'unknown_payment' } };
      }

      const writeRow = async (outcome, notes) => {
        try {
          return await insertLog(client, {
            paymentId: row.id,
            checkoutRequestId: envelope.checkoutRequestId,
            callbackHash,
            signatureValid: true,
            outcome,
            resultCode: envelope.resultCode,
            notes,
            rawBody: parsedBody,
          });
        } catch (err) {
          if (err.code === UNIQUE_VIOLATION) {
            const dup = new Error('duplicate applied callback');
            dup.code = 'DUPLICATE_APPLIED';
            dup.status = row.status;
            throw dup;
          }
          throw err;
        }
      };

      if (envelope.resultCode === 0 && envelope.amountMinor !== row.amount_minor) {
        await writeRow(
          OUTCOMES.REJECTED_AMOUNT_MISMATCH,
          `callback ${envelope.amountMinor} != sale ${row.amount_minor}`
        );
        return {
          outcome: OUTCOMES.REJECTED_AMOUNT_MISMATCH,
          body: { error: 'amount_mismatch' },
          payment: paymentsService.mapPayment(row),
        };
      }

      const target = statusForResultCode(envelope.resultCode, { fromReconciliation: false });

      if (!target) {
        await writeRow(
          OUTCOMES.REPLAY_NOOP,
          `result_code ${envelope.resultCode} is not terminal`
        );
        return {
          outcome: OUTCOMES.REPLAY_NOOP,
          body: { status: row.status, applied: false },
          payment: paymentsService.mapPayment(row),
        };
      }

      let decision;
      try {
        decision = evaluate(row.status, target);
      } catch (err) {
        if (err.code !== 'ILLEGAL_TRANSITION') throw err;
        await writeRow(OUTCOMES.REJECTED_ILLEGAL_TRANSITION, err.message);
        return {
          outcome: OUTCOMES.REJECTED_ILLEGAL_TRANSITION,
          body: { error: 'illegal_transition', from: row.status, to: target },
          payment: paymentsService.mapPayment(row),
        };
      }

      if (decision.action === 'noop') {
        await writeRow(OUTCOMES.REPLAY_NOOP, decision.reason);
        return {
          outcome: OUTCOMES.REPLAY_NOOP,
          body: { status: row.status, applied: false, replay: true },
          payment: paymentsService.mapPayment(row),
        };
      }

      const patch =
        target === STATUSES.CONFIRMED
          ? {
              mpesa_receipt: envelope.mpesaReceipt,
              result_code: envelope.resultCode,
              confirmed_at: new Date(now()),
            }
          : {
              result_code: envelope.resultCode,
              failure_reason: envelope.resultDesc,
            };

      const applied = await paymentsService.applyTransition(client, row, target, patch);
      await writeRow(OUTCOMES.APPLIED, null);

      return {
        outcome: OUTCOMES.APPLIED,
        body: { status: applied.payment.status, applied: true },
        payment: applied.payment,
      };
    })
    .catch((err) => {
      if (err.code === 'DUPLICATE_APPLIED') {
        return {
          outcome: OUTCOMES.REPLAY_NOOP,
          body: { status: err.status, replay: true },
          payment,
        };
      }
      throw err;
    });

  if (settled.outcome === OUTCOMES.REPLAY_NOOP) {
    logger?.info(
      { payment_id: payment.id, checkout_request_id: envelope.checkoutRequestId },
      'callback_replay_noop'
    );
  }
  if (settled.outcome === OUTCOMES.REJECTED_ILLEGAL_TRANSITION) {
    logger?.warn({ payment_id: payment.id }, 'callback_illegal_transition');
  }
  if (settled.outcome === OUTCOMES.REJECTED_AMOUNT_MISMATCH) {
    logger?.error(
      {
        payment_id: payment.id,
        callback_amount_minor: envelope.amountMinor,
        expected_amount_minor: payment.amount_minor,
      },
      'callback_amount_mismatch'
    );
  }

  if (settled.outcome === OUTCOMES.APPLIED && settled.payment?.status === STATUSES.CONFIRMED) {
    const done = await paymentsService.settleConfirmedPayment(db, pos, settled.payment.id, new Date(now()));
    return {
      status: 200,
      outcome: OUTCOMES.APPLIED,
      body: { status: done.payment?.status || STATUSES.CONFIRMED, applied: true },
      payment: done.payment,
    };
  }

  return { status: HTTP_STATUS[settled.outcome], ...settled };
}

module.exports = { handleCallback, parseEnvelope, OUTCOMES, HTTP_STATUS };
