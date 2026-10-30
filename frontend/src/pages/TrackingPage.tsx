import { useEffect, useRef, useState } from 'react';
import KioskShell from '../components/KioskShell';
import Receipt from '../components/Receipt';
import { useOrder } from '../lib/useOrder';
import {
  fetchStatus,
  resetOrder,
  STAGE_ICONS,
  STAGE_LABELS,
  type OrderStatus,
} from '../lib/order';
import {
  emitAppError,
  emitFunnelCompletedAction,
  emitStageChangedAction,
  namedAction,
} from '../rum/events';
import { startOperation } from '../rum/operation';
import { usePageEntered } from '../rum/use-page-entered';
import { setOrderContext } from '../rum/order-context';
import { flushRum } from '../rum/otel';

const POLL_INTERVAL_MS = 3000;

export default function TrackingPage() {
  const { snapshot, hydrating } = useOrder('tracking', true);
  const [status, setStatus] = useState<OrderStatus | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const lastStage = useRef<string | null>(null);

  usePageEntered('tracking', {
    'traceys.pizzeria.page.awaiting_hydration': snapshot === null,
    // Logged so the poll cadence in the data is self-describing: a gap between
    // tracking.poll_status spans can be read against the interval that
    // produced them without going back to the source.
    'traceys.pizzeria.page.poll_interval_ms': POLL_INTERVAL_MS,
  });

  /**
   * Poll the kitchen through the backend every 3 seconds. Each poll is a
   * fetch span correlated to a backend + kitchen APM trace, so the RUM
   * session for this page shows a steady drumbeat of resources rather than
   * one page view and silence — and each stage change is its own custom
   * event you can overlay on the session timeline.
   */
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;

    async function poll() {
      // One span per poll. Everything this poll logs — the stage change, the
      // funnel completion, a failure — is emitted with op.ctx, so each record
      // carries the trace and span ids of the request that observed it rather
      // than falling back to the page-wide trace.
      //
      // op.end() is called explicitly on each exit path rather than in a
      // `finally`, because `finally` would run after flushRum() below has
      // already started shutting the SDKs down, and a span still open at that
      // point is dropped. end() is idempotent, so the repetition is safe.
      const op = startOperation('tracking.poll_status', { 'traceys.pizzeria.funnel.step': 'tracking' });
      try {
        const next = await op.run(() => fetchStatus());
        if (cancelled) {
          op.end();
          return;
        }

        setStatus(next);
        setFailure(null);
        setOrderContext({ stage: next.stage });

        // "Order received" -> "Making your pizza" -> "In the oven" ->
        // "Boxing it up" -> "Ready for pickup". One record each, on the poll
        // that first sees the new stage.
        if (lastStage.current !== next.stage) {
          lastStage.current = next.stage;
          emitStageChangedAction(next.stage, next.stageIndex, next.stages.length, {
            label: STAGE_LABELS[next.stage] ?? next.stage,
            ctx: op.ctx,
          });
        }

        if (next.complete) {
          emitFunnelCompletedAction(next.stage, op.ctx);
          // Terminal state: drain the exporters so the last stage change and
          // the funnel-completion event are not left sitting in a batch
          // whenever this tab eventually goes away. The span has to be closed
          // first or it never reaches the collector.
          op.end();
          void flushRum();
          return;
        }

        op.end();
      } catch (err) {
        op.fail(err);
        op.end();
        if (cancelled) return;
        emitAppError('OrderStatusPollError', err, { 'traceys.pizzeria.funnel.step': 'tracking' }, op.ctx);
        setFailure('Lost contact with the kitchen. Still trying…');
      }

      timer = window.setTimeout(poll, POLL_INTERVAL_MS);
    }

    void poll();

    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  if (!snapshot) {
    return (
      <KioskShell step="tracking">
        <div className="panel">{hydrating ? 'Finding your order…' : 'No order found.'}</div>
      </KioskShell>
    );
  }

  const stages = status?.stages ?? [];
  const currentIndex = status?.stageIndex ?? -1;
  const isDelivery = snapshot.order.fulfillment === 'delivery';

  return (
    <KioskShell step="tracking">
      <section className="panel">
        <h2>
          {status?.complete
            ? isDelivery
              ? 'Delivered. Go eat.'
              : 'Ready at the counter.'
            : 'Tracking your order'}
        </h2>
        <p className="panel-note">
          Order #{snapshot.order.receipt?.orderNumber} ·{' '}
          {isDelivery ? 'delivery' : 'pickup'} · ETA ~{status?.etaMinutes ?? snapshot.order.receipt?.etaMinutes} min
        </p>

        <ol className="stage-list">
          {stages.map((stage, i) => (
            <li
              key={stage}
              className={`stage ${i < currentIndex ? 'done' : ''} ${
                i === currentIndex ? 'current' : ''
              }`}
            >
              <span className="stage-icon">{i < currentIndex ? '✓' : STAGE_ICONS[stage] ?? '•'}</span>
              <span className="stage-label">{STAGE_LABELS[stage] ?? stage}</span>
              {i === currentIndex && !status?.complete && (
                <span className="stage-spinner" aria-hidden="true" />
              )}
            </li>
          ))}
        </ol>

        {!status && !failure && <p className="panel-note">Checking with the kitchen…</p>}
        {failure && <p className="banner-error">{failure}</p>}
      </section>

      {status?.complete && snapshot.order.receipt && (
        <>
          <Receipt
            orderNumber={snapshot.order.receipt.orderNumber}
            etaMinutes={snapshot.order.receipt.etaMinutes}
            size={snapshot.order.size}
            crust={snapshot.order.crust}
            toppings={snapshot.order.toppings}
            fulfillment={snapshot.order.fulfillment}
            pricing={snapshot.pricing}
          />
          <div className="action-row">
            <button
              className="primary"
              onClick={() => {
                void resetOrder()
                  .then(() => flushRum())
                  .then(() => window.location.assign('/'));
              }}
              {...namedAction('tracking.start_new_order')}
            >
              Order another
            </button>
          </div>
        </>
      )}
    </KioskShell>
  );
}
