import http from 'k6/http';
import { check, sleep } from 'k6';
import { baseUrl, thresholds } from './thresholds.js';

/**
 * Spike — sudden 5× jump, then back.
 * Proves ALB + ECS (desiredCount 2) absorb a burst without a 5xx
 * storm. Still no STK, still internal ALB only.
 *
 * Thresholds stay the shared envelope: if the spike burns >1%
 * failed or p95 > 500ms, the scenario fails and we write a rationale
 * before loosening — we do not silently raise the bar.
 */
export const options = {
  stages: [
    { duration: '30s', target: 10 },
    { duration: '1m', target: 50 },
    { duration: '1m', target: 10 },
    { duration: '30s', target: 0 },
  ],
  thresholds,
};

const BASE = baseUrl();

export default function spike() {
  const health = http.get(`${BASE}/health`);
  check(health, {
    'health 200': (r) => r.status === 200,
  });

  const version = http.get(`${BASE}/version`);
  check(version, {
    'version 200': (r) => r.status === 200,
  });

  sleep(0.2);
}
