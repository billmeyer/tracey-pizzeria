import { useEffect, useState } from 'react';
import {
  fetchOrder,
  publishOrderContext,
  readCachedOrder,
  type OrderSnapshot,
} from './order';
import { emitAppError, type Step } from '../rum/events';
import { hardNavigateBack } from '../rum/navigate';
import { startOperation } from '../rum/operation';

interface UseOrderResult {
  snapshot: OrderSnapshot | null;
  /** True until the authoritative server copy has arrived. */
  hydrating: boolean;
  setSnapshot: (snapshot: OrderSnapshot) => void;
}

/**
 * Hydrate a cold document. Paints from the sessionStorage cache first, then
 * reconciles against the server — which is also what gives each page view a
 * fetch span to correlate with a backend trace.
 *
 * A page reached without a confirmed pizza (bookmark, refresh after the
 * backend restarted, someone typing /payment/ directly) bounces back to the
 * order page rather than rendering a checkout for an order that does not
 * exist.
 */
export function useOrder(step: Step, requirePlaced = false): UseOrderResult {
  const [snapshot, setSnapshot] = useState<OrderSnapshot | null>(() => readCachedOrder());
  const [hydrating, setHydrating] = useState(true);

  useEffect(() => {
    let cancelled = false;

    // op.run parents the hydration fetch's span under this one; op.ctx is how
    // the RUM Error in the rejection handler gets trace_id/span_id, since the
    // browser SDK's synchronous context manager has long since dropped the
    // active span by the time a .catch() callback runs. Ended in both handlers
    // rather than after them, because the success path can call
    // hardNavigateBack, which flushes and shuts the SDKs down.
    const op = startOperation(`${step}.hydrate_order`, { 'traceys.pizzeria.funnel.step': step });

    op.run(() => fetchOrder())
      .then((fresh) => {
        op.end();
        if (cancelled) return;

        const unusable = !fresh.order.confirmed || (requirePlaced && !fresh.order.receipt);
        if (unusable) {
          void hardNavigateBack(step, 'order');
          return;
        }

        setSnapshot(fresh);
        publishOrderContext(fresh);
        setHydrating(false);
      })
      .catch((err) => {
        op.fail(err);
        op.end();
        if (cancelled) return;
        emitAppError('OrderHydrationError', err, { 'traceys.pizzeria.funnel.step': step }, op.ctx);
        setHydrating(false);
      });

    return () => {
      cancelled = true;
    };
  }, [step, requirePlaced]);

  return { snapshot, hydrating, setSnapshot };
}
