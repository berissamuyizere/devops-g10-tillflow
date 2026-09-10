const { hashPayoutRequest } = require('../hash');

const UNIQUE_VIOLATION = '23505';

const LEDGER_STATUSES = Object.freeze({
  PENDING: 'pending',
  DISBURSING: 'disbursing',
  DISBURSED: 'disbursed',
  FAILED: 'failed',
});

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
    disbursed_at: row.disbursed_at,
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

async function disburse(db, mpesa, ledgerId, { shortcode } = {}) {
  const claimed = await db.withTransaction(async (client) => {
    const res = await client.query(
      `SELECT * FROM payments.payout_ledger WHERE id = $1 FOR UPDATE`,
      [ledgerId]
    );
    if (res.rowCount === 0) return null;
    const row = res.rows[0];
    if (row.status !== LEDGER_STATUSES.PENDING) {
      return { row, claimed: false };
    }
    const updated = await client.query(
      `UPDATE payments.payout_ledger SET status = $1 WHERE id = $2 RETURNING *`,
      [LEDGER_STATUSES.DISBURSING, ledgerId]
    );
    return { row: updated.rows[0], claimed: true };
  });

  if (!claimed) return { ledger: null, disbursed: false, reason: 'not_found' };
  if (!claimed.claimed) {
    return {
      ledger: mapLedger(claimed.row),
      disbursed: false,
      reason: `already_${claimed.row.status}`,
    };
  }

  const row = claimed.row;
  try {
    const result = await mpesa.b2c({
      shortcode: shortcode || process.env.MPESA_B2C_SHORTCODE || '600000',
      amountMinor: row.amount_minor,
      msisdn: row.msisdn,
      remarks: `TillFlow commission ${row.period instanceof Date ? toDateString(row.period) : row.period}`,
      originatorConversationId: row.originator_conversation_id,
    });

    const done = await db.query(
      `UPDATE payments.payout_ledger
       SET status = $1, conversation_id = $2, disbursed_at = now()
       WHERE id = $3
       RETURNING *`,
      [LEDGER_STATUSES.DISBURSED, result.conversationId, ledgerId]
    );
    return { ledger: mapLedger(done.rows[0]), disbursed: true, reason: 'disbursed' };
  } catch (err) {
    const reverted = await db.query(
      `UPDATE payments.payout_ledger
       SET status = $1, failure_reason = $2
       WHERE id = $3
       RETURNING *`,
      [LEDGER_STATUSES.PENDING, String(err.message || err), ledgerId]
    );
    return {
      ledger: mapLedger(reverted.rows[0]),
      disbursed: false,
      reason: 'b2c_failed',
      error: err,
    };
  }
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
  getLedgerEntry,
  findByAgentPeriod,
  commissionFor,
  LEDGER_STATUSES,
  mapLedger,
};
