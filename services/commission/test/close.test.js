const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  eatDate,
  closePeriodFor,
  resolveClosePeriod,
  groupByAgent,
  runDailyClose,
} = require('../src/close');

describe('commission close', () => {
  it('formats the EAT business day', () => {
    assert.equal(eatDate('2026-09-18T20:45:00.000Z'), '2026-09-18');
  });

  it('closes the previous EAT day so sales after 23:45 still earn commission', () => {
    // Job at 23:45 EAT on 19 Sep pays out 18 Sep (includes sales paid 23:45–midnight on 18).
    assert.equal(closePeriodFor('2026-09-19T20:45:00.000Z'), '2026-09-18');
    // Job at 01:00 EAT on 20 Sep pays out 19 Sep (full prior calendar day).
    assert.equal(closePeriodFor('2026-09-19T22:00:00.000Z'), '2026-09-19');
  });

  it('groups eligible sales by attendant', () => {
    const groups = groupByAgent([
      {
        id: 's1',
        tenant_id: 't1',
        attendant_id: 'a1',
        payout_msisdn: '254700000001',
        commission_bps: 500,
      },
      {
        id: 's2',
        tenant_id: 't1',
        attendant_id: 'a1',
        payout_msisdn: '254700000001',
        commission_bps: 500,
      },
    ]);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].sales, ['s1', 's2']);
  });

  it('uses businessDay override when provided (evidence / manual close)', async () => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push({ url });
      if (String(url).includes('/commission/eligible')) {
        return { ok: true, status: 200, json: async () => ({ sales: [] }) };
      }
      return { ok: true, status: 201, json: async () => ({ id: 'ledger-1', status: 'disbursing' }) };
    };

    const out = await runDailyClose({
      fetchImpl,
      posBaseUrl: 'http://pos.example',
      paymentsBaseUrl: 'http://pay.example',
      paymentsToken: 'pay-token',
      commissionToken: 'comm-token',
      tenantIds: ['t1'],
      scheduledAt: '2026-09-19T20:45:00.000Z',
      businessDay: '2026-09-19',
    });

    assert.equal(resolveClosePeriod({ scheduledAt: '2026-09-19T20:45:00.000Z' }), '2026-09-18');
    assert.equal(out.period, '2026-09-19');
    assert.ok(String(calls[0].url).includes('business_day=2026-09-19'));
  });

  it('calls Payments once per agent and treats 200 as replay', async () => {
    const calls = [];
    const fetchImpl = async (url, init = {}) => {
      calls.push({ url, init });
      if (String(url).includes('/commission/eligible')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            sales: [
              {
                id: 'sale-1',
                tenant_id: '11111111-1111-1111-1111-111111111111',
                attendant_id: '22222222-2222-2222-2222-222222222222',
                payout_msisdn: '254700000000',
                commission_bps: 500,
              },
            ],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'ledger-1', status: 'disbursing', replay: true }),
      };
    };

    const out = await runDailyClose({
      fetchImpl,
      posBaseUrl: 'http://pos.example',
      paymentsBaseUrl: 'http://pay.example',
      paymentsToken: 'pay-token',
      commissionToken: 'comm-token',
      tenantIds: ['11111111-1111-1111-1111-111111111111'],
      scheduledAt: '2026-09-18T20:45:00.000Z',
    });

    assert.equal(out.period, '2026-09-17');
    assert.equal(out.payouts.length, 1);
    assert.equal(out.payouts[0].replay, true);
    assert.equal(calls.length, 2);
    const eligibleCall = calls[0];
    assert.ok(String(eligibleCall.url).includes('business_day=2026-09-17'));
    const payoutCall = calls[1];
    assert.equal(payoutCall.init.headers['x-commission-token'], 'comm-token');
    assert.equal(
      payoutCall.init.headers['idempotency-key'],
      '22222222-2222-2222-2222-222222222222:2026-09-17'
    );
    assert.ok(!JSON.stringify(calls).toLowerCase().includes('daraja'));
  });

  it('treats payout 409 as handled (not retryable)', async () => {
    const fetchImpl = async (url) => {
      if (String(url).includes('/commission/eligible')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            sales: [
              {
                id: 'sale-1',
                tenant_id: 't1',
                attendant_id: 'a1',
                payout_msisdn: '254700000000',
                commission_bps: 500,
              },
            ],
          }),
        };
      }
      return { ok: false, status: 409, json: async () => ({ error: 'PAYOUT_CONFLICT' }) };
    };
    const out = await runDailyClose({
      fetchImpl,
      posBaseUrl: 'http://pos.example',
      paymentsBaseUrl: 'http://pay.example',
      paymentsToken: 'pay-token',
      commissionToken: 'comm-token',
      tenantIds: ['t1'],
      scheduledAt: '2026-09-18T20:45:00.000Z',
    });
    assert.equal(out.payouts.length, 1);
    assert.equal(out.payouts[0].conflict, true);
    assert.equal(out.payouts[0].http, 409);
  });

  it('fails closed when service tokens are missing', async () => {
    await assert.rejects(
      () =>
        runDailyClose({
          posBaseUrl: 'http://pos.example',
          paymentsBaseUrl: 'http://pay.example',
          tenantIds: ['t1'],
        }),
      /PAYMENTS_SERVICE_TOKEN and COMMISSION_SERVICE_TOKEN/
    );
  });

  it('does not delete-path: payout 500 throws so the SQS poller can retry', async () => {
    const fetchImpl = async (url) => {
      if (String(url).includes('/commission/eligible')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            sales: [
              {
                id: 'sale-1',
                tenant_id: 't1',
                attendant_id: 'a1',
                payout_msisdn: '254700000000',
                commission_bps: 500,
              },
            ],
          }),
        };
      }
      return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
    };
    await assert.rejects(
      () =>
        runDailyClose({
          fetchImpl,
          posBaseUrl: 'http://pos.example',
          paymentsBaseUrl: 'http://pay.example',
          paymentsToken: 'pay-token',
          commissionToken: 'comm-token',
          tenantIds: ['t1'],
          scheduledAt: '2026-09-18T20:45:00.000Z',
        }),
      /payout 500/
    );
  });
});
