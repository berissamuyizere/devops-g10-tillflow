const interfaceSpec = require('./interface');
const { createFakeMpesaClient, OUTCOMES, TEST_MSISDNS, outcomeFor } = require('./fake');
const signature = require('./signature');

const MODES = Object.freeze({ FAKE: 'fake', DARAJA: 'daraja' });

function createMpesaClient(options = {}) {
  const mode = options.mode || process.env.MPESA_MODE || MODES.FAKE;

  if (mode === MODES.FAKE) {
    return createFakeMpesaClient(options);
  }

  if (mode === MODES.DARAJA) {
    throw new interfaceSpec.MpesaError(
      'daraja mode is not implemented yet — CI and k6 must use MPESA_MODE=fake',
      'MPESA_MODE_UNAVAILABLE'
    );
  }

  throw new interfaceSpec.MpesaError(`unknown MPESA_MODE: ${mode}`, 'MPESA_MODE_INVALID');
}

module.exports = {
  createMpesaClient,
  createFakeMpesaClient,
  MODES,
  OUTCOMES,
  TEST_MSISDNS,
  outcomeFor,
  signature,
  ...interfaceSpec,
};
