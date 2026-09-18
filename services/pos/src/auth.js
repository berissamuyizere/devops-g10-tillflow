/**
 * Auth for the POS scaffold.
 *
 * G2 will replace header identity with real JWT/session. Until then:
 * - Attendant/owner: X-Tenant-Id, X-User-Id, X-Role
 * - Payments service: X-Payments-Token === PAYMENTS_SERVICE_TOKEN
 *
 * PAYMENTS_SERVICE_TOKEN has no in-process default. Missing config fails
 * closed (500). Wrong/missing header is 401. Tests and CI must set the env
 * (helpers.js, docker-compose, pr.yml).
 */

function requireMembership(req, res, next) {
  const tenantId = req.header('x-tenant-id');
  const userId = req.header('x-user-id');
  const role = req.header('x-role');

  if (!tenantId || !userId || !role) {
    return res.status(401).json({
      error: 'unauthorized',
      hint: 'X-Tenant-Id, X-User-Id, and X-Role are required',
    });
  }
  if (role !== 'owner' && role !== 'attendant') {
    return res.status(401).json({ error: 'unauthorized', hint: 'invalid role' });
  }

  req.actor = { tenantId, userId, role };
  return next();
}

function expectedPaymentsToken() {
  const token = process.env.PAYMENTS_SERVICE_TOKEN;
  if (typeof token !== 'string') {
    return null;
  }
  const trimmed = token.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function requirePaymentsService(req, res, next) {
  const expected = expectedPaymentsToken();
  if (!expected) {
    return res.status(500).json({
      error: 'misconfigured',
      hint: 'PAYMENTS_SERVICE_TOKEN is not set',
    });
  }
  const token = req.header('x-payments-token');
  if (!token || token !== expected) {
    return res.status(401).json({ error: 'unauthorized', hint: 'Payments service token required' });
  }
  req.actor = { type: 'payments' };
  return next();
}

module.exports = {
  requireMembership,
  requirePaymentsService,
  expectedPaymentsToken,
};
