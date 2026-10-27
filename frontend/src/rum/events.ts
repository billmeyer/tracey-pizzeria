import type { Context } from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import {
  ATTR_EXCEPTION_MESSAGE,
  ATTR_EXCEPTION_STACKTRACE,
  ATTR_EXCEPTION_TYPE,
  EVENT_EXCEPTION,
} from '@opentelemetry/semantic-conventions';

/**
 * ── Custom RUM events ─────────────────────────────────────────────────────
 * Everything here is emitted as an OTel *log record* with an `event_name`,
 * which is what the Datadog RUM x OTel integration maps onto RUM event
 * types. Two naming rules matter:
 *
 *  - `exception` is the event name Datadog turns into a **RUM Error**. Our
 *    hand-rolled validation and payment failures use it (with the standard
 *    `exception.*` attributes) so they show up as real errors, not as info
 *    logs that nobody will find.
 *  - `traceys.pizzeria.*` names are custom events, faceted by the `traceys.pizzeria.*` /
 *    `traceys.pizzeria.funnel.*` attributes that `order-context.ts` stamps on everything.
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

const FUNNEL_STARTED_KEY = 'tracey-funnel-started-at';
const STEP_ENTERED_KEY = 'tracey-step-entered-at';

function logger() {
  return logs.getLogger('tracey.rum.funnel', '1.0.0');
}

function now(): number {
  return Date.now();
}

function readTimestamp(key: string): number | null {
  const raw = sessionStorage.getItem(key);
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export function stepIndex(step: Step): number {
  return STEPS.indexOf(step);
}

/**
 * Emitted once per document load. Because each step is its own document,
 * this pairs with the SDK's own `browser.navigation_timing` /
 * `browser.web_vital` events for the same page — the funnel step name is the
 * join key between them.
 */
export function emitStepEntered(step: Step): void {
  const entered = now();
  sessionStorage.setItem(STEP_ENTERED_KEY, String(entered));
  if (readTimestamp(FUNNEL_STARTED_KEY) === null) {
    sessionStorage.setItem(FUNNEL_STARTED_KEY, String(entered));
  }

  logger().emit({
    eventName: 'traceys.pizzeria.funnel.step_entered',
    severityNumber: SeverityNumber.INFO,
    body: `Entered funnel step "${step}"`,
    attributes: {
      'traceys.pizzeria.funnel.step': step,
      'traceys.pizzeria.funnel.step_index': stepIndex(step),
      'traceys.pizzeria.funnel.total_steps': STEPS.length,
    },
  });
}

/** Extra page-level detail on an `traceys.pizzeria.page.entered` record. */
export type PageAttributes = Record<string, string | number | boolean>;

/**
 * Emitted when a page *component* mounts — see `usePageEntered`.
 *
 * Deliberately separate from `traceys.pizzeria.funnel.step_entered` above, which
 * `bootstrapPage` emits as soon as the SDK is up, before React has rendered
 * anything. This one fires when the component is actually on screen, so the
 * gap between the two timestamps is the document's React startup cost, and
 * the `traceys.pizzeria.page.*` attributes describe what the page knew at mount (whether
 * it painted from the sessionStorage cache, what it defaulted to) rather
 * than where the customer is in the funnel.
 *
 * The `traceys.pizzeria.*` attributes land on this record automatically via
 * `createOrderContextLogRecordProcessor`, so callers should pass only
 * page-specific detail here.
 */
export function emitPageEnteredAction(step: Step, attributes: PageAttributes = {}): void {
  logger().emit({
    eventName: 'traceys.pizzeria.page.entered',
    severityNumber: SeverityNumber.INFO,
    body: `Rendered ${step} page`,
    attributes: {
      'traceys.pizzeria.funnel.step': step,
      'traceys.pizzeria.page.url': window.location.pathname,
      ...attributes,
    },
  });
}

/**
 * Emitted just before a hard navigation away from `step`. The caller is
 * responsible for flushing (see `hardNavigate`), otherwise the batch
 * processor's scheduled delay would outlive the document.
 */
export function emitStepCompletedAction(step: Step, nextStep: Step | null): void {
  const enteredAt = readTimestamp(STEP_ENTERED_KEY);
  const funnelStartedAt = readTimestamp(FUNNEL_STARTED_KEY);
  const finished = now();

  logger().emit({
    eventName: 'traceys.pizzeria.funnel.step_completed',
    severityNumber: SeverityNumber.INFO,
    body: `Completed funnel step "${step}"`,
    attributes: {
      'traceys.pizzeria.funnel.step': step,
      'traceys.pizzeria.funnel.step_index': stepIndex(step),
      'traceys.pizzeria.funnel.total_steps': STEPS.length,
      ...(nextStep ? { 'traceys.pizzeria.funnel.next_step': nextStep } : {}),
      ...(enteredAt !== null
        ? { 'traceys.pizzeria.funnel.step_duration_ms': finished - enteredAt }
        : {}),
      ...(funnelStartedAt !== null
        ? { 'traceys.pizzeria.funnel.elapsed_ms': finished - funnelStartedAt }
        : {}),
    },
  });
}

/**
 * Emitted when the pizza is handed over — the end of the funnel.
 *
 * Pass the polling operation's `ctx` so this lands in the same trace as the
 * request that observed the terminal stage.
 */
export function emitFunnelCompletedAction(outcome: string, ctx?: Context): void {
  const funnelStartedAt = readTimestamp(FUNNEL_STARTED_KEY);
  logger().emit({
    eventName: 'traceys.pizzeria.funnel.completed',
    severityNumber: SeverityNumber.INFO,
    body: `Funnel completed: ${outcome}`,
    ...(ctx ? { context: ctx } : {}),
    attributes: {
      'traceys.pizzeria.funnel.outcome': outcome,
      ...(funnelStartedAt !== null
        ? { 'traceys.pizzeria.funnel.total_duration_ms': now() - funnelStartedAt }
        : {}),
    },
  });
}

export interface StageChangedOptions {
  /** Human-readable stage name, e.g. "In the oven" — what the customer sees. */
  label?: string;
  /**
   * Context of the poll that observed the transition. Without it the record
   * falls back to the page-wide trace (see page-trace.ts), which tells you
   * which page view it came from but not which request found the new stage.
   */
  ctx?: Context;
}

/**
 * One record per stage the kitchen moves into: received -> making -> baking
 * -> packaging -> ready_for_pickup (or out_for_delivery -> delivered).
 *
 * Fired on *transition*, so there is exactly one per stage rather than one
 * per poll. The kitchen holds each stage for 9s and the tracking page polls
 * every 3s, so roughly three polls observe each stage and only the first
 * logs it.
 */
export function emitStageChangedAction(
  stage: string,
  stageIndex: number,
  totalStages: number,
  options: StageChangedOptions = {}
): void {
  const { label, ctx } = options;
  logger().emit({
    eventName: 'traceys.pizzeria.stage_changed',
    severityNumber: SeverityNumber.INFO,
    body: label ? `Order stage: ${label}` : `Order stage: ${stage}`,
    ...(ctx ? { context: ctx } : {}),
    attributes: {
      'traceys.pizzeria.stage': stage,
      ...(label ? { 'traceys.pizzeria.stage_label': label } : {}),
      'traceys.pizzeria.stage_index': stageIndex,
      'traceys.pizzeria.total_stages': totalStages,
      'traceys.pizzeria.is_final_stage': stageIndex === totalStages - 1,
    },
  });
}

/**
 * A failed form validation, emitted as a RUM Error. Deliberately uses the
 * `exception` event name and `exception.*` attributes so it is
 * indistinguishable (to Datadog) from an error the SDK caught itself.
 */
export function emitValidationError(
  field: string,
  rule: string,
  message: string,
  step: Step
): void {
  logger().emit({
    eventName: EVENT_EXCEPTION,
    severityNumber: SeverityNumber.ERROR,
    body: message,
    attributes: {
      [ATTR_EXCEPTION_TYPE]: 'ValidationError',
      [ATTR_EXCEPTION_MESSAGE]: message,
      'traceys.pizzeria.validation.field': field,
      'traceys.pizzeria.validation.rule': rule,
      'traceys.pizzeria.funnel.step': step,
    },
  });
}

/**
 * A non-validation failure (declined card, unreachable kitchen, bad fetch).
 *
 * `ctx` is what gets this RUM Error `trace_id` / `span_id`. Every caller of
 * this function is in a `catch` after an `await`, where the browser SDK's
 * synchronous context manager has already restored the root context — so the
 * ambient `context.active()` holds no span and the log would export with no
 * trace ids at all. Pass `op.ctx` from `startOperation` (see operation.ts) to
 * tie the error to the trace whose fetch failed.
 */
export function emitAppError(
  type: string,
  error: unknown,
  extra: Record<string, string> = {},
  ctx?: Context
): void {
  const message = error instanceof Error ? error.message : String(error);
  logger().emit({
    eventName: EVENT_EXCEPTION,
    severityNumber: SeverityNumber.ERROR,
    body: message,
    ...(ctx ? { context: ctx } : {}),
    attributes: {
      [ATTR_EXCEPTION_TYPE]: type,
      [ATTR_EXCEPTION_MESSAGE]: message,
      ...(error instanceof Error && error.stack
        ? { [ATTR_EXCEPTION_STACKTRACE]: error.stack }
        : {}),
      ...extra,
    },
  });
}

/**
 * Props for a named action. `UserActionInstrumentation` copies every
 * `data-otel-*` attribute off the clicked element into
 * `browser.element.attributes`, which is how a click becomes a *named* RUM
 * action instead of an anonymous CSS selector. Spread this onto buttons:
 *
 *   <button {...namedAction('checkout.continue_to_payment')}>Next</button>
 */
export function namedAction(name: string, extra: Record<string, string> = {}) {
  const attrs: Record<string, string> = { 'data-otel-action-name': name };
  for (const [key, value] of Object.entries(extra)) {
    attrs[`data-otel-${key}`] = value;
  }
  return attrs;
}
