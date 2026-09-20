const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createDarajaClient,
  darajaTimestamp,
  stkPassword,
} = require('../../_shared/mpesa/daraja');
const {
  MpesaTimeoutError,
  MpesaRejectedError,
  MpesaError,
  RESULT_CODES,
} = require('../../_shared/mpesa');

const NOW = Date.UTC(2026, 8, 19, 7, 5, 9);

function stub(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname + new URL(url).search;
    calls.push({ path, init, body: init.body ? JSON.parse(init.body) : null });
    const route = Object.keys(routes).find((k) => path.startsWith(k));
    if (!route) throw new Error(`unstubbed path ${path}`);
    const r = routes[route];
    if (typeof r === 'function') return r();
    return new Response(JSON.stringify(r.body ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

const TOKEN_OK = { body: { access_token: 'tok-123', expires_in: '3599' } };

function client(routes, extra = {}) {
  const s = stub(routes);
  return {
    ...s,
    mpesa: createDarajaClient({
      consumerKey: 'ck',
      consumerSecret: 'cs',
      shortcode: '174379',
      passkey: 'pk',
      fetch: s.fetchImpl,
      now: () => NOW,
      ...extra,
    }),
  };
}

describe('daraja adapter', () => {
  describe('config', () => {
    it('refuses to build without credentials', () => {
      assert.throws(
        () => createDarajaClient({ consumerKey: 'ck' }),
        (err) => err.code === 'MPESA_CONFIG_INVALID'
      );
    });

    it('defaults to the sandbox host', () => {
      const c = createDarajaClient({
        consumerKey: 'ck',
        consumerSecret: 'cs',
        shortcode: '1',
        passkey: 'p',
      });
      assert.equal(c.environment, 'sandbox');
      assert.equal(c.mode, 'daraja');
    });
  });

  describe('password and timestamp encoding', () => {
    it('formats the timestamp as YYYYMMDDHHmmss', () => {
      assert.equal(darajaTimestamp(new Date(NOW)), '20260919070509');
    });

    it('builds the STK password as base64(shortcode + passkey + timestamp)', () => {
      const ts = '20260919070509';
      assert.equal(
        stkPassword('174379', 'pk', ts),
        Buffer.from(`174379pk${ts}`, 'utf8').toString('base64')
      );
    });
  });

  describe('oauth', () => {
    it('fetches a token once and reuses it', async () => {
      const { mpesa, calls } = client({
        '/oauth/v1/generate': TOKEN_OK,
        '/mpesa/stkpush': { body: { ResponseCode: '0', MerchantRequestID: 'mr', CheckoutRequestID: 'ws_CO' } },
      });
      const req = {
        amountMinor: 15000,
        msisdn: '254700000000',
        accountReference: 'sale-1',
        callbackUrl: 'https://x/cb',
      };
      await mpesa.stkPush(req);
      await mpesa.stkPush(req);

      const tokenCalls = calls.filter((c) => c.path.startsWith('/oauth'));
      assert.equal(tokenCalls.length, 1, 'the token is cached');
      assert.match(tokenCalls[0].init.headers.authorization, /^Basic /);
      const push = calls.find((c) => c.path.startsWith('/mpesa/stkpush'));
      assert.equal(push.init.headers.authorization, 'Bearer tok-123');
    });
  });

  describe('stkPush', () => {
    it('sends the documented payload', async () => {
      const { mpesa, calls } = client({
        '/oauth/v1/generate': TOKEN_OK,
        '/mpesa/stkpush': {
          body: {
            ResponseCode: '0',
            ResponseDescription: 'ok',
            MerchantRequestID: 'mr-1',
            CheckoutRequestID: 'ws_CO_1',
            CustomerMessage: 'sent',
          },
        },
      });

      const out = await mpesa.stkPush({
        amountMinor: 15000,
        msisdn: '254700000000',
        accountReference: 'sale-abcdef0123456789',
        transactionDesc: 'TillFlow payment for chai',
        callbackUrl: 'https://tillflow.test/payments/callback',
      });

      assert.equal(out.checkoutRequestId, 'ws_CO_1');
      const body = calls.find((c) => c.path.startsWith('/mpesa/stkpush')).body;
      assert.equal(body.Amount, 150, 'daraja takes whole KES');
      assert.equal(body.PartyA, '254700000000');
      assert.equal(body.BusinessShortCode, '174379');
      assert.equal(body.Timestamp, '20260919070509');
      assert.ok(body.AccountReference.length <= 12);
      assert.ok(body.TransactionDesc.length <= 13);
    });

    it('rejects fractional KES rather than silently rounding', async () => {
      const { mpesa } = client({ '/oauth/v1/generate': TOKEN_OK });
      await assert.rejects(
        mpesa.stkPush({
          amountMinor: 15050,
          msisdn: '254700000000',
          accountReference: 's',
          callbackUrl: 'https://x',
        }),
        MpesaRejectedError
      );
    });

    it('rejects a bad msisdn before any network call', async () => {
      const { mpesa, calls } = client({});
      await assert.rejects(
        mpesa.stkPush({
          amountMinor: 100,
          msisdn: '0700000000',
          accountReference: 's',
          callbackUrl: 'https://x',
        }),
        MpesaRejectedError
      );
      assert.equal(calls.length, 0);
    });

    it('treats a non-zero ResponseCode as a refusal, not a success', async () => {
      const { mpesa } = client({
        '/oauth/v1/generate': TOKEN_OK,
        '/mpesa/stkpush': { body: { ResponseCode: '1', ResponseDescription: 'bad request' } },
      });
      await assert.rejects(
        mpesa.stkPush({
          amountMinor: 100,
          msisdn: '254700000000',
          accountReference: 's',
          callbackUrl: 'https://x',
        }),
        MpesaRejectedError
      );
    });
  });

  describe('a timeout is never a decline', () => {
    it('maps a transport abort to MpesaTimeoutError', async () => {
      const { mpesa } = client({
        '/oauth/v1/generate': TOKEN_OK,
        '/mpesa/stkpush': () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        },
      });
      await assert.rejects(
        mpesa.stkPush({
          amountMinor: 100,
          msisdn: '254700000000',
          accountReference: 's',
          callbackUrl: 'https://x',
        }),
        (err) => {
          assert.ok(err instanceof MpesaTimeoutError);
          assert.equal(err.outcomeKnown, false);
          return true;
        }
      );
    });

    it('maps a 5xx to MpesaTimeoutError, not a rejection', async () => {
      const { mpesa } = client({
        '/oauth/v1/generate': TOKEN_OK,
        '/mpesa/stkpush': { status: 503, body: { fault: 'upstream' } },
      });
      await assert.rejects(
        mpesa.stkPush({
          amountMinor: 100,
          msisdn: '254700000000',
          accountReference: 's',
          callbackUrl: 'https://x',
        }),
        (err) => err instanceof MpesaTimeoutError
      );
    });

    it('maps a 4xx to MpesaRejectedError', async () => {
      const { mpesa } = client({
        '/oauth/v1/generate': TOKEN_OK,
        '/mpesa/stkpush': { status: 400, body: { errorMessage: 'Bad Request' } },
      });
      await assert.rejects(
        mpesa.stkPush({
          amountMinor: 100,
          msisdn: '254700000000',
          accountReference: 's',
          callbackUrl: 'https://x',
        }),
        (err) => err instanceof MpesaRejectedError
      );
    });
  });

  describe('stkQuery', () => {
    it('returns the result code Daraja reports', async () => {
      const { mpesa } = client({
        '/oauth/v1/generate': TOKEN_OK,
        '/mpesa/stkpushquery': {
          body: { ResultCode: '1032', ResultDesc: 'Request cancelled by user', CheckoutRequestID: 'ws_CO_1' },
        },
      });
      const out = await mpesa.stkQuery({ checkoutRequestId: 'ws_CO_1' });
      assert.equal(out.resultCode, 1032);
    });

    it('maps "still being processed" to STILL_PROCESSING rather than throwing', async () => {
      const { mpesa } = client({
        '/oauth/v1/generate': TOKEN_OK,
        '/mpesa/stkpushquery': {
          status: 500,
          body: { errorMessage: 'The transaction is being processed' },
        },
      });
      const out = await mpesa.stkQuery({ checkoutRequestId: 'ws_CO_1' });
      assert.equal(out.resultCode, RESULT_CODES.STILL_PROCESSING);
    });
  });

  describe('b2c', () => {
    it('refuses without initiator credentials instead of sending a broken request', async () => {
      const { mpesa, calls } = client({ '/oauth/v1/generate': TOKEN_OK });
      await assert.rejects(
        mpesa.b2c({
          amountMinor: 1500,
          msisdn: '254700000000',
          originatorConversationId: 'oc-1',
        }),
        (err) => err instanceof MpesaError && err.code === 'MPESA_CONFIG_INVALID'
      );
      assert.equal(calls.length, 0);
    });

    it('sends our originator id and returns the conversation id', async () => {
      const { mpesa, calls } = client(
        {
          '/oauth/v1/generate': TOKEN_OK,
          '/mpesa/b2c': {
            body: {
              ResponseCode: '0',
              ResponseDescription: 'accepted',
              ConversationID: 'AG_1',
              OriginatorConversationID: 'oc-1',
            },
          },
        },
        {
          initiatorName: 'testapi',
          securityCredential: 'enc',
          resultUrl: 'https://x/b2c/result',
          queueTimeoutUrl: 'https://x/b2c/timeout',
        }
      );

      const out = await mpesa.b2c({
        amountMinor: 1500,
        msisdn: '254700000000',
        remarks: 'commission',
        originatorConversationId: 'oc-1',
      });

      assert.equal(out.conversationId, 'AG_1');
      assert.equal(out.responseCode, '0');
      const body = calls.find((c) => c.path.startsWith('/mpesa/b2c')).body;
      assert.equal(body.OriginatorConversationID, 'oc-1');
      assert.equal(body.Amount, 15);
      assert.equal(body.CommandID, 'BusinessPayment');
      assert.ok(body.ResultURL);
      assert.ok(body.QueueTimeOutURL);
    });
  });

  describe('callback verification', () => {
    it('reports plainly that daraja does not sign callbacks', () => {
      const { mpesa } = client({});
      assert.deepEqual(mpesa.verifyCallback(), {
        valid: false,
        reason: 'daraja_does_not_sign_callbacks',
      });
    });
  });
});
