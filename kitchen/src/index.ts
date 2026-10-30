import './otel'; // must be the very first import

import express from 'express';

import { bakePizza, orderStatus, type Fulfillment } from './oven';
// The whole of this file's observability, in one import. Both spans, every
// pizza.* attribute and the error recording live in instrumentation.ts — this
// file has no `@opentelemetry` import, and each of the two calls below is a
// wrapper you can delete in a line. See that file's header for why.
import { recordOrderStatus, withBakeSpan } from './instrumentation';

const app = express();
app.use(express.json());

/**
 * Place an order: bake the pizza and start tracking it.
 *
 * Called once per order, by the backend's payment endpoint rather than at
 * confirm time — so nothing reaches the kitchen until the card clears. Answers
 * with the receipt the customer sees (order number and ETA), or 500 when the
 * oven jams.
 *
 * This is the deliberately slow dependency the workshop debugs: the bake takes
 * roughly a second normally and up to eight in chaos mode, which is what makes
 * it the obvious long bar in the trace waterfall.
 */
app.post('/bake', async (req, res) => {
  const { chaos, fulfillment } = req.body as {
    order: unknown;
    chaos?: boolean;
    fulfillment?: Fulfillment;
  };

  try {
    const { orderNumber, etaMinutes } = await withBakeSpan(!!chaos, () =>
      bakePizza(!!chaos, fulfillment)
    );

    // Destructured rather than returned whole: the bake time and fulfillment on
    // a BakeResult are for the span, and the receipt the backend expects is
    // these two fields.
    res.json({ orderNumber, etaMinutes });
  } catch (err) {
    res.status(500).json({ error: 'Oven jammed — try again in a minute.' });
  }
});

/**
 * How far along is this order? The stage the customer's tracking page draws.
 *
 * Polled every few seconds by the tracking page (via the backend), so each poll
 * is its own span and the RUM session shows a steady run of resource events,
 * each correlated to an APM trace that reaches this service. 404 for an order
 * this kitchen has never heard of — the map is in-memory, so a restart loses
 * every order in flight.
 */
app.get('/status/:orderNumber', (req, res) => {
  const status = orderStatus(req.params.orderNumber);
  if (!status) {
    return res.status(404).json({ error: 'Unknown order number.' });
  }

  recordOrderStatus(status);

  res.json(status);
});

// Liveness probe for Compose's healthcheck (see compose.yaml), which gates
// startup order. Its spans are dropped at the Collector rather than here —
// polled every few seconds by three services, they would otherwise be most of
// the trace volume. See collector-config.yaml's filter/healthz.
app.get('/healthz', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4002;
app.listen(PORT, () => console.log(`tracey-kitchen listening on :${PORT}`));
