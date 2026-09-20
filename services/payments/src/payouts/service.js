const { hashPayoutRequest } = require('../hash');
const { LEDGER_STATUSES, evaluate, statusForB2cResultCode } = require('./state');
const { MpesaTimeoutError, MpesaRejectedError } = require('../../../_shared/mpesa');
const metrics = require('../metrics');

const UNIQUE_VIOLATION = '23505';

function mapLedger(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    agent_id: row.agent_id,
    period: row.period instanceof Date ? toDateString(row.period) : row.period,
    idempotency_key: row.idempotency_key,
    status: row.status,
    gross_sales_minor: row.gross_sales_minor,
    commission_bps: row.commission_bps,
    amount_minor: row.amount_minor,
    msisdn: row.msisdn,
    originator_conversation_id: row.originator_conversation_id,
    conversation_id: row.conversation_id,
    failure_reason: row.failure_reason,
    created_at: row.created_at,
    accepted_at: row.accepted_at,
    disbursed_at: row.disbursed_at,
    b2c_result_code: row.b2c_result_code,
    b2c_transaction_id: row.b2c_transaction_id,
    b2c_sync_error: row.b2c_sync_error,
  };
}

function toDateString(date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function fail(message, code, status) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

function commissionFor(grossMinor, bps) {
  return Math.floor((grossMinor * bps) / 10000);
}

function validate({ tenantId, agentId, period, msisdn, commissionBps, sales }) {
  if (!tenantId || !agentId) throw fail('tenant_id and agent_id required', 'VALIDATION', 400);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(period || ''))) {
    throw fail('period must be YYYY-MM-DD (Africa/Nairobi business day)', 'VALIDATION', 400);
  }
  if (!/^2547\d{8}$/.test(String(msisdn || ''))) {
    throw fail('msisdn must be 2547XXXXXXXX', 'VALIDATION', 400);
  }
  if (!Number.isInteger(commissionBps) || commissionBps < 0 || commissionBps > 10000) {
    throw fail('commission_bps must be an integer 0..10000', 'VALIDATION', 400);
  }
  if (!Array.isArray(sales) || sales.length === 0) {
    throw fail('sales must be a non-empty array', 'VALIDATION', 400);
  }
}

async function recordPayout(db, request) {
  const { tenantId, agentId, period, msisdn, commissionBps, sales } = request;
  validate(request);

  const idempotencyKey = request.idempotencyKey || `${agentId}:${period}`;
  const originatorConversationId = `tillflow-${agentId}-${period}`;

  return db.withTransaction(async (client) => {
    const existing = await client.query(
      `SELECT * FROM payments.payout_ledger
       WHERE agent_id = $1 AND period = $2
       FOR UPDATE`,
      [agentId, period]
    );

    if (existing.rowCount > 0) {
      const row = existing.rows[0];

      const requestHash = hashPayoutRequest({
        tenantId,
        agentId,
        period,
        amountMinor: row.amount_minor,
        msisdn,
      });
      if (row.request_hash !== requestHash) {
        throw fail(
          'payout already recorded for this agent and period with different inputs',
          'PAYOUT_CONFLICT',
          409
        );
      }
      return { ledger: mapLedger(row), created: false };
    }

    const confirmed = await client.query(
      `SELECT sale_id, amount_minor
       FROM payments.payments
       WHERE tenant_id = $1
         AND status = 'paid'
         AND sale_id = ANY($2::uuid[])`,
      [tenantId, sales]
    );

    if (confirmed.rowCount === 0) {
      throw fail('no paid sales among the supplied sale ids', 'NO_ELIGIBLE_SALES', 409);
    }

    const grossMinor = confirmed.rows.reduce((sum, r) => sum + r.amount_minor, 0);
    const amountMinor = commissionFor(grossMinor, commissionBps);
    if (amountMinor <= 0) {
      throw fail('computed commission is zero', 'ZERO_COMMISSION', 409);
    }

    const requestHash = hashPayoutRequest({
      tenantId,
      agentId,
      period,
      amountMinor,
      msisdn,
    });

    let ledgerRow;
    try {
      const inserted = await client.query(
        `INSERT INTO payments.payout_ledger (
           tenant_id, agent_id, period, idempotency_key, request_hash, status,
           gross_sales_minor, commission_bps, amount_minor, msisdn,
           originator_conversation_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING *`,
        [
          tenantId,
          agentId,
          period,
          idempotencyKey,
          requestHash,
          LEDGER_STATUSES.PENDING,
          grossMinor,
          commissionBps,
          amountMinor,
          msisdn,
          originatorConversationId,
        ]
      );
      ledgerRow = inserted.rows[0];
    } catch (err) {
      if (err.code === UNIQUE_VIOLATION) {
        throw fail(
          'payout already recorded for this agent and period',
          'PAYOUT_ALREADY_EXISTS',
          409
        );
      }
      throw err;
    }

    for (const sale of confirmed.rows) {
      try {
        await client.query(
          `INSERT INTO payments.payout_ledger_sales (ledger_id, sale_id, amount_minor)
           VALUES ($1, $2, $3)`,
          [ledgerRow.id, sale.sale_id, sale.amount_minor]
        );
      } catch (err) {
        if (err.code === UNIQUE_VIOLATION) {
          throw fail(
            `sale ${sale.sale_id} already contributed to a payout`,
            'SALE_ALREADY_PAID_OUT',
            409
          );
        }
        throw err;
      }
    }

    return { ledger: mapLedger(ledgerRow), created: true };
  });
}

async function lockLedger(client, ledgerId) {
  const res = await client.query(
    `SELECT * FROM payments.payout_ledger WHERE id = $1 FOR UPDATE`,
    [ledgerId]
  );
  return res.rowCount ? res.rows[0] : null;
}

async function applyLedgerTransition(client, row, target, patch = {}) {
  const decision = evaluate(row.status, target);
  if (decision.action === 'noop') {
    return { ledger: mapLedger(row), changed: false, reason: decision.reason };
  }
  const columns = { status: target, ...patch };
  const keys = Object.keys(columns);
  const assignments = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const values = keys.map((k) => columns[k]);
  const updated = await client.query(
    `UPDATE payments.payout_ledger SET ${assignments} WHERE id = $${keys.length + 1} RETURNING *`,
    [...values, row.id]
  );
  return { ledger: mapLedger(updated.rows[0]), changed: true };
}

async function disburse(db, mpesa, ledgerId, { shortcode } = {}) {
  const claimed = await db.withTransaction(async (client) => {
    const row = await lockLedger(client, ledgerId);
    if (!row) return null;
    if (row.status !== LEDGER_STATUSES.PENDING) {
      return { row, claimed: false };
    }
    return { ...(await applyLedgerTransition(client, row, LEDGER_STATUSES.DISBURSING)), claimed: true };
  });

  if (!claimed) return { ledger: null, disbursed: false, reason: 'not_found' };
  if (!claimed.claimed) {
    return {
      ledger: mapLedger(claimed.row),
      disbursed: false,
      reason: `already_${claimed.row.status}`,
    };
  }

  const row = claimed.ledger;
  const period = row.period;

  try {
    const result = await mpesa.b2c({
      shortcode: shortcode || process.env.MPESA_B2C_SHORTCODE || '600000',
      amountMinor: row.amount_minor,
      msisdn: row.msisdn,
      remarks: `TillFlow commission ${period}`,
      originatorConversationId: row.originator_conversation_id,
    });

    metrics.recordCommand('b2c', 'accepted');

    const accepted = await db.query(
      `UPDATE payments.payout_ledger
       SET conversation_id = $1, accepted_at = now(), b2c_sync_error = NULL
       WHERE id = $2
       RETURNING *`,
      [result.conversationId, ledgerId]
    );

    return {
      ledger: mapLedger(accepted.rows[0]),
      disbursed: false,
      accepted: true,
      reason: 'accepted_awaiting_result',
    };
  } catch (err) {
    metrics.recordCommand('b2c', err instanceof MpesaRejectedError ? 'rejected' : 'timeout');

    if (err instanceof MpesaRejectedError) {
      const failed = await db.withTransaction(async (client) => {
        const current = await lockLedger(client, ledgerId);
        if (!current) return null;
        return applyLedgerTransition(client, current, LEDGER_STATUSES.FAILED, {
          failure_reason: `b2c_rejected: ${err.message}`,
        });
      });
      return {
        ledger: failed?.ledger || null,
        disbursed: false,
        accepted: false,
        reason: 'b2c_rejected',
        error: err,
      };
    }

    const unknown = await db.query(
      `UPDATE payments.payout_ledger
       SET b2c_sync_error = $1,
           conversation_id = COALESCE(conversation_id, $2)
       WHERE id = $3
       RETURNING *`,
      [
        `b2c_unknown: ${err.code || 'ERROR'}: ${err.message}`,
        err.conversationId || null,
        ledgerId,
      ]
    );

    return {
      ledger: mapLedger(unknown.rows[0]),
      disbursed: false,
      accepted: false,
      reason: err instanceof MpesaTimeoutError ? 'b2c_timeout_unknown' : 'b2c_unknown',
      error: err,
    };
  }
}

async function applyB2cResult(db, { originatorConversationId, resultCode, transactionId, resultDesc }) {
  const target = statusForB2cResultCode(resultCode);
  if (!target) {
    return { ledger: null, changed: false, reason: 'not_terminal' };
  }

  return db.withTransaction(async (client) => {
    const res = await client.query(
      `SELECT * FROM payments.payout_ledger
       WHERE originator_conversation_id = $1
       FOR UPDATE`,
      [originatorConversationId]
    );
    if (res.rowCount === 0) {
      return { ledger: null, changed: false, reason: 'not_found' };
    }
    const row = res.rows[0];

    const patch =
      target === LEDGER_STATUSES.DISBURSED
        ? {
            b2c_result_code: Number(resultCode),
            b2c_transaction_id: transactionId || null,
            b2c_sync_error: null,
            disbursed_at: new Date(),
          }
        : {
            b2c_result_code: Number(resultCode),
            failure_reason: resultDesc || `b2c result ${resultCode}`,
            b2c_sync_error: null,
          };

    const applied = await applyLedgerTransition(client, row, target, patch);
    return { ...applied, reason: applied.changed ? `settled_${target}` : applied.reason };
  });
}

async function reconcilePayout(db, mpesa, ledgerId) {
  const current = await getLedgerEntry(db, ledgerId);
  if (!current) return { ledger: null, changed: false, reason: 'not_found' };
  if (current.status !== LEDGER_STATUSES.DISBURSING) {
    return { ledger: current, changed: false, reason: 'not_disbursing' };
  }

  let query;
  try {
    query = await mpesa.b2cQuery({
      originatorConversationId: current.originator_conversation_id,
    });
  } catch (err) {
    if (err instanceof MpesaRejectedError) {
      return { ledger: current, changed: false, reason: 'unknown_to_daraja' };
    }
    throw err;
  }

  const target = statusForB2cResultCode(query.resultCode);
  if (!target) {
    return { ledger: current, changed: false, reason: 'still_processing' };
  }

  return applyB2cResult(db, {
    originatorConversationId: current.originator_conversation_id,
    resultCode: query.resultCode,
    transactionId: query.transactionId,
    resultDesc: query.resultDesc,
  });
}

async function findStuckDisbursing(db, limit = 100) {
  const res = await db.query(
    `SELECT * FROM payments.payout_ledger
     WHERE status = 'disbursing'
     ORDER BY updated_at ASC
     LIMIT $1`,
    [limit]
  );
  return res.rows.map(mapLedger);
}

async function getLedgerEntry(db, ledgerId) {
  const res = await db.query(`SELECT * FROM payments.payout_ledger WHERE id = $1`, [ledgerId]);
  return res.rowCount ? mapLedger(res.rows[0]) : null;
}

async function findByAgentPeriod(db, agentId, period) {
  const res = await db.query(
    `SELECT * FROM payments.payout_ledger WHERE agent_id = $1 AND period = $2`,
    [agentId, period]
  );
  return res.rowCount ? mapLedger(res.rows[0]) : null;
}

module.exports = {
  recordPayout,
  disburse,
  applyB2cResult,
  reconcilePayout,
  findStuckDisbursing,
  applyLedgerTransition,
  lockLedger,
  getLedgerEntry,
  findByAgentPeriod,
  commissionFor,
  LEDGER_STATUSES,
  mapLedger,
};
