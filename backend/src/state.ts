import { ClaudeMessage } from './claude';

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

export interface Payment {
  method: 'card';
  last4: string;
  tipPercent: number;
}

/** Stage identifiers the tracking page walks through. */
export type Stage =
  | 'received'
  | 'making'
  | 'baking'
  | 'packaging'
  | 'out_for_delivery'
  | 'ready_for_pickup'
  | 'delivered'
  | 'picked_up';

export interface OrderStatus {
  stage: Stage;
  stageIndex: number;
  stages: Stage[];
  etaMinutes: number;
  complete: boolean;
}

export interface OrderState {
  size: 'small' | 'medium' | 'large' | 'xlarge' | null;
  crust: 'thin' | 'regular' | 'deep' | null;
  toppings: string[];
  unavailableToppings: string[];
  /** Set by the chat `checkout` tool — gates the transition to /checkout/. */
  confirmed: boolean;
  fulfillment: Fulfillment | null;
  address: Address | null;
  tipPercent: number | null;
  payment: Payment | null;
  receipt: {
    orderNumber: string;
    etaMinutes: number;
  } | null;
}

export interface Session {
  history: ClaudeMessage[];
  order: OrderState;
}

const sessions = new Map<string, Session>();

export function getSession(sessionId: string): Session {
  const existing = sessions.get(sessionId);
  if (existing) return existing;

  const fresh: Session = {
    history: [],
    order: {
      size: null,
      crust: null,
      toppings: [],
      unavailableToppings: [],
      confirmed: false,
      fulfillment: null,
      address: null,
      tipPercent: null,
      payment: null,
      receipt: null,
    },
  };
  sessions.set(sessionId, fresh);
  return fresh;
}

export function hasSession(sessionId: string): boolean {
  return sessions.has(sessionId);
}

/**
 * Wipe the order and the chat transcript but keep the session id, so
 * "Order another" starts a clean funnel inside the same RUM session.
 */
export function resetSession(sessionId: string): Session {
  sessions.delete(sessionId);
  return getSession(sessionId);
}
