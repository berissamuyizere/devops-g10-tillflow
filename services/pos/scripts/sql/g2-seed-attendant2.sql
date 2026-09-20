-- G2 demo attendant for Commission close evidence.
-- Parameterised: pass -v attendant_id/-v tenant_id/etc from the runner.
-- Idempotent: safe to re-run. Does not touch attendant 2222… or ledger rows.
-- Run via services/pos/scripts/g2-seed-attendant2.sh (ECS + RDS master).

INSERT INTO pos.users (id, email)
VALUES (:'attendant_id', :'attendant_email')
ON CONFLICT (id) DO NOTHING;

INSERT INTO pos.memberships (tenant_id, user_id, role)
VALUES (
  :'tenant_id',
  :'attendant_id',
  'attendant'
)
ON CONFLICT (tenant_id, user_id) DO NOTHING;

INSERT INTO pos.attendants (id, tenant_id, display_name, payout_msisdn, commission_bps, status)
VALUES (
  :'attendant_id',
  :'tenant_id',
  :'display_name',
  :'payout_msisdn',
  :'commission_bps',
  'active'
)
ON CONFLICT (id) DO NOTHING;
