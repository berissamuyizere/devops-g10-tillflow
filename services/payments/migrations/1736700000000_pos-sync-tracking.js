exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns(
    { schema: 'payments', name: 'payments' },
    {
      pos_awaiting_synced_at: { type: 'timestamptz' },
      pos_paid_synced_at: { type: 'timestamptz' },
      pos_sync_error: { type: 'text' },
    }
  );

  pgm.createIndex({ schema: 'payments', name: 'payments' }, ['status', 'updated_at'], {
    name: 'payments_confirmed_unsynced_idx',
    where: "status = 'confirmed' AND pos_paid_synced_at IS NULL",
  });

  pgm.createIndex({ schema: 'payments', name: 'payments' }, ['updated_at'], {
    name: 'payments_pos_sync_error_idx',
    where: 'pos_sync_error IS NOT NULL',
  });
};

exports.down = (pgm) => {
  pgm.dropIndex({ schema: 'payments', name: 'payments' }, [], {
    name: 'payments_pos_sync_error_idx',
    ifExists: true,
  });
  pgm.dropIndex({ schema: 'payments', name: 'payments' }, [], {
    name: 'payments_confirmed_unsynced_idx',
    ifExists: true,
  });
  pgm.dropColumns({ schema: 'payments', name: 'payments' }, [
    'pos_awaiting_synced_at',
    'pos_paid_synced_at',
    'pos_sync_error',
  ]);
};
