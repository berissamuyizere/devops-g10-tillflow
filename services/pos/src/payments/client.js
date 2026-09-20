class PaymentsError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'PaymentsError';
    this.status = status;
    this.code = code || 'PAYMENTS_ERROR';
  }
}

class PaymentsUnavailableError extends PaymentsError {
  constructor(message, status) {
    super(message, status || 503, 'PAYMENTS_UNAVAILABLE');
    this.name = 'PaymentsUnavailableError';
  }
}

function createPaymentsClient(options = {}) {
  const baseUrl = (options.baseUrl || process.env.PAYMENTS_BASE_URL || 'http://payments:8080').replace(
    /\/+$/,
    ''
  );
  const token = options.token || (process.env.POS_SERVICE_TOKEN || '').trim();
  if (!token) {
    throw new PaymentsError('POS_SERVICE_TOKEN is not set', 500, 'PAYMENTS_MISCONFIGURED');
  }
  const fetchImpl = options.fetch || globalThis.fetch;
  const timeoutMs = options.timeoutMs || Number(process.env.PAYMENTS_TIMEOUT_MS || 5000);

  async function startCharge({ saleId, msisdn, idempotencyKey }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(`${baseUrl}/internal/v1/charges`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-pos-token': token,
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({ sale_id: saleId, msisdn }),
        signal: controller.signal,
      });
    } catch (err) {
      throw new PaymentsUnavailableError(`payments unreachable: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }

    const payload = await res.json().catch(() => ({}));

    if (res.ok) {
      return { payment: payload, replay: res.status === 200 && payload.replay === true };
    }

    if (res.status === 404) {
      throw new PaymentsError(payload.error || 'not_found', 404, payload.error || 'NOT_FOUND');
    }
    if (res.status === 409) {
      throw new PaymentsError(
        payload.error || 'conflict',
        409,
        payload.error || 'SALE_NOT_CHARGEABLE'
      );
    }
    if (res.status === 400) {
      throw new PaymentsError(
        payload.message || payload.error || 'validation',
        400,
        payload.error || 'VALIDATION'
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new PaymentsError(`payments auth failed → ${res.status}`, res.status, 'UNAUTHORIZED');
    }
    if (res.status >= 500) {
      throw new PaymentsUnavailableError(`payments → ${res.status}`, res.status);
    }
    throw new PaymentsError(`payments → ${res.status}`, res.status, payload.error || 'PAYMENTS_ERROR');
  }

  return { startCharge };
}

module.exports = {
  createPaymentsClient,
  PaymentsError,
  PaymentsUnavailableError,
};
