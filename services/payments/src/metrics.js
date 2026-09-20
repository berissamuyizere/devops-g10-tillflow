const { metrics } = require('@opentelemetry/api');

const METER_NAME = 'tillflow.payments';

let meter;
let commandsTotal;
let callbackLatencyMs;
let callbacksTotal;
let oldestPendingAgeSeconds;
let payoutsByStatus;

let observedPending = { payment: 0, payout: 0 };
let observedPayouts = {};

function getMeter() {
  if (!meter) meter = metrics.getMeter(METER_NAME);
  return meter;
}

function init() {
  const m = getMeter();

  commandsTotal = m.createCounter('payments_commands_total', {
    description: 'Daraja commands sent, by kind and outcome',
  });

  callbackLatencyMs = m.createHistogram('payments_callback_latency_ms', {
    description: 'Time from command acceptance to callback applied',
    unit: 'ms',
  });

  callbacksTotal = m.createCounter('payments_callbacks_total', {
    description: 'Callbacks received, by kind and outcome',
  });

  oldestPendingAgeSeconds = m.createObservableGauge('payments_oldest_pending_age_seconds', {
    description: 'Age of the oldest unsettled payment or payout',
    unit: 's',
  });
  oldestPendingAgeSeconds.addCallback((result) => {
    for (const [kind, value] of Object.entries(observedPending)) {
      result.observe(value, { kind });
    }
  });

  payoutsByStatus = m.createObservableGauge('payouts_by_status', {
    description: 'Payout ledger rows by status',
  });
  payoutsByStatus.addCallback((result) => {
    for (const [status, value] of Object.entries(observedPayouts)) {
      result.observe(value, { status });
    }
  });
}

function ensure() {
  if (!commandsTotal) init();
}

function recordCommand(kind, outcome) {
  ensure();
  commandsTotal.add(1, { kind, outcome });
}

function recordCallback(kind, outcome, latencyMs) {
  ensure();
  callbacksTotal.add(1, { kind, outcome });
  if (typeof latencyMs === 'number' && Number.isFinite(latencyMs) && latencyMs >= 0) {
    callbackLatencyMs.record(latencyMs, { kind });
  }
}

function setOldestPendingAge(kind, seconds) {
  ensure();
  observedPending[kind] = Number.isFinite(seconds) ? seconds : 0;
}

function setPayoutsByStatus(counts) {
  ensure();
  observedPayouts = { ...counts };
}

const PENDING_AGE_SQL = `
  SELECT
    COALESCE(EXTRACT(EPOCH FROM (now() - MIN(p.created_at))), 0)::float AS payment_age,
    COALESCE((
      SELECT EXTRACT(EPOCH FROM (now() - MIN(l.created_at)))
      FROM payments.payout_ledger l
      WHERE l.status IN ('pending', 'disbursing')
    ), 0)::float AS payout_age
  FROM payments.payments p
  WHERE p.status IN ('initiated', 'pending', 'confirmed')
`;

const PAYOUT_STATUS_SQL = `
  SELECT status, count(*)::int AS n
  FROM payments.payout_ledger
  GROUP BY status
`;

async function refreshFromDb(db) {
  const [ages, statuses] = await Promise.all([
    db.query(PENDING_AGE_SQL),
    db.query(PAYOUT_STATUS_SQL),
  ]);

  const row = ages.rows[0] || {};
  setOldestPendingAge('payment', Number(row.payment_age) || 0);
  setOldestPendingAge('payout', Number(row.payout_age) || 0);

  const counts = { pending: 0, disbursing: 0, disbursed: 0, failed: 0 };
  for (const r of statuses.rows) counts[r.status] = r.n;
  setPayoutsByStatus(counts);

  return { pending: { ...observedPending }, payouts: { ...observedPayouts } };
}

function startDbRefresh(db, { intervalMs = 15000, logger } = {}) {
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      await refreshFromDb(db);
    } catch (err) {
      logger?.warn?.({ err: String(err.message || err) }, 'metrics_refresh_failed');
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

function resetForTests() {
  observedPending = { payment: 0, payout: 0 };
  observedPayouts = {};
}

module.exports = {
  METER_NAME,
  recordCommand,
  recordCallback,
  setOldestPendingAge,
  setPayoutsByStatus,
  refreshFromDb,
  startDbRefresh,
  resetForTests,
};
