const crypto = require('crypto');

function constantTimeEquals(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function tokenGuard({ header, envVar, devDefault, actorType }) {
  return function guard(req, res, next) {
    const expected = process.env[envVar] || devDefault;
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
  devDefault: 'dev-pos-token',
  actorType: 'pos',
});

const requireCommissionService = tokenGuard({
  header: 'x-commission-token',
  envVar: 'COMMISSION_SERVICE_TOKEN',
  devDefault: 'dev-commission-token',
  actorType: 'commission',
});

module.exports = {
  requirePosService,
  requireCommissionService,
  constantTimeEquals,
};
