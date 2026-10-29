import './instrument'; // must be the very first import

import express from 'express';
import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';

const app = express();
app.use(express.json());

const tracer = trace.getTracer('tracey.kitchen');

let orderCounter = 1000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Stage =
  | 'received'
  | 'making'
  | 'baking'
  | 'packaging'
  | 'out_for_delivery'
  | 'ready_for_pickup'
  | 'delivered'
  | 'picked_up';

// Stage pipelines diverge at the hand-off: a delivery order goes on the road,
// a pickup order just sits on the warming rack until the customer shows up.
const DELIVERY_STAGES: Stage[] = [
  'received',
  'making',
  'baking',
  'packaging',
  'out_for_delivery',
  'delivered',
];
const PICKUP_STAGES: Stage[] = ['received', 'making', 'baking', 'packaging', 'ready_for_pickup'];

// How long each stage holds before advancing. Short enough that a workshop
// demo reaches "delivered" while the presenter is still talking about it.
const STAGE_DURATION_MS = 9000;

interface TrackedOrder {
  orderNumber: string;
  fulfillment: 'pickup' | 'delivery';
  stages: Stage[];
  startedAt: number;
  etaMinutes: number;
}

const trackedOrders = new Map<string, TrackedOrder>();

/**
 * Stage is derived from elapsed wall-clock time rather than advanced by a
 * background timer, so it stays correct across restarts of the poll loop and
 * needs no cleanup beyond the map entry itself.
 */
function currentStage(order: TrackedOrder) {
  const elapsedMs = Date.now() - order.startedAt;
  const rawIndex = Math.floor(elapsedMs / STAGE_DURATION_MS);
  const stageIndex = Math.min(rawIndex, order.stages.length - 1);
  const stage = order.stages[stageIndex];

  return {
    stage,
    stageIndex,
    stages: order.stages,
    etaMinutes: order.etaMinutes,
    complete: stageIndex === order.stages.length - 1,
    elapsedMs,
  };
}

app.post('/bake', async (req, res) => {
  const { chaos, fulfillment } = req.body as {
    order: unknown;
    chaos?: boolean;
    fulfillment?: 'pickup' | 'delivery';
  };

  try {
    const receipt = await tracer.startActiveSpan(
      'bake_pizza',
      { kind: SpanKind.INTERNAL, attributes: { 'pizza.chaos_mode': !!chaos } },
      async (span) => {
        // The "slow dependency" everyone loves to debug — normal latency is
        // already noticeable; chaos mode makes it impossible to miss.
        const bakeTimeMs = chaos
          ? 4000 + Math.random() * 4000
          : 800 + Math.random() * 700;
        span.setAttribute('pizza.bake_time_ms', Math.round(bakeTimeMs));
        await sleep(bakeTimeMs);

        // Occasionally the oven jams — more often in chaos mode.
        const failureChance = chaos ? 0.15 : 0.02;
        if (Math.random() < failureChance) {
          const err = new Error('Oven jammed');
          span.recordException(err);
          span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
          span.end();
          throw err;
        }

        orderCounter += 1;
        const result = {
          orderNumber: `T-${orderCounter}`,
          etaMinutes: Math.round(bakeTimeMs / 1000 / 6) + 12,
        };

        const resolvedFulfillment = fulfillment === 'pickup' ? 'pickup' : 'delivery';
        trackedOrders.set(result.orderNumber, {
          orderNumber: result.orderNumber,
          fulfillment: resolvedFulfillment,
          stages: resolvedFulfillment === 'pickup' ? PICKUP_STAGES : DELIVERY_STAGES,
          startedAt: Date.now(),
          etaMinutes: result.etaMinutes,
        });

        span.setAttribute('pizza.order_number', result.orderNumber);
        span.setAttribute('pizza.fulfillment', resolvedFulfillment);
        span.end();
        return result;
      }
    );

    res.json(receipt);
  } catch (err) {
    res.status(500).json({ error: 'Oven jammed — try again in a minute.' });
  }
});

/**
 * Polled every few seconds by the tracking page (via the backend). Each poll
 * is its own span, so the RUM session shows a steady run of resource events
 * each correlated to an APM trace that reaches this service.
 */
app.get('/status/:orderNumber', (req, res) => {
  const order = trackedOrders.get(req.params.orderNumber);
  if (!order) {
    return res.status(404).json({ error: 'Unknown order number.' });
  }

  const status = currentStage(order);
  const span = trace.getActiveSpan();
  span?.setAttribute('pizza.order_number', order.orderNumber);
  span?.setAttribute('pizza.stage', status.stage);
  span?.setAttribute('pizza.stage_index', status.stageIndex);
  span?.setAttribute('pizza.fulfillment', order.fulfillment);

  res.json({
    orderNumber: order.orderNumber,
    fulfillment: order.fulfillment,
    stage: status.stage,
    stageIndex: status.stageIndex,
    stages: status.stages,
    etaMinutes: status.etaMinutes,
    complete: status.complete,
  });
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4002;
app.listen(PORT, () => console.log(`tracey-kitchen listening on :${PORT}`));
