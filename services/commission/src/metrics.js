const { metrics } = require('@opentelemetry/api');

const METER_NAME = 'tillflow.commission';

let meter;
let closeRunsTotal;
let payoutsRequestedTotal;

function getMeter() {
  if (!meter) meter = metrics.getMeter(METER_NAME);
  return meter;
}

function init() {
  const m = getMeter();

  closeRunsTotal = m.createCounter('commission_close_runs_total', {
    description: 'Daily close runs, by outcome',
  });

  payoutsRequestedTotal = m.createCounter('commission_payouts_requested_total', {
    description: 'Payout requests to Payments, by outcome',
  });
}

function ensure() {
  if (!closeRunsTotal) init();
}

function recordCloseRun(outcome) {
  ensure();
  closeRunsTotal.add(1, { outcome });
}

function recordPayoutRequested(outcome) {
  ensure();
  payoutsRequestedTotal.add(1, { outcome });
}

function resetForTests() {
  meter = undefined;
  closeRunsTotal = undefined;
  payoutsRequestedTotal = undefined;
}

module.exports = {
  METER_NAME,
  recordCloseRun,
  recordPayoutRequested,
  resetForTests,
};
