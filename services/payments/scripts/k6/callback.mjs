import crypto from 'k6/crypto';
import {
  SIGNATURE_HEADER,
  signedPayload,
  signatureHeader,
  buildStkCallback,
} from './callback-core.mjs';

export { buildStkCallback, SIGNATURE_HEADER };

export function signCallback(body, secret, nowMs) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const t = Math.floor((nowMs === undefined ? Date.now() : nowMs) / 1000);
  const mac = crypto.hmac('sha256', secret, signedPayload(t, raw), 'hex');
  return {
    raw,
    headers: {
      'Content-Type': 'application/json',
      [SIGNATURE_HEADER]: signatureHeader(t, mac),
    },
  };
}

export function signedStkCallback(opts, secret, nowMs) {
  return signCallback(buildStkCallback(opts), secret, nowMs);
}
