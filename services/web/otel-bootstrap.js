// OpenTelemetry autoinstrumentation for the web service.
//
// Load with `node --require ./otel-bootstrap.js server.js` — must run BEFORE
// any application code so incoming HTTP + outgoing calls get spans.
//
// Kept in sync with services/_shared/otel-bootstrap.js; the shared copy is
// there so downstream services (pos, payments, commission) can consume it
// via a shared base image at G2. For G1 each service inlines it so the
// build is self-contained.

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { Resource } = require('@opentelemetry/resources');
const {
  SEMRESATTRS_SERVICE_NAME,
  SEMRESATTRS_DEPLOYMENT_ENVIRONMENT,
} = require('@opentelemetry/semantic-conventions');

const serviceName = process.env.OTEL_SERVICE_NAME || 'web';
const environment = process.env.DEPLOYMENT_ENVIRONMENT || 'prod';
const otlpEndpoint =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';

const sdk = new NodeSDK({
  resource: new Resource({
    [SEMRESATTRS_SERVICE_NAME]: serviceName,
    [SEMRESATTRS_DEPLOYMENT_ENVIRONMENT]: environment,
    'service.namespace': 'tillflow',
    'group': 'g10',
  }),
  traceExporter: new OTLPTraceExporter({
    url: `${otlpEndpoint.replace(/\/+$/, '')}/v1/traces`,
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
});

try {
  sdk.start();
} catch (err) {
  // Do not crash on OTel init failure.
  // eslint-disable-next-line no-console
  console.error(
    JSON.stringify({
      level: 'error',
      msg: 'otel-bootstrap failed',
      error: String(err && err.message ? err.message : err),
    })
  );
}

process.on('SIGTERM', () => {
  sdk
    .shutdown()
    .catch(() => {})
    .finally(() => process.exit(0));
});
