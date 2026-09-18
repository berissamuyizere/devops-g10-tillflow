const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
const { startPoller } = require('../src/poller');

function silentLogger() {
  return { info() {}, warn() {}, error() {} };
}

function fakeSqs({ bodies, onDelete, onReceive }) {
  let i = 0;
  return {
    async send(cmd) {
      if (cmd instanceof ReceiveMessageCommand) {
        onReceive?.();
        const body = bodies[i];
        i += 1;
        if (!body) {
          await new Promise((r) => setTimeout(r, 20));
          return { Messages: [] };
        }
        return {
          Messages: [{ MessageId: 'm1', ReceiptHandle: 'rh-1', Body: body }],
        };
      }
      if (cmd instanceof DeleteMessageCommand) {
        onDelete?.(cmd.input);
        return {};
      }
      throw new Error(`unexpected command ${cmd.constructor.name}`);
    },
  };
}

describe('commission SQS poller', () => {
  it('deletes the message after a successful close', async () => {
    let deleted = false;
    const poller = startPoller({
      queueUrl: 'https://sqs.example/close',
      region: 'eu-central-1',
      posBaseUrl: 'http://pos.example',
      paymentsBaseUrl: 'http://pay.example',
      paymentsToken: 'pay-token',
      commissionToken: 'comm-token',
      tenantIds: ['t1'],
      logger: silentLogger(),
      retryDelayMs: 20,
      fetchImpl: async (url) => {
        if (String(url).includes('/commission/eligible')) {
          return { ok: true, status: 200, json: async () => ({ sales: [] }) };
        }
        throw new Error(`unexpected url ${url}`);
      },
      sqsClient: fakeSqs({
        bodies: [JSON.stringify({ type: 'commission.daily-close', scheduled_at: '2026-09-18T20:45:00.000Z' })],
        onDelete: () => {
          deleted = true;
        },
      }),
    });
    await new Promise((r) => setTimeout(r, 50));
    await poller.stop();
    assert.equal(deleted, true);
  });

  it('does not delete when payouts fail (retry via visibility timeout)', async () => {
    let deleted = false;
    let receives = 0;
    const poller = startPoller({
      queueUrl: 'https://sqs.example/close',
      region: 'eu-central-1',
      posBaseUrl: 'http://pos.example',
      paymentsBaseUrl: 'http://pay.example',
      paymentsToken: 'pay-token',
      commissionToken: 'comm-token',
      tenantIds: ['t1'],
      logger: silentLogger(),
      retryDelayMs: 20,
      fetchImpl: async (url) => {
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
      },
      sqsClient: fakeSqs({
        bodies: [JSON.stringify({ type: 'commission.daily-close', scheduled_at: '2026-09-18T20:45:00.000Z' })],
        onDelete: () => {
          deleted = true;
        },
        onReceive: () => {
          receives += 1;
        },
      }),
    });
    await new Promise((r) => setTimeout(r, 80));
    await poller.stop();
    assert.equal(deleted, false);
    assert.ok(receives >= 1);
  });
});
