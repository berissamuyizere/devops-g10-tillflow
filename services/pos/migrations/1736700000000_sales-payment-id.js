/**
 * Persist the Payments payment_id on the sale so /paid is replay-safe:
 * same payment_id → 200 no-op; a different payment_id → 409.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumns(
    { schema: 'pos', name: 'sales' },
    {
      payment_id: { type: 'text' },
    }
  );
};

exports.down = (pgm) => {
  pgm.dropColumns({ schema: 'pos', name: 'sales' }, ['payment_id']);
};
