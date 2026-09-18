exports.shorthands = undefined;

const B2C_OUTCOMES =
  "('applied','replay_noop','rejected_bad_signature','rejected_unknown_payout'," +
  "'rejected_illegal_transition','rejected_malformed')";

exports.up = (pgm) => {
  pgm.addColumns(
    { schema: 'payments', name: 'payout_ledger' },
    {
      accepted_at: { type: 'timestamptz' },
      b2c_result_code: { type: 'integer' },
      b2c_transaction_id: { type: 'text' },
      b2c_sync_error: { type: 'text' },
    }
  );

  pgm.createIndex({ schema: 'payments', name: 'payout_ledger' }, ['b2c_transaction_id'], {
    name: 'payout_ledger_b2c_transaction_unique',
    unique: true,
    where: 'b2c_transaction_id IS NOT NULL',
  });

  pgm.createIndex({ schema: 'payments', name: 'payout_ledger' }, ['status', 'updated_at'], {
    name: 'payout_ledger_disbursing_idx',
    where: "status = 'disbursing'",
  });

  pgm.createTable(
    { schema: 'payments', name: 'payout_callback_log' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      ledger_id: {
        type: 'uuid',
        references: '"payments"."payout_ledger"',
        onDelete: 'RESTRICT',
      },
      originator_conversation_id: { type: 'text' },
      conversation_id: { type: 'text' },
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
    { schema: 'payments', name: 'payout_callback_log' },
    'payout_callback_log_outcome_check',
    `CHECK (outcome IN ${B2C_OUTCOMES})`
  );

  pgm.createIndex({ schema: 'payments', name: 'payout_callback_log' }, ['callback_hash'], {
    name: 'payout_callback_log_hash_unique',
    unique: true,
    where: "outcome = 'applied'",
  });

  pgm.createIndex({ schema: 'payments', name: 'payout_callback_log' }, ['ledger_id'], {
    name: 'payout_callback_log_ledger_unique',
    unique: true,
    where: "outcome = 'applied'",
  });

  pgm.createIndex({ schema: 'payments', name: 'callback_log' }, ['payment_id'], {
    name: 'callback_log_payment_applied_unique',
    unique: true,
    where: "outcome = 'applied' AND payment_id IS NOT NULL",
  });
};

exports.down = (pgm) => {
  pgm.dropIndex({ schema: 'payments', name: 'callback_log' }, [], {
    name: 'callback_log_payment_applied_unique',
    ifExists: true,
  });
  pgm.dropTable({ schema: 'payments', name: 'payout_callback_log' }, {
    ifExists: true,
    cascade: true,
  });
  pgm.dropIndex({ schema: 'payments', name: 'payout_ledger' }, [], {
    name: 'payout_ledger_disbursing_idx',
    ifExists: true,
  });
  pgm.dropIndex({ schema: 'payments', name: 'payout_ledger' }, [], {
    name: 'payout_ledger_b2c_transaction_unique',
    ifExists: true,
  });
  pgm.dropColumns({ schema: 'payments', name: 'payout_ledger' }, [
    'accepted_at',
    'b2c_result_code',
    'b2c_transaction_id',
    'b2c_sync_error',
  ]);
};
