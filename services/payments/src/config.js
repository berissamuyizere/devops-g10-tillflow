// Database connection resolution for Payments (mirrors services/pos/src/config.js).
//
//   1. DATABASE_URL  — local docker compose, CI, and tests.
//   2. DB_SECRET_ID  — AWS Secrets Manager JSON secret on ECS (ADR-003).

const DEFAULT_SCHEMA = process.env.DB_SCHEMA || 'payments';
const DEFAULT_REGION = process.env.AWS_REGION || 'eu-central-1';

function buildUrlFromParts(secret) {
  const user = secret.username || secret.user;
  const password = secret.password;
  const host = secret.host;
  const port = secret.port || 5432;
  const database = secret.dbname || secret.database || secret.db;

  const missing = ['user', 'password', 'host', 'database'].filter((k) => {
    const v = { user, password, host, database }[k];
    return v === undefined || v === null || v === '';
  });
  if (missing.length > 0) {
    throw new Error(`DB secret missing fields: ${missing.join(', ')}`);
  }

  const auth = `${encodeURIComponent(user)}:${encodeURIComponent(password)}`;
  return `postgresql://${auth}@${host}:${port}/${database}`;
}

async function fetchSecret(secretId, region) {
  const {
    SecretsManagerClient,
    GetSecretValueCommand,
  } = require('@aws-sdk/client-secrets-manager');

  const client = new SecretsManagerClient({ region });
  const out = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!out.SecretString) {
    throw new Error(`DB secret ${secretId} has no SecretString`);
  }
  return JSON.parse(out.SecretString);
}

function sslFor(source, secret) {
  if (source === 'DATABASE_URL') {
    return undefined;
  }
  const optOut = secret.ssl === false || process.env.DB_SSL === 'false';
  return optOut ? undefined : { rejectUnauthorized: false };
}

async function resolveDbConfig() {
  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
      schema: DEFAULT_SCHEMA,
      ssl: undefined,
      source: 'DATABASE_URL',
    };
  }

  const secretId = process.env.DB_SECRET_ID;
  if (!secretId) {
    throw new Error(
      'No database config: set DATABASE_URL (local/CI) or DB_SECRET_ID (Secrets Manager)'
    );
  }

  const secret = await fetchSecret(secretId, DEFAULT_REGION);
  const connectionString =
    secret.url || secret.DATABASE_URL || buildUrlFromParts(secret);

  return {
    connectionString,
    schema: secret.schema || DEFAULT_SCHEMA,
    ssl: sslFor(`secret:${secretId}`, secret),
    source: `secret:${secretId}`,
  };
}

module.exports = {
  resolveDbConfig,
  buildUrlFromParts,
  DEFAULT_SCHEMA,
};
