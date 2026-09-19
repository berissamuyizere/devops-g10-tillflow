const {
  RESULT_CODES,
  MpesaError,
  MpesaTimeoutError,
  MpesaRejectedError,
} = require('./interface');

const HOSTS = Object.freeze({
  sandbox: 'https://sandbox.safaricom.co.ke',
  production: 'https://api.safaricom.co.ke',
});

function requireField(value, name) {
  if (!value) {
    throw new MpesaError(`daraja config missing ${name}`, 'MPESA_CONFIG_INVALID');
  }
  return value;
}

function darajaTimestamp(date) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`
  );
}

function stkPassword(shortcode, passkey, timestamp) {
  return Buffer.from(`${shortcode}${passkey}${timestamp}`, 'utf8').toString('base64');
}

function toWholeKes(amountMinor) {
  if (!Number.isInteger(amountMinor) || amountMinor <= 0) {
    throw new MpesaRejectedError('amount must be a positive integer', { field: 'amountMinor' });
  }
  if (amountMinor % 100 !== 0) {
    throw new MpesaRejectedError('daraja only accepts whole KES amounts', {
      field: 'amountMinor',
      amountMinor,
    });
  }
  return amountMinor / 100;
}

function validateMsisdn(msisdn) {
  if (!/^2547\d{8}$/.test(String(msisdn || ''))) {
    throw new MpesaRejectedError('invalid msisdn', { field: 'msisdn' });
  }
  return String(msisdn);
}

function isTransportFailure(err) {
  const name = err?.name || '';
  const code = err?.cause?.code || err?.code || '';
  return (
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT/.test(
      String(code)
    )
  );
}

function createDarajaClient(options = {}) {
  const environment = options.environment || process.env.DARAJA_ENVIRONMENT || 'sandbox';
  const baseUrl = (options.baseUrl || HOSTS[environment] || HOSTS.sandbox).replace(/\/+$/, '');

  const consumerKey = requireField(options.consumerKey, 'consumer_key');
  const consumerSecret = requireField(options.consumerSecret, 'consumer_secret');
  const passkey = requireField(options.passkey, 'passkey');
  const shortcodeDefault = requireField(options.shortcode, 'shortcode');

  const initiatorName = options.initiatorName || null;
  const securityCredential = options.securityCredential || null;

  const fetchImpl = options.fetch || globalThis.fetch;
  const now = options.now || (() => Date.now());
  const timeoutMs = Number(options.timeoutMs || process.env.DARAJA_TIMEOUT_MS || 20000);

  let token = null;
  let tokenExpiresAt = 0;

  async function call(path, { method = 'POST', body, auth, headers = {} } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(auth ? { authorization: auth } : {}),
          ...headers,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      if (isTransportFailure(err)) {
        throw new MpesaTimeoutError(`daraja did not respond: ${err.message}`, { path });
      }
      throw new MpesaError(`daraja request failed: ${err.message}`, 'MPESA_TRANSPORT');
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text().catch(() => '');
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text };
    }

    if (res.status >= 500) {
      const detail = payload.errorMessage || payload.ResponseDescription || '';
      throw new MpesaTimeoutError(
        `daraja ${res.status} on ${path}${detail ? `: ${detail}` : ''}`,
        { path, status: res.status, errorMessage: detail || null }
      );
    }
    if (!res.ok) {
      throw new MpesaRejectedError(
        payload.errorMessage || payload.ResponseDescription || `daraja ${res.status} on ${path}`,
        { path, status: res.status, errorCode: payload.errorCode || null }
      );
    }
    return payload;
  }

  async function accessToken() {
    if (token && now() < tokenExpiresAt) return token;
    const basic = Buffer.from(`${consumerKey}:${consumerSecret}`, 'utf8').toString('base64');
    const payload = await call('/oauth/v1/generate?grant_type=client_credentials', {
      method: 'GET',
      auth: `Basic ${basic}`,
    });
    if (!payload.access_token) {
      throw new MpesaRejectedError('daraja returned no access_token');
    }
    token = payload.access_token;
    const ttl = Number(payload.expires_in || 3599);
    tokenExpiresAt = now() + Math.max(ttl - 60, 30) * 1000;
    return token;
  }

  async function authed(path, body) {
    return call(path, { body, auth: `Bearer ${await accessToken()}` });
  }

  async function stkPush(req) {
    const msisdn = validateMsisdn(req.msisdn);
    const amount = toWholeKes(req.amountMinor);
    const shortcode = req.shortcode || shortcodeDefault;
    if (!req.accountReference) {
      throw new MpesaRejectedError('accountReference required', { field: 'accountReference' });
    }
    const timestamp = darajaTimestamp(new Date(now()));

    const payload = await authed('/mpesa/stkpush/v1/processrequest', {
      BusinessShortCode: shortcode,
      Password: stkPassword(shortcode, passkey, timestamp),
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: amount,
      PartyA: msisdn,
      PartyB: shortcode,
      PhoneNumber: msisdn,
      CallBackURL: req.callbackUrl,
      AccountReference: String(req.accountReference).slice(0, 12),
      TransactionDesc: String(req.transactionDesc || 'TillFlow').slice(0, 13),
    });

    if (String(payload.ResponseCode) !== '0') {
      throw new MpesaRejectedError(payload.ResponseDescription || 'stk push refused', {
        responseCode: payload.ResponseCode,
      });
    }

    return {
      merchantRequestId: payload.MerchantRequestID,
      checkoutRequestId: payload.CheckoutRequestID,
      responseCode: String(payload.ResponseCode),
      responseDescription: payload.ResponseDescription,
      customerMessage: payload.CustomerMessage,
    };
  }

  async function stkQuery(req) {
    const shortcode = req.shortcode || shortcodeDefault;
    const timestamp = darajaTimestamp(new Date(now()));
    let payload;
    try {
      payload = await authed('/mpesa/stkpushquery/v1/query', {
        BusinessShortCode: shortcode,
        Password: stkPassword(shortcode, passkey, timestamp),
        Timestamp: timestamp,
        CheckoutRequestID: req.checkoutRequestId,
      });
    } catch (err) {
      const stillProcessing =
        (err instanceof MpesaRejectedError || err instanceof MpesaTimeoutError) &&
        /being processed|still under processing|processed/i.test(String(err.message));
      if (stillProcessing) {
        return {
          merchantRequestId: null,
          checkoutRequestId: req.checkoutRequestId,
          resultCode: RESULT_CODES.STILL_PROCESSING,
          resultDesc: err.message,
          mpesaReceipt: null,
          amountMinor: null,
        };
      }
      throw err;
    }

    const resultCode = Number(payload.ResultCode);
    return {
      merchantRequestId: payload.MerchantRequestID ?? null,
      checkoutRequestId: payload.CheckoutRequestID ?? req.checkoutRequestId,
      resultCode: Number.isFinite(resultCode) ? resultCode : RESULT_CODES.STILL_PROCESSING,
      resultDesc: payload.ResultDesc ?? null,
      mpesaReceipt: null,
      amountMinor: null,
    };
  }

  async function b2c(req) {
    if (!initiatorName || !securityCredential) {
      throw new MpesaError(
        'b2c needs initiator_name and security_credential in the daraja secret',
        'MPESA_CONFIG_INVALID'
      );
    }
    const msisdn = validateMsisdn(req.msisdn);
    const amount = toWholeKes(req.amountMinor);
    const shortcode = req.shortcode || shortcodeDefault;
    if (!req.originatorConversationId) {
      throw new MpesaRejectedError('originatorConversationId required', {
        field: 'originatorConversationId',
      });
    }

    const payload = await authed('/mpesa/b2c/v1/paymentrequest', {
      OriginatorConversationID: req.originatorConversationId,
      InitiatorName: initiatorName,
      SecurityCredential: securityCredential,
      CommandID: 'BusinessPayment',
      Amount: amount,
      PartyA: shortcode,
      PartyB: msisdn,
      Remarks: String(req.remarks || 'TillFlow commission').slice(0, 100),
      QueueTimeOutURL: req.queueTimeoutUrl || options.queueTimeoutUrl,
      ResultURL: req.resultUrl || options.resultUrl,
      Occasion: req.occasion || '',
    });

    if (String(payload.ResponseCode) !== '0') {
      throw new MpesaRejectedError(payload.ResponseDescription || 'b2c refused', {
        responseCode: payload.ResponseCode,
      });
    }

    return {
      conversationId: payload.ConversationID,
      originatorConversationId:
        payload.OriginatorConversationID || req.originatorConversationId,
      responseCode: String(payload.ResponseCode),
      responseDescription: payload.ResponseDescription,
    };
  }

  async function b2cQuery(req) {
    if (!initiatorName || !securityCredential) {
      throw new MpesaError(
        'b2c query needs initiator_name and security_credential in the daraja secret',
        'MPESA_CONFIG_INVALID'
      );
    }
    const payload = await authed('/mpesa/transactionstatus/v1/query', {
      Initiator: initiatorName,
      SecurityCredential: securityCredential,
      CommandID: 'TransactionStatusQuery',
      TransactionID: req.transactionId || '',
      OriginatorConversationID: req.originatorConversationId,
      PartyA: req.shortcode || shortcodeDefault,
      IdentifierType: '4',
      ResultURL: req.resultUrl || options.resultUrl,
      QueueTimeOutURL: req.queueTimeoutUrl || options.queueTimeoutUrl,
      Remarks: 'TillFlow payout reconciliation',
    });

    return {
      originatorConversationId: req.originatorConversationId,
      conversationId: payload.ConversationID ?? null,
      resultCode: RESULT_CODES.STILL_PROCESSING,
      resultDesc: payload.ResponseDescription ?? 'status query accepted; result arrives on ResultURL',
      transactionId: null,
    };
  }

  function verifyCallback() {
    return { valid: false, reason: 'daraja_does_not_sign_callbacks' };
  }

  return {
    stkPush,
    stkQuery,
    verifyCallback,
    b2c,
    b2cQuery,
    mode: 'daraja',
    environment,
  };
}

module.exports = { createDarajaClient, darajaTimestamp, stkPassword, HOSTS };
