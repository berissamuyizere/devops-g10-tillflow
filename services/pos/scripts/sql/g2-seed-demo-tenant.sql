-- G5 demo tenant (Demo Café). Idempotent. Run before g2-seed-attendant2 for 2222…
INSERT INTO pos.tenants (id, name, status, mpesa_till, default_commission_bps)
VALUES (
  :'tenant_id',
  'Demo Café',
  'active',
  '174379',
  500
)
ON CONFLICT (id) DO NOTHING;
