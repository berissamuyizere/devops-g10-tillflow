const { randomUUID } = require('crypto');
const request = require('supertest');
const { createApp } = require('../../src/app');
const db = require('../../src/db');

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://pos:pos@127.0.0.1:5433/tillflow_pos';

process.env.DATABASE_URL = DATABASE_URL;
process.env.PAYMENTS_SERVICE_TOKEN = 'dev-payments-token';

async function resetData() {
  await db.query('TRUNCATE pos.sale_lines, pos.sales, pos.attendants, pos.memberships, pos.users, pos.tenants CASCADE');
}

async function seedTenantPair() {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const attendantA = randomUUID();
  const attendantB = randomUUID();
  const ownerA = randomUUID();

  await db.query(
    `INSERT INTO pos.tenants (id, name, status, mpesa_till, default_commission_bps)
     VALUES ($1, 'Shop A', 'active', '174379', 500),
            ($2, 'Shop B', 'active', '174380', 500)`,
    [tenantA, tenantB]
  );
  await db.query(
    `INSERT INTO pos.users (id, email)
     VALUES ($1, $2), ($3, $4), ($5, $6)`,
    [
      attendantA,
      `a-${attendantA}@example.com`,
      attendantB,
      `b-${attendantB}@example.com`,
      ownerA,
      `o-${ownerA}@example.com`,
    ]
  );
  await db.query(
    `INSERT INTO pos.memberships (tenant_id, user_id, role)
     VALUES ($1, $2, 'attendant'), ($3, $4, 'attendant'), ($1, $5, 'owner')`,
    [tenantA, attendantA, tenantB, attendantB, ownerA]
  );
  await db.query(
    `INSERT INTO pos.attendants (id, tenant_id, display_name, payout_msisdn, commission_bps, status)
     VALUES ($1, $2, 'Ada', '254700000001', 500, 'active'),
            ($3, $4, 'Bea', '254700000002', 500, 'active')`,
    [attendantA, tenantA, attendantB, tenantB]
  );

  return { tenantA, tenantB, attendantA, attendantB, ownerA };
}

function attendantHeaders(tenantId, userId) {
  return {
    'x-tenant-id': tenantId,
    'x-user-id': userId,
    'x-role': 'attendant',
  };
}

function paymentsHeaders() {
  return { 'x-payments-token': 'dev-payments-token' };
}

function saleBody(overrides = {}) {
  return {
    lines: [
      {
        description: 'Chai',
        quantity: 2,
        unit_price_minor: 7500,
      },
    ],
    ...overrides,
  };
}

function createTestApp() {
  return createApp({
    logger: require('pino')({ level: 'silent' }),
  });
}

module.exports = {
  db,
  request,
  resetData,
  seedTenantPair,
  attendantHeaders,
  paymentsHeaders,
  saleBody,
  createTestApp,
  DATABASE_URL,
};
