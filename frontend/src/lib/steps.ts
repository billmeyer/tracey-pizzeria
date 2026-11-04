/**
 * ── The funnel, as application data ───────────────────────────────────────
 * What the four steps are, where they live, and what they are called on
 * screen. None of this is telemetry: the step rail renders from it, the
 * navigation helpers resolve URLs from it, and `useOrder` types its argument
 * with it. The RUM layer *also* reads it — `traceys.pizzeria.funnel.step` and
 * `step_index` come from here — but that is a consumer, not an owner.
 *
 * Deliberately free of imports so it survives `src/rum/` being deleted for
 * the workshop's uninstrumented starting point.
 * ──────────────────────────────────────────────────────────────────────────
 */

/** The four documents of the funnel, in order. Each is a hard page load. */
export const STEPS = ['order', 'checkout', 'payment', 'tracking'] as const;
export type Step = (typeof STEPS)[number];

/** Where each step lives. Trailing slashes make the dev server serve the
 *  document directly rather than redirecting, so each hard transition is one
 *  navigation in RUM instead of a redirect hop followed by a page load. */
export const STEP_PATHS: Record<Step, string> = {
  order: '/',
  checkout: '/checkout/',
  payment: '/payment/',
  tracking: '/tracking/',
};

/** What each step is called in the step rail. */
export const STEP_LABELS: Record<Step, string> = {
  order: 'Order',
  checkout: 'Checkout',
  payment: 'Payment',
  tracking: 'Tracking',
};

export function stepIndex(step: Step): number {
  return STEPS.indexOf(step);
}
