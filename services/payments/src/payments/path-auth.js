const crypto = require('crypto');

const REASONS = Object.freeze({
  OK: 'secret_path',
  NOT_CONFIGURED: 'path_secret_not_configured',
  WRONG_SECRET: 'path_secret_mismatch',
  IP_NOT_ALLOWED: 'source_ip_not_allowed',
});

function fixedLengthEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a), 'utf8').digest();
  const hb = crypto.createHash('sha256').update(String(b), 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

function parseAllowlist(raw) {
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function ipv4ToInt(ip) {
  const parts = String(ip).split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function normaliseIp(ip) {
  const value = String(ip || '').trim();
  if (value.startsWith('::ffff:')) return value.slice(7);
  return value;
}

function ipMatches(ip, entry) {
  const candidate = ipv4ToInt(normaliseIp(ip));
  if (candidate === null) return false;

  if (!entry.includes('/')) {
    const exact = ipv4ToInt(entry);
    return exact !== null && exact === candidate;
  }

  const [network, bitsRaw] = entry.split('/');
  const bits = Number(bitsRaw);
  const base = ipv4ToInt(network);
  if (base === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (base & mask) >>> 0 === (candidate & mask) >>> 0;
}

function sourceIp(req) {
  const forwarded = req?.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim().length > 0) {
    return normaliseIp(forwarded.split(',')[0]);
  }
  return normaliseIp(req?.socket?.remoteAddress);
}

function verifyPath({ presented, configured, ip, allowlist }) {
  if (typeof configured !== 'string' || configured.trim().length === 0) {
    return { valid: false, reason: REASONS.NOT_CONFIGURED, configured: false };
  }
  if (typeof presented !== 'string' || presented.length === 0) {
    return { valid: false, reason: REASONS.WRONG_SECRET, configured: true };
  }
  if (!fixedLengthEqual(presented, configured.trim())) {
    return { valid: false, reason: REASONS.WRONG_SECRET, configured: true };
  }

  const entries = Array.isArray(allowlist) ? allowlist : parseAllowlist(allowlist);
  if (entries.length > 0 && !entries.some((entry) => ipMatches(ip, entry))) {
    return { valid: false, reason: REASONS.IP_NOT_ALLOWED, configured: true };
  }

  return { valid: true, reason: REASONS.OK, configured: true };
}

module.exports = { REASONS, verifyPath, parseAllowlist, ipMatches, sourceIp };
