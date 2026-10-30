/**
 * ── Instrumentation ───────────────────────────────────────────────────────
 * Every span this service emits by hand, in one file. OpenTelemetry API only,
 * and the same shape the backend uses in order-instrumentation.ts: wrappers the
 * app calls, and nothing else.
 *
 * index.ts is an Express app and oven.ts is the kitchen; neither imports
 * `@opentelemetry`. The uninstrumented version of the bake route is this
 * wrapper deleted:
 *
 *     await withBakeSpan(!!chaos, () => bakePizza(!!chaos, fulfillment));
 *     await bakePizza(!!chaos, fulfillment);
 *
 * `pizza.*` is a private namespace, not a semantic convention — no OTel
 * convention describes a pizza.
 * ──────────────────────────────────────────────────────────────────────────
 */
import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';

// OvenJammedError is a value (used with `instanceof`), so this import is real
// at runtime; the rest are types and are erased. The dependency still runs one
// way: oven.ts knows nothing about this file.
import { OvenJammedError, type BakeResult, type OrderStatus } from './oven';

const tracer = trace.getTracer('tracey.kitchen');

/**
 * Runs a bake inside its own `bake_pizza` span — the "slow dependency" span the
 * workshop spends most of its time looking at.
 *
 * INTERNAL kind, because the oven is this process. `pizza.chaos_mode` is known
 * up front; everything else is read off the result, so there is no second copy
 * of the bake time to drift away from the one the ETA was computed from.
 */
export async function withBakeSpan(
  chaos: boolean,
  call: () => Promise<BakeResult>
): Promise<BakeResult> {
  return tracer.startActiveSpan(
    'bake_pizza',
    { kind: SpanKind.INTERNAL, attributes: { 'pizza.chaos_mode': chaos } },
    async (span) => {
      try {
        const result = await call();
        span.setAttribute('pizza.bake_time_ms', Math.round(result.bakeTimeMs));
        span.setAttribute('pizza.order_number', result.orderNumber);
        span.setAttribute('pizza.fulfillment', result.fulfillment);
        return result;
      } catch (err) {
        // A jam has no result to read the bake time off, so it carries its own
        // — otherwise the one attribute that says how far the bake got would be
        // missing from exactly the span someone is debugging.
        if (err instanceof OvenJammedError) {
          span.setAttribute('pizza.bake_time_ms', Math.round(err.bakeTimeMs));
        }
        span.recordException(err as Error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
        throw err;
      } finally {
        span.end();
      }
    }
  );
}

/**
 * Facets a status poll with the order it asked about and the answer it got.
 *
 * No span of its own: the poll is already wrapped in an Express span by the
 * auto-instrumentation, and a child span around a map lookup would add depth
 * and no information. What that trace is missing is not structure, it's facets.
 *
 * `?.` and not `!`: with the SDK disabled there is no active span, and
 * telemetry is never worth a 500.
 */
export function recordOrderStatus(status: OrderStatus): void {
  const span = trace.getActiveSpan();
  span?.setAttribute('pizza.order_number', status.orderNumber);
  span?.setAttribute('pizza.stage', status.stage);
  span?.setAttribute('pizza.stage_index', status.stageIndex);
  span?.setAttribute('pizza.fulfillment', status.fulfillment);
}
