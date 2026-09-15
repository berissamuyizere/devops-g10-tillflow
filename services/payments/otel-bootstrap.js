// OpenTelemetry autoinstrumentation for the payments service.
// Aligned with services/web (resourceFromAttributes) so G2 traces export.

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_NAMESPACE,
} = require('@opentelemetry/semantic-conventions');

const serviceName = process.env.OTEL_SERVICE_NAME || 'payments';
const environment = process.env.DEPLOYMENT_ENVIRONMENT || 'prod';
const otlpEndpoint =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_SERVICE_NAMESPACE]: 'tillflow',
    'deployment.environment': environment,
    group: 'g10',
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
