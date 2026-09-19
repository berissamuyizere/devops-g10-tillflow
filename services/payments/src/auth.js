const crypto = require('crypto');

function constantTimeEquals(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function configuredToken(envVar) {
  const value = process.env[envVar];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function tokenGuard({ header, envVar, actorType }) {
  return function guard(req, res, next) {
    const expected = configuredToken(envVar);
    if (!expected) {
      req.log?.error({ actor: actorType, env: envVar }, 'service_token_not_configured');
      return res.status(500).json({
        error: 'misconfigured',
        hint: `${envVar} is not set`,
      });
    }
    const presented = req.header(header);
    if (!presented || !constantTimeEquals(presented, expected)) {
      req.log?.warn({ actor: actorType }, 'service_token_rejected');
      return res.status(401).json({
        error: 'unauthorized',
        hint: `${header} required`,
      });
    }
    req.actor = { type: actorType };
    return next();
  };
}

const requirePosService = tokenGuard({
  header: 'x-pos-token',
  envVar: 'POS_SERVICE_TOKEN',
  actorType: 'pos',
});

const requireCommissionService = tokenGuard({
  header: 'x-commission-token',
  envVar: 'COMMISSION_SERVICE_TOKEN',
  actorType: 'commission',
});

module.exports = {
  requirePosService,
  requireCommissionService,
  constantTimeEquals,
  configuredToken,
};
