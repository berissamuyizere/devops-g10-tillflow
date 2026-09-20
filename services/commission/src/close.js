// Daily close → POS eligibility → Payments payouts.
// Commission never calls Daraja (ADR-002). Payments owns B2C.

const { trace, SpanStatusCode } = require('@opentelemetry/api');
const commissionMetrics = require('./metrics');

function getTracer() {
  return trace.getTracer('tillflow.commission');
}

function eatDate(value) {
  const d = value ? new Date(value) : new Date();
  if (Number.isNaN(d.getTime())) {
    throw new Error(`invalid timestamp: ${value}`);
  }
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/** EAT business day the close pays out — always the calendar day before the job runs. */
function closePeriodFor(value) {
  const eatToday = eatDate(value);
  const anchor = new Date(`${eatToday}T12:00:00+03:00`);
  anchor.setDate(anchor.getDate() - 1);
  return eatDate(anchor);
}

const BUSINESS_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Production default is previous EAT day; evidence/manual close may pass businessDay explicitly. */
function resolveClosePeriod({ scheduledAt, businessDay } = {}) {
  const override = String(businessDay ?? '').trim();
  if (override && BUSINESS_DAY_RE.test(override)) {
    return override;
  }
  return closePeriodFor(scheduledAt);
}

function parseTenantIds(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function groupByAgent(sales) {
  const groups = new Map();
  for (const sale of sales) {
    const key = sale.attendant_id;
    if (!key) continue;
    if (!groups.has(key)) {
      groups.set(key, {
        tenant_id: sale.tenant_id,
        agent_id: key,
        msisdn: sale.payout_msisdn,
        commission_bps: sale.commission_bps,
        sales: [],
      });
    }
    groups.get(key).sales.push(sale.id);
  }
  return [...groups.values()];
}

async function fetchEligible(fetchImpl, { posBaseUrl, paymentsToken, tenantId, period }) {
  const url = new URL('/internal/v1/commission/eligible', `${posBaseUrl.replace(/\/+$/, '')}/`);
  url.searchParams.set('tenant_id', tenantId);
  url.searchParams.set('business_day', period);
  const res = await fetchImpl(url.toString(), {
    headers: { 'x-payments-token': paymentsToken },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`pos eligible ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return Array.isArray(body.sales) ? body.sales : [];
}

function payoutOutcomeFromResult(result) {
  if (result.skipped) return 'skipped';
  if (result.conflict) return 'conflict';
  if (result.replay) return 'replay';
  if (result.http === 201 || result.http === 200) return 'accepted';
  return 'error';
}

async function requestPayout(fetchImpl, { paymentsBaseUrl, commissionToken, period, group }) {
  const res = await fetchImpl(`${paymentsBaseUrl.replace(/\/+$/, '')}/internal/v1/payouts`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-commission-token': commissionToken,
      'idempotency-key': `${group.agent_id}:${period}`,
    },
    body: JSON.stringify({
      tenant_id: group.tenant_id,
      agent_id: group.agent_id,
      period,
      msisdn: group.msisdn,
      commission_bps: group.commission_bps,
      sales: group.sales,
    }),
  });
  const body = await res.json().catch(() => ({}));
  // 409 is not retryable (already handled or genuine disagreement).
  if (res.status === 409) {
    return { http: 409, replay: false, conflict: true, ledger: body };
  }
  if (res.status !== 200 && res.status !== 201) {
    const err = new Error(`payout ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return { http: res.status, replay: body.replay === true, ledger: body };
}

async function runDailyCloseInner({
  fetchImpl = fetch,
  posBaseUrl,
  paymentsBaseUrl,
  paymentsToken,
  commissionToken,
  tenantIds,
  scheduledAt,
  businessDay,
  logger = console,
} = {}) {
  if (!paymentsToken || !commissionToken) {
    throw new Error('PAYMENTS_SERVICE_TOKEN and COMMISSION_SERVICE_TOKEN are required');
  }
  const period = resolveClosePeriod({ scheduledAt, businessDay });
  const tenants = Array.isArray(tenantIds) ? tenantIds : parseTenantIds(tenantIds);
  if (tenants.length === 0) {
    throw new Error('COMMISSION_TENANT_IDS is empty');
  }

  const payouts = [];
  for (const tenantId of tenants) {
    const sales = await fetchEligible(fetchImpl, {
      posBaseUrl,
      paymentsToken,
      tenantId,
      period,
    });
    const groups = groupByAgent(sales);
    logger.info?.({ tenant_id: tenantId, period, agents: groups.length, sales: sales.length }, 'close_eligible');
    for (const group of groups) {
      if (!group.msisdn) {
        logger.warn?.({ tenant_id: tenantId, agent_id: group.agent_id }, 'close_skip_missing_msisdn');
        const skipped = { tenant_id: tenantId, agent_id: group.agent_id, skipped: true };
        commissionMetrics.recordPayoutRequested('skipped');
        payouts.push(skipped);
        continue;
      }
      const result = await requestPayout(fetchImpl, {
        paymentsBaseUrl,
        commissionToken,
        period,
        group,
      });
      commissionMetrics.recordPayoutRequested(payoutOutcomeFromResult(result));
      payouts.push({ tenant_id: tenantId, agent_id: group.agent_id, ...result });
    }
  }
  return { period, payouts };
}

async function runDailyClose(options = {}) {
  return getTracer().startActiveSpan('commission.daily_close', async (span) => {
    try {
      const period = resolveClosePeriod({
        scheduledAt: options.scheduledAt,
        businessDay: options.businessDay,
      });
      span.setAttribute('commission.period', period);
      const result = await runDailyCloseInner(options);
      commissionMetrics.recordCloseRun('success');
      return result;
    } catch (err) {
      commissionMetrics.recordCloseRun('error');
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(err.message || err) });
      throw err;
    } finally {
      span.end();
    }
  });
}

module.exports = {
  eatDate,
  closePeriodFor,
  resolveClosePeriod,
  parseTenantIds,
  groupByAgent,
  runDailyClose,
};
