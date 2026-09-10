const crypto = require('crypto');

/**
 * Stable hash of the create-sale body for idempotency comparison.
 * Same semantic body → same hash; field reorder in lines is normalized.
 */
function hashSaleRequest(body) {
  const lines = Array.isArray(body.lines)
    ? body.lines.map((line) => ({
        description: String(line.description ?? ''),
        quantity: Number(line.quantity),
        unit_price_minor: Number(line.unit_price_minor),
      }))
    : [];

  const normalized = {
    lines,
    total_minor:
      body.total_minor === undefined || body.total_minor === null
        ? null
        : Number(body.total_minor),
  };

  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

module.exports = { hashSaleRequest };
