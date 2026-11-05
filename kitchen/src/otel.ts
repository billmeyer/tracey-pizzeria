// Must be required/imported BEFORE any other module (express, http client, etc.)
// so OTel can patch them at load time. See package.json's "start" script.
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import {
  ExpressInstrumentation,
  ExpressLayerType,
} from '@opentelemetry/instrumentation-express';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { NetInstrumentation } from '@opentelemetry/instrumentation-net';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const collectorBase = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://collector:4318';

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'tracey-kitchen',
  }),
  traceExporter: new OTLPTraceExporter({
    url: `${collectorBase}/v1/traces`,
  }),
  // Named individually rather than via getNodeAutoInstrumentations().
  //
  // These four are exactly the ones that were emitting *useful* spans under
  // the meta-package — verified by reading the InstrumentationScope values the
  // Collector received. What goes away is the
  // other 44 dependencies it pulls in, including five cloud resource
  // detectors this app never uses. The GCP one was the last source of
  // deprecated transitive packages (gcp-metadata -> gaxios -> node-fetch ->
  // node-domexception, and -> rimraf -> glob), and no version bump could fix
  // that: even the latest gaxios still depends on node-fetch.
  //
  // undici is the one to not drop by accident: it instruments fetch, which is
  // how the backend reaches inventory and kitchen, and therefore how
  // traceparent propagates across services.
  //
  // instrumentation-router was dropped. Express 5 delegates routing to the
  // standalone `router` package, so that instrumentation ends up wrapping
  // Express's *internal* router and duplicating instrumentation-express —
  // which is why its spans arrived named `middleware - patched`:
  // `router.name` is the function's own name, and by then the function was
  // already instrumentation-express's monkey-patch. Instrumentation wrapping
  // instrumentation, for no extra information. It is still in package.json;
  // removing it would rewrite three lockfiles for no runtime gain.
  instrumentations: [
    new HttpInstrumentation(),
    new ExpressInstrumentation({
      // One span per middleware, per request, is almost all noise here:
      // `middleware - jsonParser` and friends say nothing a reader wants
      // and bury the spans that do. Route and request-handler spans are
      // kept -- those carry http.route and are what the trace is read by.
      ignoreLayersType: [ExpressLayerType.MIDDLEWARE],
    }),
    new UndiciInstrumentation(),
    new NetInstrumentation(),
  ],
});

sdk.start();

process.on('SIGTERM', () => {
  sdk.shutdown().finally(() => process.exit(0));
});
