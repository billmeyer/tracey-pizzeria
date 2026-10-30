/**
 * ── The pizza ─────────────────────────────────────────────────────────────
 * Locking in the pizza the customer has built. Same shape as order.ts: plain
 * application code, no `@opentelemetry` import, and a return type carrying the
 * facts order-instrumentation.ts turns into span attributes.
 * ──────────────────────────────────────────────────────────────────────────
 */
import { Fulfillment, Receipt, Session } from './state';
import { priceOrder } from './pricing';

/**
 * Exported, unlike order.ts's `INVENTORY_URL`, because the kitchen has a second
 * caller: the status endpoint in index.ts polls `/status/:orderNumber`. If that
 * poll ever moves in here too, this can go back to being private.
 */
export const KITCHEN_URL = process.env.KITCHEN_URL || 'http://kitchen:4002';

/** The tool_result text handed back to Claude once the pizza is locked in. */
export const CONFIRM_PIZZA_SUMMARY =
    'Pizza locked in. The checkout screen is now unlocked. Reply with one short line telling the customer to tap Checkout to choose pickup or delivery. Do not mention any prices or totals.';

/** Send the order to the kitchen. The response is the customer's receipt. */
export async function bakePizza(order: unknown, chaos: boolean, fulfillment: Fulfillment) {
  const res = await fetch(`${KITCHEN_URL}/bake`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ order, chaos, fulfillment }),
  });
  if (!res.ok) throw new Error(`kitchen returned ${res.status}`);
  return (await res.json()) as Receipt;
}

export interface ConfirmPizzaResult {
  size: string;
  crust: string;
  toppingCount: number;
  subtotal: number;
}

/**
 * Confirming the pizza no longer touches the kitchen — it only flips the gate
 * that lets the frontend hard-navigate to /checkout/. The kitchen call moved
 * to POST /api/order/:sessionId/payment, so the bake happens when the customer
 * actually pays.
 *
 * The subtotal is returned for the span but deliberately kept out of the tool
 * result: pricing is not shown anywhere on the order view, and handing Claude
 * a number is the surest way to have it quoted in the chat.
 */
export function confirmPizza(session: Session): ConfirmPizzaResult {
  session.order.confirmed = true;
  const pricing = priceOrder(session.order);

  return {
    size: session.order.size ?? 'medium',
    crust: session.order.crust ?? 'regular',
    toppingCount: session.order.toppings.length,
    subtotal: pricing.subtotal,
  };
}
