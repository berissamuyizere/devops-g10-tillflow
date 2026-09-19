const interfaceSpec = require('./interface');
const {
  createFakeMpesaClient,
  OUTCOMES,
  B2C_OUTCOMES,
  B2C_RESULT_CODES,
  TEST_MSISDNS,
  outcomeFor,
  b2cOutcomeFor,
} = require('./fake');
const signature = require('./signature');
const { createDarajaClient } = require('./daraja');

const MODES = Object.freeze({ FAKE: 'fake', DARAJA: 'daraja' });

function createMpesaClient(options = {}) {
  const mode = options.mode || process.env.MPESA_MODE || MODES.FAKE;

  if (mode === MODES.FAKE) {
    return createFakeMpesaClient(options);
  }

  if (mode === MODES.DARAJA) {
    return createDarajaClient({
      environment: options.environment || process.env.DARAJA_ENVIRONMENT || 'sandbox',
      consumerKey: options.consumerKey || process.env.DARAJA_CONSUMER_KEY,
      consumerSecret: options.consumerSecret || process.env.DARAJA_CONSUMER_SECRET,
      shortcode: options.shortcode || process.env.DARAJA_SHORTCODE,
      passkey: options.passkey || process.env.DARAJA_PASSKEY,
      initiatorName: options.initiatorName || process.env.DARAJA_INITIATOR_NAME,
      securityCredential: options.securityCredential || process.env.DARAJA_SECURITY_CREDENTIAL,
      resultUrl: options.resultUrl || process.env.DARAJA_B2C_RESULT_URL,
      queueTimeoutUrl: options.queueTimeoutUrl || process.env.DARAJA_B2C_TIMEOUT_URL,
      ...options,
    });
  }

  throw new interfaceSpec.MpesaError(`unknown MPESA_MODE: ${mode}`, 'MPESA_MODE_INVALID');
}

module.exports = {
  createMpesaClient,
  createFakeMpesaClient,
  createDarajaClient,
  MODES,
  OUTCOMES,
  B2C_OUTCOMES,
  B2C_RESULT_CODES,
  TEST_MSISDNS,
  outcomeFor,
  b2cOutcomeFor,
  signature,
  ...interfaceSpec,
};
