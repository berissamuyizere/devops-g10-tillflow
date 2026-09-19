/**
 * Shared k6 thresholds for TillFlow load tests.
 *
 * Envelope (G3 starter, same rule as docs/slo-error-budgets.md —
 * change only with a written rationale):
 *   http_req_failed              < 1%
 *   http_req_duration p(95)      < 500ms
 *   checks                       > 99%
 *
 * `/health` and `/ready` are excluded from SLI numerators (ADR-004)
 * but they are what these scripts hit until G2 puts POS/Payments on
 * the ALB. Do not add STK /sale traffic here — k6 uses MPESA_MODE=fake
 * only, and soak/spike must not become a Daraja sandbox flood.
 *
 * Target the INTERNAL ALB DNS (terraform output -raw alb_dns_name)
 * from inside the VPC. API Gateway WAF is 200 req / 5 min / IP.
 */
export const thresholds = {
  http_req_failed: ['rate<0.01'],
  http_req_duration: ['p(95)<500'],
  checks: ['rate>0.99'],
};

export function baseUrl() {
  const raw = __ENV.BASE_URL;
  if (!raw) {
    throw new Error(
      'BASE_URL is required. Use the internal ALB DNS, not API Gateway. Example: BASE_URL=http://internal-devops-g10-alb-….elb.eu-central-1.amazonaws.com'
    );
  }
  return String(raw).replace(/\/$/, '');
}
