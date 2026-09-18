const { hashSaleRequest } = require('../hash');
const { STATUSES, ACTORS, assertTransition } = require('./state');

function mapSale(row, lines = []) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    attendant_id: row.attendant_id,
    idempotency_key: row.idempotency_key,
    status: row.status,
    currency: row.currency,
    total_minor: row.total_minor,
    created_at: row.created_at,
    paid_at: row.paid_at,
    payment_id: row.payment_id ?? null,
    lines: lines.map((l) => ({
      id: l.id,
      description: l.description,
      quantity: l.quantity,
      unit_price_minor: l.unit_price_minor,
      line_total_minor: l.line_total_minor,
    })),
  };
}

async function loadLines(client, saleId) {
  const result = await client.query(
    `SELECT id, description, quantity, unit_price_minor, line_total_minor
     FROM pos.sale_lines WHERE sale_id = $1 ORDER BY id`,
    [saleId]
  );
  return result.rows;
}

async function getSaleForTenant(db, tenantId, saleId) {
  const saleResult = await db.query(
    `SELECT * FROM pos.sales WHERE id = $1 AND tenant_id = $2`,
    [saleId, tenantId]
  );
  if (saleResult.rowCount === 0) {
    return null;
  }
  const lines = await loadLines(db, saleId);
  return mapSale(saleResult.rows[0], lines);
}

async function getSaleById(db, saleId) {
  const saleResult = await db.query(`SELECT * FROM pos.sales WHERE id = $1`, [saleId]);
  if (saleResult.rowCount === 0) {
    return null;
  }
  const lines = await loadLines(db, saleId);
  const sale = mapSale(saleResult.rows[0], lines);
  const tenant = await db.query(
    `SELECT id, mpesa_till, status FROM pos.tenants WHERE id = $1`,
    [sale.tenant_id]
  );
  const attendant = await db.query(
    `SELECT id, display_name, payout_msisdn, commission_bps, status
     FROM pos.attendants WHERE id = $1 AND tenant_id = $2`,
    [sale.attendant_id, sale.tenant_id]
  );
  return {
    ...sale,
    mpesa_till: tenant.rows[0]?.mpesa_till ?? null,
    tenant_status: tenant.rows[0]?.status ?? null,
    attendant: attendant.rows[0]
      ? {
          id: attendant.rows[0].id,
          display_name: attendant.rows[0].display_name,
          payout_msisdn: attendant.rows[0].payout_msisdn,
          commission_bps: attendant.rows[0].commission_bps,
          status: attendant.rows[0].status,
        }
      : null,
  };
}

function validateCreateBody(body) {
  if (!body || typeof body !== 'object') {
    const err = new Error('body required');
    err.code = 'VALIDATION';
    err.status = 400;
    throw err;
  }
  if (!Array.isArray(body.lines) || body.lines.length === 0) {
    const err = new Error('lines must be a non-empty array');
    err.code = 'VALIDATION';
    err.status = 400;
    throw err;
  }

  const lines = body.lines.map((line, idx) => {
    const quantity = Number(line.quantity);
    const unit_price_minor = Number(line.unit_price_minor);
    const description = line.description;
    if (!description || typeof description !== 'string') {
      const err = new Error(`lines[${idx}].description required`);
      err.code = 'VALIDATION';
      err.status = 400;
      throw err;
    }
    if (!Number.isInteger(quantity) || quantity < 1) {
      const err = new Error(`lines[${idx}].quantity must be integer >= 1`);
      err.code = 'VALIDATION';
      err.status = 400;
      throw err;
    }
    if (!Number.isInteger(unit_price_minor) || unit_price_minor < 0) {
      const err = new Error(`lines[${idx}].unit_price_minor must be integer >= 0`);
      err.code = 'VALIDATION';
      err.status = 400;
      throw err;
    }
    const line_total_minor = quantity * unit_price_minor;
    if (
      line.line_total_minor !== undefined &&
      Number(line.line_total_minor) !== line_total_minor
    ) {
      const err = new Error(`lines[${idx}].line_total_minor mismatch`);
      err.code = 'VALIDATION';
      err.status = 400;
      throw err;
    }
    return { description, quantity, unit_price_minor, line_total_minor };
  });

  const computed = lines.reduce((sum, l) => sum + l.line_total_minor, 0);
  if (body.total_minor !== undefined && Number(body.total_minor) !== computed) {
    const err = new Error('total_minor does not match line totals');
    err.code = 'VALIDATION';
    err.status = 400;
    throw err;
  }

  return { lines, total_minor: computed };
}

async function createSale(db, { tenantId, userId, role, idempotencyKey, body }) {
  if (!idempotencyKey || typeof idempotencyKey !== 'string') {
    const err = new Error('Idempotency-Key header required');
    err.code = 'MISSING_IDEMPOTENCY_KEY';
    err.status = 400;
    throw err;
  }
  if (idempotencyKey.length > 64) {
    const err = new Error('Idempotency-Key must be <= 64 characters');
    err.code = 'VALIDATION';
    err.status = 400;
    throw err;
  }
  if (role !== 'attendant') {
    const err = new Error('only attendants can create sales');
    err.code = 'FORBIDDEN';
    err.status = 403;
    throw err;
  }

  const { lines, total_minor } = validateCreateBody(body);
  const requestHash = hashSaleRequest({ lines, total_minor });

  return db.withTransaction(async (client) => {
    const attendant = await client.query(
      `SELECT a.id, a.status
       FROM pos.attendants a
       JOIN pos.memberships m
         ON m.user_id = a.id AND m.tenant_id = a.tenant_id
       WHERE a.id = $1 AND a.tenant_id = $2 AND m.role = 'attendant'`,
      [userId, tenantId]
    );
    if (attendant.rowCount === 0) {
      const err = new Error('attendant membership not found');
      err.code = 'FORBIDDEN';
      err.status = 403;
      throw err;
    }
    if (attendant.rows[0].status !== 'active') {
      const err = new Error('attendant is inactive');
      err.code = 'FORBIDDEN';
      err.status = 403;
      throw err;
    }

    const existing = await client.query(
      `SELECT * FROM pos.sales
       WHERE tenant_id = $1 AND idempotency_key = $2
       FOR UPDATE`,
      [tenantId, idempotencyKey]
    );

    if (existing.rowCount > 0) {
      const row = existing.rows[0];
      if (row.request_hash !== requestHash) {
        const err = new Error('idempotency key reused with different body');
        err.code = 'IDEMPOTENCY_CONFLICT';
        err.status = 409;
        throw err;
      }
      const existingLines = await loadLines(client, row.id);
      return { sale: mapSale(row, existingLines), created: false };
    }

    try {
      const inserted = await client.query(
        `INSERT INTO pos.sales (
           tenant_id, attendant_id, idempotency_key, status,
           currency, total_minor, request_hash
         ) VALUES ($1, $2, $3, $4, 'KES', $5, $6)
         RETURNING *`,
        [tenantId, userId, idempotencyKey, STATUSES.CREATED, total_minor, requestHash]
      );
      const sale = inserted.rows[0];

      for (const line of lines) {
        await client.query(
          `INSERT INTO pos.sale_lines (
             sale_id, description, quantity, unit_price_minor, line_total_minor
           ) VALUES ($1, $2, $3, $4, $5)`,
          [
            sale.id,
            line.description,
            line.quantity,
            line.unit_price_minor,
            line.line_total_minor,
          ]
        );
      }

      const saleLines = await loadLines(client, sale.id);
      return { sale: mapSale(sale, saleLines), created: true };
    } catch (err) {
      if (!isSaleIdempotencyCollision(err)) {
        throw err;
      }
      const raced = new Error('sale idempotency collision');
      raced.code = 'SALE_IDEMPOTENCY_COLLISION';
      raced.tenantId = tenantId;
      raced.idempotencyKey = idempotencyKey;
      raced.requestHash = requestHash;
      throw raced;
    }
  }).catch(async (err) => {
    if (err.code !== 'SALE_IDEMPOTENCY_COLLISION') {
      throw err;
    }
    return loadIdempotentSale(db, err.tenantId, err.idempotencyKey, err.requestHash);
  });
}

function isSaleIdempotencyCollision(err) {
  return (
    err &&
    err.code === '23505' &&
    (!err.constraint || err.constraint === 'sales_tenant_idempotency_unique')
  );
}

async function loadIdempotentSale(db, tenantId, idempotencyKey, requestHash) {
  const winner = await db.query(
    `SELECT * FROM pos.sales WHERE tenant_id = $1 AND idempotency_key = $2`,
    [tenantId, idempotencyKey]
  );
  if (winner.rowCount === 0) {
    const err = new Error('idempotency collision but sale not found');
    err.code = 'INTERNAL';
    err.status = 500;
    throw err;
  }
  const row = winner.rows[0];
  if (row.request_hash !== requestHash) {
    const err = new Error('idempotency key reused with different body');
    err.code = 'IDEMPOTENCY_CONFLICT';
    err.status = 409;
    throw err;
  }
  const existingLines = await loadLines(db, row.id);
  return { sale: mapSale(row, existingLines), created: false };
}

async function cancelSale(db, { tenantId, saleId, role }) {
  if (role !== 'attendant' && role !== 'owner') {
    const err = new Error('forbidden');
    err.code = 'FORBIDDEN';
    err.status = 403;
    throw err;
  }

  return db.withTransaction(async (client) => {
    const result = await client.query(
      `SELECT * FROM pos.sales WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
      [saleId, tenantId]
    );
    if (result.rowCount === 0) {
      return null;
    }
    const row = result.rows[0];
    assertTransition(row.status, STATUSES.CANCELLED, ACTORS.POS);
    const updated = await client.query(
      `UPDATE pos.sales SET status = $1 WHERE id = $2 RETURNING *`,
      [STATUSES.CANCELLED, saleId]
    );
    const lines = await loadLines(client, saleId);
    return mapSale(updated.rows[0], lines);
  });
}

async function markAwaitingPayment(db, saleId) {
  return db.withTransaction(async (client) => {
    const result = await client.query(
      `SELECT * FROM pos.sales WHERE id = $1 FOR UPDATE`,
      [saleId]
    );
    if (result.rowCount === 0) {
      return null;
    }
    const row = result.rows[0];
    const decision = assertTransition(
      row.status,
      STATUSES.AWAITING_PAYMENT,
      ACTORS.PAYMENTS
    );
    if (decision.noop) {
      const lines = await loadLines(client, saleId);
      return mapSale(row, lines);
    }
    const updated = await client.query(
      `UPDATE pos.sales SET status = $1 WHERE id = $2 RETURNING *`,
      [STATUSES.AWAITING_PAYMENT, saleId]
    );
    const lines = await loadLines(client, saleId);
    return mapSale(updated.rows[0], lines);
  });
}

async function markPaid(db, saleId, { paymentId, paidAt } = {}) {
  if (!paymentId || typeof paymentId !== 'string') {
    const err = new Error('payment_id required');
    err.code = 'VALIDATION';
    err.status = 400;
    throw err;
  }
  const paidAtDate = paidAt ? new Date(paidAt) : new Date();
  if (Number.isNaN(paidAtDate.getTime())) {
    const err = new Error('invalid paid_at');
    err.code = 'VALIDATION';
    err.status = 400;
    throw err;
  }

  return db.withTransaction(async (client) => {
    const result = await client.query(
      `SELECT * FROM pos.sales WHERE id = $1 FOR UPDATE`,
      [saleId]
    );
    if (result.rowCount === 0) {
      return null;
    }
    const row = result.rows[0];
    if (row.status === STATUSES.PAID) {
      if (row.payment_id && row.payment_id !== paymentId) {
        const err = new Error('sale already paid by a different payment_id');
        err.code = 'PAYMENT_ID_MISMATCH';
        err.status = 409;
        throw err;
      }
      // Replay: no-op — paid_at and totals unchanged. Stamp payment_id if
      // a pre-migration row was paid without one.
      if (!row.payment_id) {
        const stamped = await client.query(
          `UPDATE pos.sales SET payment_id = $1 WHERE id = $2 RETURNING *`,
          [paymentId, saleId]
        );
        const lines = await loadLines(client, saleId);
        return mapSale(stamped.rows[0], lines);
      }
      const lines = await loadLines(client, saleId);
      return mapSale(row, lines);
    }
    assertTransition(row.status, STATUSES.PAID, ACTORS.PAYMENTS);
    const updated = await client.query(
      `UPDATE pos.sales
       SET status = $1, paid_at = $2, payment_id = $3
       WHERE id = $4
       RETURNING *`,
      [STATUSES.PAID, paidAtDate, paymentId, saleId]
    );
    const lines = await loadLines(client, saleId);
    return mapSale(updated.rows[0], lines);
  });
}

async function listEligibleForCommission(db, { tenantId, businessDayEAT }) {
  const result = await db.query(
    `SELECT s.id, s.tenant_id, s.attendant_id, s.status, s.total_minor, s.paid_at, s.currency, s.payment_id,
            a.payout_msisdn, a.commission_bps
     FROM pos.sales s
     JOIN pos.attendants a ON a.id = s.attendant_id AND a.tenant_id = s.tenant_id
     WHERE s.tenant_id = $1
       AND s.status = 'paid'
       AND (s.paid_at AT TIME ZONE 'Africa/Nairobi')::date = $2::date`,
    [tenantId, businessDayEAT]
  );
  return result.rows.map((row) => ({
    id: row.id,
    tenant_id: row.tenant_id,
    attendant_id: row.attendant_id,
    status: row.status,
    total_minor: row.total_minor,
    paid_at: row.paid_at,
    currency: row.currency,
    payment_id: row.payment_id ?? null,
    payout_msisdn: row.payout_msisdn,
    commission_bps: row.commission_bps,
  }));
}

module.exports = {
  createSale,
  getSaleForTenant,
  getSaleById,
  cancelSale,
  markAwaitingPayment,
  markPaid,
  listEligibleForCommission,
  validateCreateBody,
};
