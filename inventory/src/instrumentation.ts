/**
 * ── Instrumentation ───────────────────────────────────────────────────────
 * Every span this service emits by hand, in one file. OpenTelemetry API only —
 * no Datadog import anywhere in this repo's services — and the same shape the
 * backend uses in order-instrumentation.ts: one wrapper the app calls, and
 * nothing else.
 *
 * The split is the lesson. index.ts is an Express app and stock.ts is the
 * stockroom; neither imports `@opentelemetry`, and the uninstrumented version
 * of the route is this wrapper deleted:
 *
 *     const results = withCheckStockSpan(!!chaos, () => checkStock(toppings, !!chaos));
 *     const results = checkStock(toppings, !!chaos);
 *
 * `pizza.*` is a private namespace, not a semantic convention — no OTel
 * convention describes a pizza. Compare the gen_ai.* attributes in the
 * backend's instrumentation, which are conventional and therefore understood by
 * the backend without configuring anything.
 * ──────────────────────────────────────────────────────────────────────────
 */
import { trace, SpanKind } from '@opentelemetry/api';

// Types only, so this import is erased at compile time — and it points one way:
// stock.ts knows nothing about this file.
import type { StockResult } from './stock';

const tracer = trace.getTracer('tracey.inventory');

/**
 * Runs a stock check inside its own `check_stock` span.
 *
 * INTERNAL kind, because the work happens in this process: the lookup is a map
 * over an in-memory menu, not a call to anywhere. The span earns its keep as
 * the step that makes the inventory hop visible in the distributed trace — the
 * backend's outbound fetch and this service's Express span meet here — and as
 * somewhere to hang the two facts worth faceting on.
 *
 * `chaos` is passed separately rather than read off the result because it is an
 * input to the decision, not an outcome of it: it belongs on the span whether
 * or not anything turned out to be unavailable.
 */
export function withCheckStockSpan(
  chaos: boolean,
  call: () => StockResult[]
): StockResult[] {
  return tracer.startActiveSpan(
    'check_stock',
    { kind: SpanKind.INTERNAL, attributes: { 'pizza.chaos_mode': chaos } },
    (span) => {
      try {
        const results = call();
        span.setAttribute(
          'pizza.unavailable_count',
          results.filter((result) => !result.available).length
        );
        return results;
      } finally {
        span.end();
      }
    }
  );
}
