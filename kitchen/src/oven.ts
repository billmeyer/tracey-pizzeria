/**
 * ── The kitchen ───────────────────────────────────────────────────────────
 * Baking a pizza and tracking it through the stages the customer watches.
 * Plain application code: no `@opentelemetry` import, no tracer, no span. The
 * spans live in instrumentation.ts, and index.ts is what joins the two.
 *
 * `bakePizza` returns the facts worth observing — how long the bake took, what
 * order number came out, which pipeline it entered — and instrumentation.ts
 * decides which of those become span attributes. It is not "returning
 * telemetry": the bake time determines the ETA the customer is quoted, and
 * would be computed here with no observability at all.
 * ──────────────────────────────────────────────────────────────────────────
 */

export type Fulfillment = 'pickup' | 'delivery';

export type Stage =
  | 'received'
  | 'making'
  | 'baking'
  | 'packaging'
  | 'out_for_delivery'
  | 'ready_for_pickup'
  | 'delivered'
  | 'picked_up';

// Stage pipelines diverge at the hand-off: a delivery order goes on the road,
// a pickup order just sits on the warming rack until the customer shows up.
const DELIVERY_STAGES: Stage[] = [
  'received',
  'making',
  'baking',
  'packaging',
  'out_for_delivery',
  'delivered',
];
const PICKUP_STAGES: Stage[] = ['received', 'making', 'baking', 'packaging', 'ready_for_pickup'];

// How long each stage holds before advancing. Short enough that a workshop
// demo reaches "delivered" while the presenter is still talking about it.
const STAGE_DURATION_MS = 9000;

interface TrackedOrder {
  orderNumber: string;
  fulfillment: Fulfillment;
  stages: Stage[];
  startedAt: number;
  etaMinutes: number;
}

const trackedOrders = new Map<string, TrackedOrder>();

let orderCounter = 1000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * An oven that jammed mid-bake.
 *
 * Carries the bake time so a failure is still diagnosable: instrumentation.ts
 * puts `pizza.bake_time_ms` on the error span, which is the difference between
 * "the bake failed" and "the bake failed after 7.2s". A named subclass for the
 * same reason as the backend's `CardDeclinedError` — matching on the text of a
 * human-readable message across a module boundary makes that wording
 * load-bearing.
 */
export class OvenJammedError extends Error {
  readonly name = 'OvenJammedError';

  constructor(readonly bakeTimeMs: number) {
    super('Oven jammed');
  }
}

export interface BakeResult {
  orderNumber: string;
  etaMinutes: number;
  bakeTimeMs: number;
  fulfillment: Fulfillment;
}

/**
 * Bake a pizza and start tracking it. Throws `OvenJammedError` when the oven
 * jams — more often in chaos mode.
 */
export async function bakePizza(
  chaos: boolean,
  fulfillment: Fulfillment | undefined
): Promise<BakeResult> {
  // The "slow dependency" everyone loves to debug — normal latency is already
  // noticeable; chaos mode makes it impossible to miss.
  const bakeTimeMs = chaos ? 4000 + Math.random() * 4000 : 800 + Math.random() * 700;
  await sleep(bakeTimeMs);

  // Occasionally the oven jams — more often in chaos mode.
  const failureChance = chaos ? 0.15 : 0.02;
  if (Math.random() < failureChance) {
    throw new OvenJammedError(bakeTimeMs);
  }

  orderCounter += 1;
  const orderNumber = `T-${orderCounter}`;
  const etaMinutes = Math.round(bakeTimeMs / 1000 / 6) + 12;
  const resolvedFulfillment: Fulfillment = fulfillment === 'pickup' ? 'pickup' : 'delivery';

  trackedOrders.set(orderNumber, {
    orderNumber,
    fulfillment: resolvedFulfillment,
    stages: resolvedFulfillment === 'pickup' ? PICKUP_STAGES : DELIVERY_STAGES,
    startedAt: Date.now(),
    etaMinutes,
  });

  return { orderNumber, etaMinutes, bakeTimeMs, fulfillment: resolvedFulfillment };
}

export interface OrderStatus {
  orderNumber: string;
  fulfillment: Fulfillment;
  stage: Stage;
  stageIndex: number;
  stages: Stage[];
  etaMinutes: number;
  complete: boolean;
}

/**
 * Where an order has got to, or undefined if this kitchen has never heard of
 * it.
 *
 * Stage is derived from elapsed wall-clock time rather than advanced by a
 * background timer, so it stays correct across restarts of the poll loop and
 * needs no cleanup beyond the map entry itself.
 */
export function orderStatus(orderNumber: string): OrderStatus | undefined {
  const order = trackedOrders.get(orderNumber);
  if (!order) return undefined;

  const rawIndex = Math.floor((Date.now() - order.startedAt) / STAGE_DURATION_MS);
  const stageIndex = Math.min(rawIndex, order.stages.length - 1);

  return {
    orderNumber: order.orderNumber,
    fulfillment: order.fulfillment,
    stage: order.stages[stageIndex],
    stageIndex,
    stages: order.stages,
    etaMinutes: order.etaMinutes,
    complete: stageIndex === order.stages.length - 1,
  };
}
