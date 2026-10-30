/**
 * ── The order ─────────────────────────────────────────────────────────────
 * What can be done to a customer's order, and how an order is serialised for
 * the frontend. Plain application code: take input, mutate the session, return
 * what happened. No `@opentelemetry` import — the spans that wrap these live in
 * order-instrumentation.ts, and index.ts is what joins the two.
 *
 * The return types are the reason index.ts needs no tracer. `updateOrder`
 * reports the facts of what it did, and order-instrumentation.ts decides which
 * of those become span attributes (see `toolSpanAttributes` over there). It is
 * not "returning telemetry" — `summary` goes straight back to Claude, and a
 * caller with no observability at all would still want to know which toppings
 * were out of stock.
 * ──────────────────────────────────────────────────────────────────────────
 */
import { getSession, Session } from './state';
import { priceOrder } from './pricing';

const INVENTORY_URL = process.env.INVENTORY_URL || 'http://inventory:4001';

async function checkStock(toppings: string[], chaos: boolean) {
  const res = await fetch(`${INVENTORY_URL}/check-stock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ toppings, chaos }),
  });
  if (!res.ok) throw new Error(`inventory returned ${res.status}`);
  return (await res.json()) as { topping: string; available: boolean }[];
}

/** The `update_order` tool's input, as Claude sends it. */
export interface UpdateOrderInput {
  size?: string;
  crust?: string;
  toppings?: string[];
}

export interface UpdateOrderResult {
  requestedToppings: string[];
  availableToppings: string[];
  unavailableToppings: string[];
  /** The tool_result text handed back to Claude. */
  summary: string;
}

export async function updateOrder(
  input: UpdateOrderInput,
  session: Session,
  chaos: boolean
): Promise<UpdateOrderResult> {
  if (input.size) session.order.size = input.size as any;
  if (input.crust) session.order.crust = input.crust as any;

  const requestedToppings = input.toppings ?? [];
  if (!requestedToppings.length) {
    return {
      requestedToppings,
      availableToppings: [],
      unavailableToppings: [],
      summary: 'Order updated.',
    };
  }

  const stockResults = await checkStock(requestedToppings, chaos);
  const availableToppings = stockResults.filter((s) => s.available).map((s) => s.topping);
  const unavailableToppings = stockResults.filter((s) => !s.available).map((s) => s.topping);

  session.order.toppings.push(...availableToppings);
  session.order.unavailableToppings.push(...unavailableToppings);

  return {
    requestedToppings,
    availableToppings,
    unavailableToppings,
    summary: `Added: ${availableToppings.join(', ') || 'none'}.${
      unavailableToppings.length ? ` Unavailable: ${unavailableToppings.join(', ')}.` : ''
    }`,
  };
}

/**
 * The order as every page of the checkout funnel expects to receive it.
 *
 * Pricing is recomputed here rather than stored, so a payload can never carry a
 * total that disagrees with the order it is attached to.
 */
export function orderPayload(sessionId: string) {
  const session = getSession(sessionId);
  return { order: session.order, pricing: priceOrder(session.order) };
}
