/**
 * POS schema per docs/adr-001-tenant-sale-data-model.md
 * Money is integer KES minor units. paid_at is timestamptz.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createSchema('pos', { ifNotExists: true });

  pgm.createTable(
    { schema: 'pos', name: 'tenants' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      name: { type: 'text', notNull: true },
      status: { type: 'text', notNull: true },
      mpesa_till: { type: 'text', notNull: true },
      default_commission_bps: { type: 'integer', notNull: true },
      timezone: { type: 'text', notNull: true, default: "'Africa/Nairobi'" },
      created_at: {
        type: 'timestamptz',
        notNull: true,
        default: pgm.func('now()'),
      },
    }
  );
  pgm.addConstraint(
    { schema: 'pos', name: 'tenants' },
    'tenants_status_check',
    "CHECK (status IN ('active', 'suspended'))"
  );
  pgm.addConstraint(
    { schema: 'pos', name: 'tenants' },
    'tenants_commission_bps_check',
    'CHECK (default_commission_bps BETWEEN 0 AND 10000)'
  );

  pgm.createTable(
    { schema: 'pos', name: 'users' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      email: { type: 'text', notNull: true, unique: true },
      created_at: {
        type: 'timestamptz',
        notNull: true,
        default: pgm.func('now()'),
      },
    }
  );

  pgm.createTable(
    { schema: 'pos', name: 'memberships' },
    {
      tenant_id: {
        type: 'uuid',
        notNull: true,
        references: '"pos"."tenants"',
        onDelete: 'CASCADE',
      },
      user_id: {
        type: 'uuid',
        notNull: true,
        references: '"pos"."users"',
        onDelete: 'CASCADE',
      },
      role: { type: 'text', notNull: true },
    }
  );
  pgm.addConstraint(
    { schema: 'pos', name: 'memberships' },
    'memberships_pkey',
    'PRIMARY KEY (tenant_id, user_id)'
  );
  pgm.addConstraint(
    { schema: 'pos', name: 'memberships' },
    'memberships_role_check',
    "CHECK (role IN ('owner', 'attendant'))"
  );

  pgm.createTable(
    { schema: 'pos', name: 'attendants' },
    {
      id: {
        type: 'uuid',
        primaryKey: true,
        references: '"pos"."users"',
        onDelete: 'CASCADE',
      },
      tenant_id: {
        type: 'uuid',
        notNull: true,
        references: '"pos"."tenants"',
        onDelete: 'CASCADE',
      },
      display_name: { type: 'text', notNull: true },
      payout_msisdn: { type: 'text', notNull: true },
      commission_bps: { type: 'integer', notNull: true },
      status: { type: 'text', notNull: true },
    }
  );
  pgm.addConstraint(
    { schema: 'pos', name: 'attendants' },
    'attendants_status_check',
    "CHECK (status IN ('active', 'inactive'))"
  );
  pgm.addConstraint(
    { schema: 'pos', name: 'attendants' },
    'attendants_commission_bps_check',
    'CHECK (commission_bps BETWEEN 0 AND 10000)'
  );
  pgm.addConstraint(
    { schema: 'pos', name: 'attendants' },
    'attendants_tenant_id_unique',
    'UNIQUE (tenant_id, id)'
  );

  pgm.createTable(
    { schema: 'pos', name: 'sales' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      tenant_id: {
        type: 'uuid',
        notNull: true,
        references: '"pos"."tenants"',
        onDelete: 'RESTRICT',
      },
      attendant_id: { type: 'uuid', notNull: true },
      idempotency_key: { type: 'text', notNull: true },
      status: { type: 'text', notNull: true },
      currency: { type: 'char(3)', notNull: true, default: "'KES'" },
      total_minor: { type: 'integer', notNull: true },
      request_hash: { type: 'text', notNull: true },
      created_at: {
        type: 'timestamptz',
        notNull: true,
        default: pgm.func('now()'),
      },
      paid_at: { type: 'timestamptz' },
    }
  );
  pgm.addConstraint(
    { schema: 'pos', name: 'sales' },
    'sales_status_check',
    "CHECK (status IN ('created', 'awaiting_payment', 'paid', 'cancelled'))"
  );
  pgm.addConstraint(
    { schema: 'pos', name: 'sales' },
    'sales_total_minor_check',
    'CHECK (total_minor >= 0)'
  );
  pgm.addConstraint(
    { schema: 'pos', name: 'sales' },
    'sales_tenant_idempotency_unique',
    'UNIQUE (tenant_id, idempotency_key)'
  );
  pgm.addConstraint(
    { schema: 'pos', name: 'sales' },
    'sales_attendant_fk',
    'FOREIGN KEY (tenant_id, attendant_id) REFERENCES pos.attendants (tenant_id, id)'
  );

  pgm.createTable(
    { schema: 'pos', name: 'sale_lines' },
    {
      id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
      sale_id: {
        type: 'uuid',
        notNull: true,
        references: '"pos"."sales"',
        onDelete: 'CASCADE',
      },
      description: { type: 'text', notNull: true },
      quantity: { type: 'integer', notNull: true },
      unit_price_minor: { type: 'integer', notNull: true },
      line_total_minor: { type: 'integer', notNull: true },
    }
  );
  pgm.addConstraint(
    { schema: 'pos', name: 'sale_lines' },
    'sale_lines_quantity_check',
    'CHECK (quantity >= 1)'
  );
  pgm.addConstraint(
    { schema: 'pos', name: 'sale_lines' },
    'sale_lines_unit_price_check',
    'CHECK (unit_price_minor >= 0)'
  );
  pgm.addConstraint(
    { schema: 'pos', name: 'sale_lines' },
    'sale_lines_line_total_check',
    'CHECK (line_total_minor >= 0)'
  );
};

exports.down = (pgm) => {
  pgm.dropTable({ schema: 'pos', name: 'sale_lines' }, { ifExists: true, cascade: true });
  pgm.dropTable({ schema: 'pos', name: 'sales' }, { ifExists: true, cascade: true });
  pgm.dropTable({ schema: 'pos', name: 'attendants' }, { ifExists: true, cascade: true });
  pgm.dropTable({ schema: 'pos', name: 'memberships' }, { ifExists: true, cascade: true });
  pgm.dropTable({ schema: 'pos', name: 'users' }, { ifExists: true, cascade: true });
  pgm.dropTable({ schema: 'pos', name: 'tenants' }, { ifExists: true, cascade: true });
  pgm.dropSchema('pos', { ifExists: true, cascade: true });
};
