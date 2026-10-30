/**
 * ── Taking the money ──────────────────────────────────────────────────────
 * Charging the card and handing the order to the kitchen. Same shape as
 * order.ts and pizza.ts: plain application code, no `@opentelemetry` import.
 * The span around this one is `withChargeSpan` in order-instrumentation.ts.
 * ──────────────────────────────────────────────────────────────────────────
 */
import { Receipt, Session } from './state';
import { bakePizza } from './pizza';

/**
 * A card the issuer refused.
 *
 * A named subclass rather than a plain `Error`, because the route needs to tell
 * this apart from an unreachable kitchen — a 402 the customer can fix by
 * trying another card, versus a 502 that is our problem — and the throw and the
 * catch now live in different files. Matching on `message.includes('declined')`
 * across that boundary would make the wording of a human-readable string
 * load-bearing, and rewording it would silently turn every decline into a 502.
 *
 * It also improves the telemetry for free: `withChargeSpan` records
 * `error.type` from `error.name`, so declines arrive as `CardDeclinedError`
 * rather than an undifferentiated `Error`, and the two failure modes are
 * separable on the span as well as in the response.
 */
export class CardDeclinedError extends Error {
  readonly name = 'CardDeclinedError';

  constructor() {
    super('Card declined by issuer');
  }
}

/**
 * Record the customer's card and tip on the order, ahead of charging it.
 *
 * Returns false when the card number isn't 16 digits, leaving the order
 * untouched — the route turns that into a 400. A boolean rather than a thrown
 * error because an invalid card is an expected answer here, not a failure: the
 * customer mistyped, and nothing went wrong in the system.
 *
 * Only the last four digits are kept. The full number is never stored on the
 * order and so can never reach a span, a log line, or the JSON the checkout
 * page gets back — worth saying out loud in a workshop whose other half is
 * about how much telemetry quietly picks up.
 */
export function applyCardDetails(
  session: Session,
  cardNumber: string | undefined,
  tipPercent: number | undefined
): boolean {
  const digits = (cardNumber ?? '').replace(/\D/g, '');
  if (digits.length !== 16) return false;

  session.order.tipPercent = typeof tipPercent === 'number' ? tipPercent : 0;
  session.order.payment = {
    method: 'card',
    last4: digits.slice(-4),
    tipPercent: session.order.tipPercent,
  };
  return true;
}

/**
 * Undo `applyCardDetails` after a failed charge, so a declined order doesn't
 * look paid. The tip survives deliberately: the customer chose it, and it is
 * still their choice when they retry with another card.
 */
export function clearCardDetails(session: Session): void {
  session.order.payment = null;
}

/**
 * Charge the card and send the order to the kitchen.
 *
 * Chaos mode declines roughly one card in three, so the payment page has a
 * reliable way to produce a RUM error on demand. Both failure paths — the
 * decline and an unreachable kitchen — are thrown; turning them into error
 * spans is `withChargeSpan`'s job, and turning them into status codes is the
 * route's.
 */
export async function chargeAndPlaceOrder(
  session: Session,
  chaos: boolean
): Promise<Receipt> {
  if (chaos && Math.random() < 0.34) {
    throw new CardDeclinedError();
  }
  return bakePizza(session.order, chaos, session.order.fulfillment!);
}
