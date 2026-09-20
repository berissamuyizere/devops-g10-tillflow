const { URL } = require('url');
const synthetics = require('@aws/synthetics-puppeteer');
const log = require('@aws/synthetics-logger');

const PATHS = ['/health', '/'];

const validate = async function (res) {
  const code = res.statusCode;
  if (code < 200 || code >= 400) {
    throw new Error(`status ${code}`);
  }
};

const apiCheck = async function () {
  const base = (process.env.API_URL || '').replace(/\/$/, '');
  if (!base) {
    throw new Error('API_URL is not set');
  }

  for (const path of PATHS) {
    const url = new URL(base + path);
    const requestOptions = {
      hostname: url.hostname,
      method: 'GET',
      path: `${url.pathname}${url.search}`,
      port: url.port || 443,
      protocol: url.protocol,
      headers: {
        'User-Agent': 'devops-g10-probe',
      },
    };
    log.info(`GET ${url.toString()}`);
    await synthetics.executeHttpStep(`GET ${path}`, requestOptions, validate);
  }
};

exports.handler = async () => {
  return await apiCheck();
};
