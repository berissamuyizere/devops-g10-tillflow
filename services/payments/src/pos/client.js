class PosError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = 'PosError';
    this.status = status;
    this.code = code || 'POS_ERROR';
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
      throw new PosError(`pos unreachable: ${err.message}`, 503, 'POS_UNREACHABLE');
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new PosError(`pos ${method} ${path} → ${res.status} ${text}`, res.status, 'POS_ERROR');
    }
    return res.json();
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

module.exports = { createPosClient, PosError };
