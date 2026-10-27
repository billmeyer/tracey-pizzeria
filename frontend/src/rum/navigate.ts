import { emitStepCompletedAction, STEP_PATHS, type Step } from './events';
import { flushRum } from './otel-rum';

/**
 * ── Hard page transition ──────────────────────────────────────────────────
 * The whole point of the funnel: leave the current document entirely instead
 * of swapping a React subtree. `location.assign` triggers a real unload /
 * load pair, so the next step reports its own `browser.navigation_timing`,
 * its own Core Web Vitals, and a fresh set of resource timings — all under
 * the same RUM session id, which lives in localStorage.
 *
 * Contrast with client-side routing, where the SDK can only emit a
 * `browser.navigation` marker and the navigation-timing/web-vitals numbers
 * stay pinned to the first document forever.
 *
 * Order matters here: emit the completion event, *await the flush*, then
 * navigate. Skipping the flush drops the event (see `flushRum`).
 * ──────────────────────────────────────────────────────────────────────────
 */
export async function hardNavigate(from: Step, to: Step): Promise<void> {
  emitStepCompletedAction(from, to);
  await flushRum();
  window.location.assign(STEP_PATHS[to]);
}

/**
 * Leave the funnel without advancing (the "start over" / back affordances).
 * `replace` keeps the abandoned step out of the back-button history so a
 * customer cannot bounce back into a step whose server state is gone.
 */
export async function hardNavigateBack(from: Step, to: Step): Promise<void> {
  emitStepCompletedAction(from, to);
  await flushRum();
  window.location.replace(STEP_PATHS[to]);
}
