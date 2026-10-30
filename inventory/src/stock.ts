/**
 * ── The stockroom ─────────────────────────────────────────────────────────
 * What the pizzeria has in stock right now. Plain application code: no
 * `@opentelemetry` import, no tracer, no span. The span that wraps this lives
 * in instrumentation.ts, and index.ts is what joins the two.
 * ──────────────────────────────────────────────────────────────────────────
 */
import { isAvailable } from './menu';

export interface StockResult {
  topping: string;
  available: boolean;
}

/** One answer per requested topping, in the order they were asked about. */
export function checkStock(toppings: string[], chaos: boolean): StockResult[] {
  return toppings.map((topping) => ({
    topping,
    available: isAvailable(topping, chaos),
  }));
}
