import React from 'react';
import ReactDOM from 'react-dom/client';
import { installRumTelemetry, startRum } from './rum/install';
import { stepIndex, type Step } from './lib/steps';
import { setOrderContext } from './lib/telemetry';
import { isChaos, publishOrderContext, readCachedOrder } from './lib/order';
import './App.css';

/**
 * Every funnel document boots the same way, and the order of the first three
 * lines matters:
 *
 *  1. Install the telemetry implementation, so the `setOrderContext` below
 *     reaches the live order context instead of the no-op default.
 *  2. Seed that context from the sessionStorage cache *before* the SDK
 *     starts, so even the earliest events of a cold document (navigation
 *     timing, first web vitals) already carry `traceys.pizzeria.*`.
 *  3. Start the SDK, which then emits `traceys.pizzeria.funnel.step_entered`
 *     (see `startRum` for why those two are one call).
 *
 * React renders immediately and does not wait on any of this; the page is
 * never blocked on telemetry.
 *
 * The two `rum/install` lines are the app's entire dependency on `src/rum/`.
 * Delete them and the directory and every page still works — `lib/telemetry`
 * falls back to no-ops — which is the workshop's uninstrumented chapter 01.
 */
export function bootstrapPage(step: Step, Page: React.ComponentType): void {
  installRumTelemetry();

  setOrderContext({ step, stepIndex: stepIndex(step), chaos: isChaos() });
  publishOrderContext(readCachedOrder());

  void startRum(step);

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <Page />
    </React.StrictMode>
  );
}
