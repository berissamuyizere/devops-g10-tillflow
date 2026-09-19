-- Read back attendant 3333… after seed (stdout marker parsed by g2-seed-attendant2.sh).
\pset tuples_only on
\pset format unaligned
\echo '__SEED_EVIDENCE__'
SELECT json_build_object(
  'tenant', (
    SELECT json_build_object(
      'id', t.id,
      'name', t.name,
      'status', t.status,
      'mpesa_till', t.mpesa_till,
      'default_commission_bps', t.default_commission_bps
    )
    FROM pos.tenants t
    WHERE t.id = '11111111-1111-1111-1111-111111111111'
  ),
  'user', (
    SELECT json_build_object('id', u.id, 'email', u.email)
    FROM pos.users u
    WHERE u.id = '33333333-3333-3333-3333-333333333333'
  ),
  'membership', (
    SELECT json_build_object('tenant_id', m.tenant_id, 'user_id', m.user_id, 'role', m.role)
    FROM pos.memberships m
    WHERE m.tenant_id = '11111111-1111-1111-1111-111111111111'
      AND m.user_id = '33333333-3333-3333-3333-333333333333'
  ),
  'attendant', (
    SELECT json_build_object(
      'id', a.id,
      'tenant_id', a.tenant_id,
      'display_name', a.display_name,
      'payout_msisdn', a.payout_msisdn,
      'commission_bps', a.commission_bps,
      'status', a.status
    )
    FROM pos.attendants a
    WHERE a.id = '33333333-3333-3333-3333-333333333333'
  )
)::text;
\echo '__SEED_EVIDENCE_END__'
