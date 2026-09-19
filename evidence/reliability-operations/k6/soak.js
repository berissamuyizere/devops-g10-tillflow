import http from 'k6/http';
import { check, sleep } from 'k6';
import { baseUrl, thresholds } from './thresholds.js';

/**
 * Soak — baseline hold for 15 minutes.
 * Looks for memory/connection leaks on the golden-path tasks and
 * for RDS CPU creeping toward the 70% alarm. Capstone window is
 * short; 15m is enough to see a leak without burning the RDS
 * budget. Extend to 30m at G3 if the first run is clean.
 */
export const options = {
  vus: 10,
  duration: '15m',
  thresholds,
};

const BASE = baseUrl();

export default function soak() {
  const health = http.get(`${BASE}/health`);
  check(health, {
    'health 200': (r) => r.status === 200,
  });

  const ready = http.get(`${BASE}/ready`);
  check(ready, {
    'ready not 5xx': (r) => r.status < 500,
  });

  sleep(0.5);
}
