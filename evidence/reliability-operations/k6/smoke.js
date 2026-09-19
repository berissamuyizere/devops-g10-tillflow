import http from 'k6/http';
import { check, sleep } from 'k6';
import { baseUrl, thresholds } from './thresholds.js';

/**
 * Smoke — is the path up at all?
 * 1 VU, ~30s, a handful of /health + /version probes.
 */
export const options = {
  vus: 1,
  duration: '30s',
  thresholds,
};

const BASE = baseUrl();

export default function smoke() {
  const health = http.get(`${BASE}/health`);
  check(health, {
    'health status 200': (r) => r.status === 200,
    'health body ok': (r) => {
      try {
        return JSON.parse(r.body).status === 'ok';
      } catch {
        return false;
      }
    },
  });

  const version = http.get(`${BASE}/version`);
  check(version, {
    'version status 200': (r) => r.status === 200,
    'version has commit': (r) => {
      try {
        const body = JSON.parse(r.body);
        return typeof body.commit === 'string' && body.commit.length > 0;
      } catch {
        return false;
      }
    },
  });

  sleep(1);
}
