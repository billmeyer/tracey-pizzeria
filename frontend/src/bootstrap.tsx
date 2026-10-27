import React from 'react';
import ReactDOM from 'react-dom/client';
import { initOtelRum } from './rum/otel-rum';
import { emitStepEntered, stepIndex, type Step } from './rum/events';
import { setOrderContext } from './rum/order-context';
import { isChaos, publishOrderContext, readCachedOrder } from './lib/order';
import './App.css';

/**
 * Every funnel document boots the same way, and the order of the first three
 * lines matters:
 *
 *  1. Seed the order context from the sessionStorage cache *before* the SDK
 *     starts, so even the earliest events of a cold document (navigation
 *     timing, first web vitals) already carry `traceys.pizzeria.*`.
 *  2. Start the SDK.
 *  3. Only then emit `traceys.pizzeria.funnel.step_entered` — emitting before the logs
 *     SDK exists would send it to the no-op logger provider.
 *
 * React renders immediately and does not wait on any of this; the page is
 * never blocked on telemetry.
 */
export function bootstrapPage(step: Step, Page: React.ComponentType): void {
  setOrderContext({ step, stepIndex: stepIndex(step), chaos: isChaos() });
  publishOrderContext(readCachedOrder());

  void initOtelRum({ routeId: step }).then(() => emitStepEntered(step));

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <Page />
    </React.StrictMode>
  );
}
