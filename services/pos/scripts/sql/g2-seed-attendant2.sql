-- G2 demo attendant #2 for Commission close evidence (Arsema).
-- Idempotent: safe to re-run. Does not touch attendant 2222… or ledger rows.
-- Run via services/pos/scripts/g2-seed-attendant2.sh (ECS + RDS master).

INSERT INTO pos.users (id, email)
VALUES ('33333333-3333-3333-3333-333333333333', 'demo2@tillflow.dev')
ON CONFLICT (id) DO NOTHING;

INSERT INTO pos.memberships (tenant_id, user_id, role)
VALUES (
  '11111111-1111-1111-1111-111111111111',
  '33333333-3333-3333-3333-333333333333',
  'attendant'
)
ON CONFLICT (tenant_id, user_id) DO NOTHING;

INSERT INTO pos.attendants (id, tenant_id, display_name, payout_msisdn, commission_bps, status)
VALUES (
  '33333333-3333-3333-3333-333333333333',
  '11111111-1111-1111-1111-111111111111',
  'Demo Attendant 2',
  '254700000000',
  500,
  'active'
)
ON CONFLICT (id) DO NOTHING;
