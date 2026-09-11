const { STATUSES, evaluate, statusForResultCode } = require('./state');
const { hashChargeRequest } = require('../hash');
const { MpesaTimeoutError, MpesaRejectedError } = require('../../../_shared/mpesa');

const UNIQUE_VIOLATION = '23505';

function mapPayment(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    sale_id: row.sale_id,
    idempotency_key: row.idempotency_key,
    status: row.status,
    amount_minor: row.amount_minor,
    currency: row.currency,
    msisdn: row.msisdn,
    shortcode: row.shortcode,
    merchant_request_id: row.merchant_request_id,
    checkout_request_id: row.checkout_request_id,
    mpesa_receipt: row.mpesa_receipt,
    result_code: row.result_code,
    failure_reason: row.failure_reason,
    created_at: row.created_at,
    updated_at: row.updated_at,
    confirmed_at: row.confirmed_at,
    paid_at: row.paid_at,
    timed_out_at: row.timed_out_at,
  };
}

function fail(message, code, status) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

async function reservePayment(db, { tenantId, saleId, idempotencyKey, sale, msisdn }) {
  if (!idempotencyKey || typeof idempotencyKey !== 'string') {
    throw fail('Idempotency-Key header required', 'MISSING_IDEMPOTENCY_KEY', 400);
  }
  if (idempotencyKey.length > 64) {
    throw fail('Idempotency-Key must be <= 64 characters', 'VALIDATION', 400);
  }
  if (!/^2547\d{8}$/.test(String(msisdn || ''))) {
    throw fail('msisdn must be 2547XXXXXXXX', 'VALIDATION', 400);
  }

  const amountMinor = sale.total_minor;
  const shortcode = sale.mpesa_till;
  const requestHash = hashChargeRequest({ saleId, amountMinor, msisdn, shortcode });

  return db.withTransaction(async (client) => {
    const existing = await client.query(
      `SELECT * FROM payments.payments
       WHERE tenant_id = $1 AND idempotency_key = $2
       FOR UPDATE`,
      [tenantId, idempotencyKey]
    );

    if (existing.rowCount > 0) {
      const row = existing.rows[0];
      if (row.request_hash !== requestHash) {
        throw fail(
          'idempotency key reused with a different charge',
          'IDEMPOTENCY_CONFLICT',
          409
        );
      }
      return { payment: mapPayment(row), created: false };
    }

    try {
      const inserted = await client.query(
        `INSERT INTO payments.payments (
           tenant_id, sale_id, idempotency_key, request_hash, status,
           amount_minor, currency, msisdn, shortcode
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          tenantId,
          saleId,
          idempotencyKey,
          requestHash,
          STATUSES.INITIATED,
          amountMinor,
          sale.currency || 'KES',
          msisdn,
          shortcode,
        ]
      );
      return { payment: mapPayment(inserted.rows[0]), created: true };
    } catch (err) {
      if (err.code === UNIQUE_VIOLATION) {
        if (err.constraint === 'payments_one_live_per_sale') {
          throw fail(
            'a payment for this sale is already in flight or settled',
            'PAYMENT_ALREADY_EXISTS',
            409
          );
        }
        throw fail('concurrent request for the same idempotency key', 'CONFLICT', 409);
      }
      throw err;
    }
  });
}

async function applyTransition(client, paymentRow, target, patch = {}) {
  const decision = evaluate(paymentRow.status, target);

  if (decision.action === 'noop') {
    return { payment: mapPayment(paymentRow), changed: false, reason: decision.reason };
  }

  const columns = { status: target, ...patch };
  const keys = Object.keys(columns);
  const assignments = keys.map((key, idx) => `${key} = $${idx + 1}`).join(', ');
  const values = keys.map((key) => columns[key]);

  const updated = await client.query(
    `UPDATE payments.payments SET ${assignments}
     WHERE id = $${keys.length + 1}
     RETURNING *`,
    [...values, paymentRow.id]
  );
  return { payment: mapPayment(updated.rows[0]), changed: true };
}

async function lockPayment(client, paymentId) {
  const res = await client.query(`SELECT * FROM payments.payments WHERE id = $1 FOR UPDATE`, [
    paymentId,
  ]);
  return res.rowCount ? res.rows[0] : null;
}

async function findByCheckoutRequestId(db, checkoutRequestId) {
  const res = await db.query(
    `SELECT * FROM payments.payments WHERE checkout_request_id = $1`,
    [checkoutRequestId]
  );
  return res.rowCount ? mapPayment(res.rows[0]) : null;
}

async function getPayment(db, paymentId) {
  const res = await db.query(`SELECT * FROM payments.payments WHERE id = $1`, [paymentId]);
  return res.rowCount ? mapPayment(res.rows[0]) : null;
}

async function getPaymentForSale(db, saleId) {
  const res = await db.query(
    `SELECT * FROM payments.payments
     WHERE sale_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [saleId]
  );
  return res.rowCount ? mapPayment(res.rows[0]) : null;
}

async function sendStkPush(db, mpesa, pos, payment, { callbackUrl }) {
  let pushResult = null;
  let pushError = null;

  try {
    pushResult = await mpesa.stkPush({
      shortcode: payment.shortcode,
      amountMinor: payment.amount_minor,
      msisdn: payment.msisdn,
      accountReference: payment.sale_id,
      transactionDesc: 'TillFlow',
      callbackUrl,
    });
  } catch (err) {
    if (!(err instanceof MpesaTimeoutError) && !(err instanceof MpesaRejectedError)) {
      throw err;
    }
    pushError = err;
  }

  const settled = await db.withTransaction(async (client) => {
    const row = await lockPayment(client, payment.id);
    if (!row) return null;

    if (pushError instanceof MpesaRejectedError) {
      return applyTransition(client, row, STATUSES.FAILED, {
        failure_reason: `daraja_rejected: ${pushError.message}`,
      });
    }

    if (pushError instanceof MpesaTimeoutError) {
      return applyTransition(client, row, STATUSES.PENDING, {
        failure_reason: null,
        merchant_request_id: pushError.merchantRequestId || null,
        checkout_request_id: pushError.checkoutRequestId || null,
      });
    }

    return applyTransition(client, row, STATUSES.PENDING, {
      merchant_request_id: pushResult.merchantRequestId,
      checkout_request_id: pushResult.checkoutRequestId,
    });
  });

  if (settled?.payment && settled.payment.status === STATUSES.PENDING) {
    try {
      await pos.markAwaitingPayment(payment.sale_id, payment.id);
    } catch {
    }
  }

  return {
    payment: settled?.payment || payment,
    timedOut: pushError instanceof MpesaTimeoutError,
    rejected: pushError instanceof MpesaRejectedError,
  };
}

async function settleConfirmedPayment(db, pos, paymentId, paidAt = new Date()) {
  const current = await getPayment(db, paymentId);
  if (!current || current.status !== STATUSES.CONFIRMED) {
    return { payment: current, changed: false };
  }

  await pos.markPaid(current.sale_id, current.id, paidAt);

  return db.withTransaction(async (client) => {
    const row = await lockPayment(client, paymentId);
    if (!row) return { payment: null, changed: false };
    return applyTransition(client, row, STATUSES.PAID, { paid_at: paidAt });
  });
}

async function reconcilePayment(db, mpesa, pos, paymentId) {
  const payment = await getPayment(db, paymentId);
  if (!payment) return { payment: null, changed: false, reason: 'not_found' };
  if (payment.status !== STATUSES.PENDING) {
    return { payment, changed: false, reason: 'not_pending' };
  }
  if (!payment.checkout_request_id) {
    return { payment, changed: false, reason: 'no_correlation_id' };
  }

  const query = await mpesa.stkQuery({
    shortcode: payment.shortcode,
    checkoutRequestId: payment.checkout_request_id,
  });

  const target = statusForResultCode(query.resultCode, { fromReconciliation: true });
  if (!target) {
    return { payment, changed: false, reason: 'still_processing' };
  }

  if (target === STATUSES.CONFIRMED && query.amountMinor !== payment.amount_minor) {
    return { payment, changed: false, reason: 'amount_mismatch' };
  }

  const result = await db.withTransaction(async (client) => {
    const row = await lockPayment(client, paymentId);
    if (!row) return { payment: null, changed: false };

    if (target === STATUSES.CONFIRMED) {
      return applyTransition(client, row, STATUSES.CONFIRMED, {
        mpesa_receipt: query.mpesaReceipt,
        result_code: query.resultCode,
        confirmed_at: new Date(),
      });
    }
    if (target === STATUSES.TIMED_OUT) {
      return applyTransition(client, row, STATUSES.TIMED_OUT, {
        result_code: query.resultCode,
        failure_reason: query.resultDesc,
        timed_out_at: new Date(),
      });
    }
    return applyTransition(client, row, STATUSES.FAILED, {
      result_code: query.resultCode,
      failure_reason: query.resultDesc,
    });
  });

  if (result.changed && result.payment?.status === STATUSES.CONFIRMED) {
    const settled = await settleConfirmedPayment(db, pos, paymentId, new Date());
    return { ...settled, changed: true, reason: 'confirmed_via_query' };
  }

  return { ...result, reason: `settled_${target}` };
}

module.exports = {
  reservePayment,
  sendStkPush,
  settleConfirmedPayment,
  reconcilePayment,
  applyTransition,
  lockPayment,
  getPayment,
  getPaymentForSale,
  findByCheckoutRequestId,
  mapPayment,
};
