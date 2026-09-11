const crypto = require('crypto');

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function hashChargeRequest({ saleId, amountMinor, msisdn, shortcode }) {
  return sha256(
    JSON.stringify({
      sale_id: String(saleId),
      amount_minor: Number(amountMinor),
      msisdn: String(msisdn),
      shortcode: String(shortcode),
    })
  );
}

function hashPayoutRequest({ tenantId, agentId, period, amountMinor, msisdn }) {
  return sha256(
    JSON.stringify({
      tenant_id: String(tenantId),
      agent_id: String(agentId),
      period: String(period),
      amount_minor: Number(amountMinor),
      msisdn: String(msisdn),
    })
  );
}

function hashCallback(body) {
  const stk = body?.Body?.stkCallback || {};
  const items = stk.CallbackMetadata?.Item;
  const metadata = Array.isArray(items)
    ? items
        .map((item) => [String(item?.Name ?? ''), item?.Value ?? null])
        .sort((a, b) => a[0].localeCompare(b[0]))
    : [];

  return sha256(
    JSON.stringify({
      merchant_request_id: stk.MerchantRequestID ?? null,
      checkout_request_id: stk.CheckoutRequestID ?? null,
      result_code: stk.ResultCode ?? null,
      result_desc: stk.ResultDesc ?? null,
      metadata,
    })
  );
}

module.exports = { sha256, hashChargeRequest, hashPayoutRequest, hashCallback };
