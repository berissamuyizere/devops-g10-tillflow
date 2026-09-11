exports.shorthands = undefined;

const STATUSES = "('initiated','pending','confirmed','paid','failed','timed_out')";
const LEDGER_STATUSES = "('pending','disbursing','disbursed','failed')";
const CALLBACK_OUTCOMES =
  "('applied','replay_noop','rejected_bad_signature','rejected_unknown_payment'," +
  "'rejected_amount_mismatch','rejected_illegal_transition','rejected_malformed')";

exports.up = (pgm) => {
  pgm.createSchema('payments', { ifNotExists: true });

  pgm.createTable(
    { schema: 'payments', name: 'payments' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      tenant_id: { type: 'uuid', notNull: true },

      sale_id: { type: 'uuid', notNull: true },

      idempotency_key: { type: 'text', notNull: true },
      request_hash: { type: 'text', notNull: true },
      status: { type: 'text', notNull: true },

      amount_minor: { type: 'integer', notNull: true },
      currency: { type: 'char(3)', notNull: true, default: "'KES'" },
      msisdn: { type: 'text', notNull: true },
      shortcode: { type: 'text', notNull: true },
      merchant_request_id: { type: 'text' },
      checkout_request_id: { type: 'text' },
      mpesa_receipt: { type: 'text' },
      result_code: { type: 'integer' },
      failure_reason: { type: 'text' },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      confirmed_at: { type: 'timestamptz' },
      paid_at: { type: 'timestamptz' },
      timed_out_at: { type: 'timestamptz' },
    }
  );

  pgm.addConstraint(
    { schema: 'payments', name: 'payments' },
    'payments_status_check',
    `CHECK (status IN ${STATUSES})`
  );
  pgm.addConstraint(
    { schema: 'payments', name: 'payments' },
    'payments_amount_check',
    'CHECK (amount_minor > 0)'
  );
  pgm.addConstraint(
    { schema: 'payments', name: 'payments' },
    'payments_msisdn_check',
    "CHECK (msisdn ~ '^2547[0-9]{8}$')"
  );

  pgm.addConstraint(
    { schema: 'payments', name: 'payments' },
    'payments_receipt_required_when_settled',
    "CHECK (status NOT IN ('confirmed','paid') OR mpesa_receipt IS NOT NULL)"
  );

  pgm.addConstraint(
    { schema: 'payments', name: 'payments' },
    'payments_tenant_idempotency_unique',
    'UNIQUE (tenant_id, idempotency_key)'
  );

  pgm.createIndex(
    { schema: 'payments', name: 'payments' },
    ['sale_id'],
    {
      name: 'payments_one_live_per_sale',
      unique: true,
      where: "status NOT IN ('failed','timed_out')",
    }
  );

  pgm.createIndex({ schema: 'payments', name: 'payments' }, ['checkout_request_id'], {
    name: 'payments_checkout_request_id_unique',
    unique: true,
    where: 'checkout_request_id IS NOT NULL',
  });

  pgm.createIndex({ schema: 'payments', name: 'payments' }, ['mpesa_receipt'], {
    name: 'payments_mpesa_receipt_unique',
    unique: true,
    where: 'mpesa_receipt IS NOT NULL',
  });
  pgm.createIndex({ schema: 'payments', name: 'payments' }, ['status', 'created_at'], {
    name: 'payments_status_created_at_idx',
  });

  pgm.createTable(
    { schema: 'payments', name: 'callback_log' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      payment_id: {
        type: 'uuid',
        references: '"payments"."payments"',
        onDelete: 'RESTRICT',
      },
      checkout_request_id: { type: 'text' },

      callback_hash: { type: 'text', notNull: true },
      signature_valid: { type: 'boolean', notNull: true },
      signature_reason: { type: 'text' },
      outcome: { type: 'text', notNull: true },
      result_code: { type: 'integer' },
      notes: { type: 'text' },
      raw_body: { type: 'jsonb', notNull: true },
      received_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    }
  );
  pgm.addConstraint(
    { schema: 'payments', name: 'callback_log' },
    'callback_log_outcome_check',
    `CHECK (outcome IN ${CALLBACK_OUTCOMES})`
  );

  pgm.createIndex({ schema: 'payments', name: 'callback_log' }, ['callback_hash'], {
    name: 'callback_log_hash_unique',
    unique: true,
    where: "outcome = 'applied'",
  });
  pgm.createIndex({ schema: 'payments', name: 'callback_log' }, ['payment_id', 'received_at'], {
    name: 'callback_log_payment_received_idx',
  });

  pgm.createTable(
    { schema: 'payments', name: 'payout_ledger' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      tenant_id: { type: 'uuid', notNull: true },
      agent_id: { type: 'uuid', notNull: true },

      period: { type: 'date', notNull: true },
      idempotency_key: { type: 'text', notNull: true },
      request_hash: { type: 'text', notNull: true },
      status: { type: 'text', notNull: true, default: "'pending'" },
      gross_sales_minor: { type: 'integer', notNull: true },
      commission_bps: { type: 'integer', notNull: true },
      amount_minor: { type: 'integer', notNull: true },
      msisdn: { type: 'text', notNull: true },

      originator_conversation_id: { type: 'text', notNull: true },
      conversation_id: { type: 'text' },
      failure_reason: { type: 'text' },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
      disbursed_at: { type: 'timestamptz' },
    }
  );

  pgm.addConstraint(
    { schema: 'payments', name: 'payout_ledger' },
    'payout_ledger_agent_period_unique',
    'UNIQUE (agent_id, period)'
  );
  pgm.addConstraint(
    { schema: 'payments', name: 'payout_ledger' },
    'payout_ledger_idempotency_unique',
    'UNIQUE (tenant_id, idempotency_key)'
  );
  pgm.addConstraint(
    { schema: 'payments', name: 'payout_ledger' },
    'payout_ledger_originator_unique',
    'UNIQUE (originator_conversation_id)'
  );
  pgm.addConstraint(
    { schema: 'payments', name: 'payout_ledger' },
    'payout_ledger_status_check',
    `CHECK (status IN ${LEDGER_STATUSES})`
  );
  pgm.addConstraint(
    { schema: 'payments', name: 'payout_ledger' },
    'payout_ledger_amount_check',
    'CHECK (amount_minor > 0 AND gross_sales_minor >= 0)'
  );
  pgm.addConstraint(
    { schema: 'payments', name: 'payout_ledger' },
    'payout_ledger_bps_check',
    'CHECK (commission_bps BETWEEN 0 AND 10000)'
  );
  pgm.addConstraint(
    { schema: 'payments', name: 'payout_ledger' },
    'payout_ledger_msisdn_check',
    "CHECK (msisdn ~ '^2547[0-9]{8}$')"
  );

  pgm.createTable(
    { schema: 'payments', name: 'payout_ledger_sales' },
    {
      ledger_id: {
        type: 'uuid',
        notNull: true,
        references: '"payments"."payout_ledger"',
        onDelete: 'CASCADE',
      },
      sale_id: { type: 'uuid', notNull: true },
      amount_minor: { type: 'integer', notNull: true },
    }
  );
  pgm.addConstraint(
    { schema: 'payments', name: 'payout_ledger_sales' },
    'payout_ledger_sales_pkey',
    'PRIMARY KEY (ledger_id, sale_id)'
  );
  pgm.addConstraint(
    { schema: 'payments', name: 'payout_ledger_sales' },
    'payout_ledger_sales_sale_unique',
    'UNIQUE (sale_id)'
  );

  pgm.createFunction(
    { schema: 'payments', name: 'set_updated_at' },
    [],
    { returns: 'trigger', language: 'plpgsql', replace: true },
    'BEGIN NEW.updated_at = now(); RETURN NEW; END;'
  );
  for (const table of ['payments', 'payout_ledger']) {
    pgm.createTrigger({ schema: 'payments', name: table }, `${table}_set_updated_at`, {
      when: 'BEFORE',
      operation: 'UPDATE',
      level: 'ROW',
      function: { schema: 'payments', name: 'set_updated_at' },
    });
  }
};

exports.down = (pgm) => {
  pgm.dropTable({ schema: 'payments', name: 'payout_ledger_sales' }, { ifExists: true, cascade: true });
  pgm.dropTable({ schema: 'payments', name: 'payout_ledger' }, { ifExists: true, cascade: true });
  pgm.dropTable({ schema: 'payments', name: 'callback_log' }, { ifExists: true, cascade: true });
  pgm.dropTable({ schema: 'payments', name: 'payments' }, { ifExists: true, cascade: true });
  pgm.dropFunction({ schema: 'payments', name: 'set_updated_at' }, [], { ifExists: true, cascade: true });
  pgm.dropSchema('payments', { ifExists: true, cascade: true });
};
