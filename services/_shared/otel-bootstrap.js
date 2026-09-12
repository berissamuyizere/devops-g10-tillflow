// OpenTelemetry autoinstrumentation bootstrap.
//
// Load this file with `node --require /opt/tillflow/otel-bootstrap.js server.js`
// (or the local path inside a service). It must run BEFORE any application
// code so incoming HTTP + outgoing pg/redis/http calls all get spans.
//
// Reads:
//   OTEL_SERVICE_NAME               (required)
//   OTEL_EXPORTER_OTLP_ENDPOINT     (default http://localhost:4318)
//   OTEL_RESOURCE_ATTRIBUTES        (comma=kv,list of extra attributes)
//   DEPLOYMENT_ENVIRONMENT          (e.g. prod)
//
// Emits both traces (OTLP HTTP → localhost sidecar) and JSON structured
// logs with trace_id + span_id fields.

const { NodeSDK } = require('@opentelemetry/sdk-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_NAMESPACE,
} = require('@opentelemetry/semantic-conventions');

const serviceName = process.env.OTEL_SERVICE_NAME || 'unknown-service';
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
      // Silence the fs instrumentation — noisy and low-signal.
      '@opentelemetry/instrumentation-fs': { enabled: false },
    }),
  ],
});

try {
  sdk.start();
} catch (err) {
  // Do not crash the app on OTel init failure; log to stderr and continue.
  // The ADOT sidecar's health probe covers the "collector is up" concern.
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
