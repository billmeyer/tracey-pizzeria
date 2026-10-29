// Must be required/imported BEFORE any other module (express, http client, etc.)
// so OTel can patch them at load time. See package.json's "start" script.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { ExpressInstrumentation } from '@opentelemetry/instrumentation-express';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { NetInstrumentation } from '@opentelemetry/instrumentation-net';
import { RouterInstrumentation } from '@opentelemetry/instrumentation-router';
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
  //
  // Plural, and an array: `metricReader` was renamed `metricReaders` in
  // sdk-node 0.300. One reader is still the normal case — the array exists so
  // a process can fan the same meters out to several backends.
  metricReaders: [
    new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        url: `${collectorBase}/v1/metrics`,
      }),
      exportIntervalMillis: 10_000,
    }),
  ],
  // Named individually rather than via getNodeAutoInstrumentations().
  //
  // These five are exactly the ones that were emitting spans under the
  // meta-package — verified by reading the InstrumentationScope values the
  // Collector received — so the traces are unchanged. What goes away is the
  // other 44 dependencies it pulls in, including five cloud resource
  // detectors this app never uses. The GCP one was the last source of
  // deprecated transitive packages (gcp-metadata -> gaxios -> node-fetch ->
  // node-domexception, and -> rimraf -> glob), and no version bump could fix
  // that: even the latest gaxios still depends on node-fetch.
  //
  // undici is the one to not drop by accident: it instruments fetch, which is
  // how the backend reaches inventory and kitchen, and therefore how
  // traceparent propagates across services.
  instrumentations: [
    new HttpInstrumentation(),
    new ExpressInstrumentation(),
    new UndiciInstrumentation(),
    new NetInstrumentation(),
    new RouterInstrumentation(),
  ],
});

sdk.start();

process.on('SIGTERM', () => {
  sdk.shutdown().finally(() => process.exit(0));
});
