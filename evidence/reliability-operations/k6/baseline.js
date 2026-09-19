import http from 'k6/http';
import { check, sleep } from 'k6';
import { baseUrl, thresholds } from './thresholds.js';

/**
 * Baseline — expected G3/G5 demo load.
 * 10 VUs for 5 minutes. Well under the ~50 RPS the db.t4g.micro is
 * sized for (ADR-003), and never through WAF.
 */
export const options = {
  vus: 10,
  duration: '5m',
  thresholds,
};

const BASE = baseUrl();

export default function baseline() {
  const health = http.get(`${BASE}/health`);
  check(health, {
    'health 200': (r) => r.status === 200,
  });

  const ready = http.get(`${BASE}/ready`);
  check(ready, {
    'ready not 5xx': (r) => r.status < 500,
  });

  const version = http.get(`${BASE}/version`);
  check(version, {
    'version 200': (r) => r.status === 200,
  });

  sleep(0.5);
}
