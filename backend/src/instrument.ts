// Must be required/imported BEFORE any other module (express, http client, etc.)
// so OTel can patch them at load time. See package.json's "start" script.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const collectorBase = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://collector:4318';

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'tracey-backend',
  }),
  traceExporter: new OTLPTraceExporter({
    url: `${collectorBase}/v1/traces`,
  }),
  // Traces push on span end; metrics are *pulled* on an interval by the reader
  // and aggregated in-process in between. 10s is for lab impatience —
  // production is 60s. Note /v1/metrics is a distinct OTLP endpoint, which is
  // why collector-config.yaml carries a separate `metrics` pipeline.
  metricReader: new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: `${collectorBase}/v1/metrics`,
    }),
    exportIntervalMillis: 10_000,
  }),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();

process.on('SIGTERM', () => {
  sdk.shutdown().finally(() => process.exit(0));
});
