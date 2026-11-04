import type { Context } from '@opentelemetry/api';
import { installTelemetry, type Operation, type Telemetry } from '../lib/telemetry';
import type { Step } from '../lib/steps';
import {
  emitAppError,
  emitFunnelCompletedAction,
  emitPageEnteredAction,
  emitStageChangedAction,
  emitStepCompletedAction,
  emitStepEntered,
  emitValidationError,
  namedAction,
} from './events';
import { startOperation } from './operation';
import { setOrderContext } from './order-context';
import { flushRum, initOtelRum } from './otel';
import { getRumSessionId, subscribeRumSession } from './session';

/**
 * ── Where the app's telemetry seam gets filled in ──────────────────────────
 * `lib/telemetry.ts` declares what the application reports; this file is the
 * one place that says it in OTel. It is also the *only* thing `bootstrap.tsx`
 * imports from `src/rum/`, which is what makes the workshop's uninstrumented
 * starting point a deletion:
 *
 *   rm -rf src/rum/   +   drop three lines of bootstrap.tsx
 *
 * Nothing else in the app changes, because nothing else knows this layer
 * exists.
 *
 * The only translation that happens here is the trace context: the app passes
 * `op.ctx` around as an opaque `TraceContext` so no page has to import
 * `@opentelemetry/api`, and it is cast back to a `Context` on the way in.
 * ──────────────────────────────────────────────────────────────────────────
 */

const rumTelemetry: Telemetry = {
  emitAppError: (type, error, extra, ctx) =>
    emitAppError(type, error, extra, ctx as Context | undefined),

  emitFunnelCompletedAction: (outcome, ctx) =>
    emitFunnelCompletedAction(outcome, ctx as Context | undefined),

  emitPageEnteredAction,

  emitStageChangedAction: (stage, stageIndex, totalStages, options) =>
    emitStageChangedAction(stage, stageIndex, totalStages, {
      label: options.label,
      ctx: options.ctx as Context | undefined,
    }),

  emitStepCompletedAction,
  emitValidationError,

  flush: () => flushRum(),

  getSessionId: getRumSessionId,
  namedAction,
  setOrderContext,

  startOperation: (name, attributes): Operation => startOperation(name, attributes),

  subscribeSessionId: subscribeRumSession,
};

/**
 * Point the application's telemetry calls at the RUM layer.
 *
 * Synchronous and called first in `bootstrapPage`, because the very next
 * thing it does is `setOrderContext` — which has to reach the live order
 * context before the SDK starts, or the document's earliest events (
 * navigation timing, first web vitals) export without `traceys.pizzeria.*`.
 */
export function installRumTelemetry(): void {
  installTelemetry(rumTelemetry);
}

/**
 * Start the SDKs, then announce the funnel step.
 *
 * The order is the reason this is one function rather than two calls in
 * `bootstrapPage`: emitting `traceys.pizzeria.funnel.step_entered` before the
 * logs SDK exists would send it to the no-op logger provider and lose it.
 */
export async function startRum(step: Step): Promise<void> {
  await initOtelRum({ routeId: step });
  emitStepEntered(step);
}
