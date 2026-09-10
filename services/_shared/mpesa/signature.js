const crypto = require('crypto');

const SIGNATURE_HEADER = 'x-tillflow-signature';
const SCHEME = 'v1';
const DEFAULT_TOLERANCE_SECONDS = 300;

function signedPayload(timestamp, rawBody) {
  return `${timestamp}.${rawBody}`;
}

function sign(rawBody, secret, timestampSeconds) {
  const t = Math.floor(timestampSeconds);
  const mac = crypto
    .createHmac('sha256', secret)
    .update(signedPayload(t, rawBody), 'utf8')
    .digest('hex');
  return `t=${t},${SCHEME}=${mac}`;
}

function parseHeader(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const parts = {};
  for (const segment of value.split(',')) {
    const idx = segment.indexOf('=');
    if (idx === -1) continue;
    parts[segment.slice(0, idx).trim()] = segment.slice(idx + 1).trim();
  }
  if (!parts.t || !parts[SCHEME]) return null;
  const t = Number(parts.t);
  if (!Number.isInteger(t)) return null;
  return { timestamp: t, mac: parts[SCHEME] };
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function verify(rawBody, headerValue, secret, options = {}) {
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((options.now ? options.now() : Date.now()) / 1000);

  if (!secret) return { valid: false, reason: 'signing_secret_missing' };
  if (typeof rawBody !== 'string') return { valid: false, reason: 'raw_body_missing' };

  const parsed = parseHeader(headerValue);
  if (!parsed) return { valid: false, reason: 'signature_header_malformed' };

  const expected = crypto
    .createHmac('sha256', secret)
    .update(signedPayload(parsed.timestamp, rawBody), 'utf8')
    .digest('hex');

  if (!timingSafeEqualHex(parsed.mac, expected)) {
    return { valid: false, reason: 'signature_mismatch' };
  }
  if (Math.abs(nowSeconds - parsed.timestamp) > tolerance) {
    return { valid: false, reason: 'signature_timestamp_outside_tolerance' };
  }
  return { valid: true, reason: null };
}

module.exports = {
  SIGNATURE_HEADER,
  SCHEME,
  DEFAULT_TOLERANCE_SECONDS,
  sign,
  verify,
  parseHeader,
};
