import { setOrderContext } from '../rum/order-context';

export type Fulfillment = 'pickup' | 'delivery';

export interface Address {
  street: string;
  city: string;
  zip: string;
}

export interface Pricing {
  subtotal: number;
  deliveryFee: number;
  tax: number;
  tip: number;
  total: number;
}

export interface OrderState {
  size: string | null;
  crust: string | null;
  toppings: string[];
  unavailableToppings: string[];
  confirmed: boolean;
  fulfillment: Fulfillment | null;
  address: Address | null;
  tipPercent: number | null;
  payment: { method: 'card'; last4: string; tipPercent: number } | null;
  receipt: { orderNumber: string; etaMinutes: number } | null;
}

export interface OrderSnapshot {
  order: OrderState;
  pricing: Pricing;
}

export interface OrderStatus {
  orderNumber: string;
  fulfillment: Fulfillment;
  stage: string;
  stageIndex: number;
  stages: string[];
  etaMinutes: number;
  complete: boolean;
}

const SESSION_KEY = 'tracey-session-id';
const CACHE_KEY = 'tracey-order-cache';

export function getSessionId(): string {
  const existing = localStorage.getItem(SESSION_KEY);
  if (existing) return existing;
  const fresh = crypto.randomUUID();
  localStorage.setItem(SESSION_KEY, fresh);
  return fresh;
}

export function isChaos(): boolean {
  // Chaos has to survive the hard transitions, so it is sticky once seen:
  // the query param only appears on the first document.
  const fromQuery = new URLSearchParams(window.location.search).get('chaos') === 'true';
  if (fromQuery) sessionStorage.setItem('tracey-chaos', 'true');
  return fromQuery || sessionStorage.getItem('tracey-chaos') === 'true';
}

/**
 * sessionStorage mirror of the last known order. Each new document paints
 * from this synchronously, then reconciles with the authoritative server
 * copy when the hydration fetch lands — so a hard transition never shows an
 * empty skeleton even though it is a cold document.
 */
export function readCachedOrder(): OrderSnapshot | null {
  const raw = sessionStorage.getItem(CACHE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OrderSnapshot;
  } catch {
    return null;
  }
}

export function cacheOrder(snapshot: OrderSnapshot): void {
  sessionStorage.setItem(CACHE_KEY, JSON.stringify(snapshot));
  publishOrderContext(snapshot);
}

/** Push the order onto every subsequent RUM span and log. */
export function publishOrderContext(snapshot: OrderSnapshot | null): void {
  if (!snapshot) return;
  const { order, pricing } = snapshot;
  setOrderContext({
    size: order.size ?? undefined,
    crust: order.crust ?? undefined,
    toppingCount: order.toppings.length,
    toppings: order.toppings.join(',') || undefined,
    fulfillment: order.fulfillment ?? undefined,
    tipPercent: order.tipPercent ?? undefined,
    subtotal: pricing?.subtotal,
    total: pricing?.total,
    orderNumber: order.receipt?.orderNumber,
  });
}

async function parseOrThrow(res: Response) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(
      (body as { error?: string }).error || `Request failed with ${res.status}`
    );
    (error as Error & { code?: string }).code = (body as { code?: string }).code;
    (error as Error & { status?: number }).status = res.status;
    throw error;
  }
  return body;
}

export async function fetchOrder(): Promise<OrderSnapshot & { known: boolean }> {
  const res = await fetch(`/api/order/${getSessionId()}`);
  const snapshot = (await parseOrThrow(res)) as OrderSnapshot & { known: boolean };
  cacheOrder(snapshot);
  return snapshot;
}

export async function saveFulfillment(
  fulfillment: Fulfillment,
  address: Address | null
): Promise<OrderSnapshot> {
  const res = await fetch(`/api/order/${getSessionId()}/fulfillment`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fulfillment, address }),
  });
  const snapshot = (await parseOrThrow(res)) as OrderSnapshot;
  cacheOrder(snapshot);
  return snapshot;
}

export async function submitPayment(
  cardNumber: string,
  tipPercent: number
): Promise<OrderSnapshot> {
  const res = await fetch(`/api/order/${getSessionId()}/payment`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cardNumber, tipPercent, chaos: isChaos() }),
  });
  const snapshot = (await parseOrThrow(res)) as OrderSnapshot;
  cacheOrder(snapshot);
  return snapshot;
}

export async function fetchStatus(): Promise<OrderStatus> {
  const res = await fetch(`/api/order/${getSessionId()}/status`);
  return (await parseOrThrow(res)) as OrderStatus;
}

/**
 * Start a fresh funnel without starting a fresh RUM session: clears the
 * server-side order and chat history, and the cached order plus funnel step
 * timers in sessionStorage — but deliberately keeps the localStorage session
 * id (and the sticky chaos flag) so the whole visit remains one session.
 */
export async function resetOrder(): Promise<void> {
  const chaos = isChaos();
  try {
    await fetch(`/api/order/${getSessionId()}/reset`, { method: 'POST' });
  } finally {
    sessionStorage.clear();
    if (chaos) sessionStorage.setItem('tracey-chaos', 'true');
  }
}

export function money(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export interface OrderIssue {
  field: string;
  rule: string;
  message: string;
}

/**
 * What "a complete order" means before the funnel will let you leave the
 * order page. Toppings are deliberately *not* required — a plain cheese pizza
 * is a real order, and the summary already renders "cheese, obviously" for
 * the empty case.
 *
 * This runs on click rather than gating the button, so the Checkout button is
 * always visible: a disabled button emits no click, which would mean no RUM
 * action and no validation error for the most interesting moment in the
 * funnel — someone trying to advance before they're ready.
 */
export function validateOrderComplete(snapshot: OrderSnapshot | null): OrderIssue[] {
  if (!snapshot) {
    return [
      {
        field: 'order',
        rule: 'empty',
        message: "Tell Tracey what you'd like — size, crust, and any toppings.",
      },
    ];
  }

  const { order } = snapshot;
  const issues: OrderIssue[] = [];

  if (!order.size) {
    issues.push({
      field: 'size',
      rule: 'required',
      message: 'Pick a size — small, medium, large, or extra large.',
    });
  }
  if (!order.crust) {
    issues.push({
      field: 'crust',
      rule: 'required',
      message: 'Pick a crust — thin, regular, or deep dish.',
    });
  }
  if (!order.confirmed) {
    issues.push({
      field: 'confirmed',
      rule: 'required',
      message: "Tell Tracey you're done so she can lock the order in.",
    });
  }

  return issues;
}

export const STAGE_LABELS: Record<string, string> = {
  received: 'Order received',
  making: 'Making your pizza',
  baking: 'In the oven',
  packaging: 'Boxing it up',
  out_for_delivery: 'Out for delivery',
  ready_for_pickup: 'Ready for pickup',
  delivered: 'Delivered',
  picked_up: 'Picked up',
};

export const STAGE_ICONS: Record<string, string> = {
  received: '🧾',
  making: '🤌',
  baking: '🔥',
  packaging: '📦',
  out_for_delivery: '🛵',
  ready_for_pickup: '🪧',
  delivered: '🎉',
  picked_up: '🎉',
};
