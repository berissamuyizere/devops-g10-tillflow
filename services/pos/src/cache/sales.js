const Redis = require('ioredis');

const KEY_PREFIX = 'pos:sale:v1:';
const DEFAULT_TTL_SECONDS = 300;

function saleKey(tenantId, saleId) {
  return `${KEY_PREFIX}${tenantId}:${saleId}`;
}

function createNoopSaleCache() {
  return {
    enabled: false,
    async get() {
      return { status: 'miss' };
    },
    async set() {},
    async invalidate() {},
    async close() {},
  };
}

function createSaleCache(options = {}) {
  const host = (options.host || process.env.CACHE_HOST || '').trim();
  if (!host) {
    return createNoopSaleCache();
  }

  const port = Number(options.port || process.env.CACHE_PORT || 6379);
  const password = (options.password || process.env.CACHE_AUTH_TOKEN || '').trim();
  const ttlSeconds = Number(options.ttlSeconds || process.env.CACHE_TTL_SECONDS || DEFAULT_TTL_SECONDS);
  const logger = options.logger;

  const client = new Redis({
    host,
    port,
    password: password || undefined,
    tls: {},
    lazyConnect: true,
    connectTimeout: Number(process.env.CACHE_CONNECT_TIMEOUT_MS || 2000),
    commandTimeout: Number(process.env.CACHE_COMMAND_TIMEOUT_MS || 1000),
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });

  client.on('error', (err) => {
    logger?.warn?.({ err: String(err.message || err) }, 'cache_client_error');
  });

  async function get(tenantId, saleId) {
    try {
      const raw = await client.get(saleKey(tenantId, saleId));
      if (!raw) {
        return { status: 'miss' };
      }
      return { status: 'hit', value: JSON.parse(raw) };
    } catch (err) {
      logger?.warn?.({ err: String(err.message || err) }, 'cache_get_failed');
      return { status: 'error' };
    }
  }

  async function set(tenantId, saleId, sale) {
    try {
      await client.set(saleKey(tenantId, saleId), JSON.stringify(sale), 'EX', ttlSeconds);
    } catch (err) {
      logger?.warn?.({ err: String(err.message || err) }, 'cache_set_failed');
    }
  }

  async function invalidate(tenantId, saleId) {
    try {
      await client.del(saleKey(tenantId, saleId));
    } catch (err) {
      logger?.warn?.({ err: String(err.message || err) }, 'cache_invalidate_failed');
    }
  }

  async function close() {
    try {
      await client.quit();
    } catch {
      client.disconnect();
    }
  }

  return {
    enabled: true,
    get,
    set,
    invalidate,
    close,
  };
}

module.exports = {
  createSaleCache,
  createNoopSaleCache,
  saleKey,
  KEY_PREFIX,
};
