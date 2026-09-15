class PosError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'PosError';
    this.status = status;
    this.code = code || 'POS_ERROR';
    this.retryable = false;
  }
}

class PosUnavailableError extends PosError {
  constructor(message, status) {
    super(message, status || 503, 'POS_UNAVAILABLE');
    this.name = 'PosUnavailableError';
    this.retryable = true;
  }
}

class PosConflictError extends PosError {
  constructor(message, posCode) {
    super(message, 409, 'POS_CONFLICT');
    this.name = 'PosConflictError';
    this.posCode = posCode || 'ILLEGAL_TRANSITION';
  }
}

function createPosClient(options = {}) {
  const baseUrl = (options.baseUrl || process.env.POS_BASE_URL || 'http://pos:8080').replace(
    /\/+$/,
    ''
  );
  const token = options.token || process.env.PAYMENTS_SERVICE_TOKEN || 'dev-payments-token';
  const fetchImpl = options.fetch || globalThis.fetch;
  const timeoutMs = options.timeoutMs || Number(process.env.POS_TIMEOUT_MS || 3000);

  async function call(method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          'x-payments-token': token,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      throw new PosUnavailableError(`pos unreachable: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 404) return null;

    if (res.ok) return res.json();

    const payload = await res.json().catch(() => ({}));

    if (res.status === 409) {
      throw new PosConflictError(
        `pos ${method} ${path} → 409 ${payload.error || ''} ${payload.message || ''}`.trim(),
        payload.error
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new PosError(`pos ${method} ${path} → ${res.status}`, res.status, 'POS_UNAUTHORIZED');
    }
    if (res.status >= 500) {
      throw new PosUnavailableError(`pos ${method} ${path} → ${res.status}`, res.status);
    }
    throw new PosError(`pos ${method} ${path} → ${res.status}`, res.status, 'POS_ERROR');
  }

  return {
    getSale: (saleId) => call('GET', `/internal/v1/sales/${saleId}`),

    markAwaitingPayment: (saleId, paymentId) =>
      call('POST', `/internal/v1/sales/${saleId}/awaiting-payment`, { payment_id: paymentId }),

    markPaid: (saleId, paymentId, paidAt) =>
      call('POST', `/internal/v1/sales/${saleId}/paid`, {
        payment_id: paymentId,
        paid_at: (paidAt instanceof Date ? paidAt : new Date(paidAt)).toISOString(),
      }),
  };
}

module.exports = { createPosClient, PosError, PosUnavailableError, PosConflictError };
