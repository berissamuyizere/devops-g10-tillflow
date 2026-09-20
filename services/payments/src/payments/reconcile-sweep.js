const paymentsService = require('./service');
const { STATUSES } = require('./state');

const DUE_SQL = `
  SELECT id
  FROM payments.payments
  WHERE status = $1
    AND checkout_request_id IS NOT NULL
    AND created_at < now() - ($2::int * interval '1 millisecond')
  ORDER BY created_at ASC
  LIMIT $3
`;

function createReconcileSweep(db, mpesa, pos, options = {}) {
  const intervalMs = Number(options.intervalMs ?? process.env.RECONCILE_SWEEP_INTERVAL_MS ?? 60000);
  const minAgeMs = Number(options.minAgeMs ?? process.env.RECONCILE_MIN_AGE_MS ?? 120000);
  const batchSize = Number(options.batchSize ?? process.env.RECONCILE_BATCH_SIZE ?? 25);
  const logger = options.logger || null;

  let timer = null;
  let running = false;

  async function dueIds() {
    const res = await db.query(DUE_SQL, [STATUSES.PENDING, minAgeMs, batchSize]);
    return res.rows.map((row) => row.id);
  }

  async function runOnce() {
    if (running) return { skipped: 'already_running' };
    running = true;
    try {
      const ids = await dueIds();
      const summary = { examined: ids.length, changed: 0, unchanged: 0, errors: 0, reasons: {} };

      for (const id of ids) {
        try {
          const result = await paymentsService.reconcilePayment(db, mpesa, pos, id);
          if (result.changed) summary.changed += 1;
          else summary.unchanged += 1;
          const reason = result.reason || (result.changed ? 'settled' : 'unknown');
          summary.reasons[reason] = (summary.reasons[reason] || 0) + 1;
        } catch (err) {
          summary.errors += 1;
          logger?.warn({ payment_id: id, err: err.message }, 'reconcile_sweep_error');
        }
      }

      if (summary.examined > 0) {
        logger?.info(summary, 'reconcile_sweep');
      }
      return summary;
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return timer;
    timer = setInterval(() => {
      runOnce().catch((err) => logger?.error({ err: err.message }, 'reconcile_sweep_failed'));
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
    return timer;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { runOnce, start, stop, config: { intervalMs, minAgeMs, batchSize } };
}

module.exports = { createReconcileSweep };
