import './otel'; // must be the very first import

import express from 'express';

import { checkStock } from './stock';
// The whole of this file's observability, in one import. The span, its name and
// both attributes live in instrumentation.ts — this file has no
// `@opentelemetry` import, and the one call below is a wrapper you can delete
// in a line. See that file's header for why it is shaped this way.
import { withCheckStockSpan } from './instrumentation';

const app = express();
app.use(express.json());

/**
 * Is the pizzeria out of anything?
 *
 * Answers one availability verdict per requested topping, in the order asked.
 * Called by the backend while Claude is mid-tool-call, so it is the first hop
 * away from the agent loop — and the reason an "add pineapple" turn produces a
 * trace that spans two services. Pineapple is always out; everything else has a
 * small baseline chance that climbs in chaos mode (see menu.ts).
 */
app.post('/check-stock', (req, res) => {
  const { toppings, chaos } = req.body as { toppings: string[]; chaos?: boolean };

  const results = withCheckStockSpan(!!chaos, () => checkStock(toppings, !!chaos));

  res.json(results);
});

// Liveness probe for Compose's healthcheck (see compose.yaml), which gates
// startup order. Its spans are dropped at the Collector rather than here —
// polled every few seconds by three services, they would otherwise be most of
// the trace volume. See collector-config.yaml's filter/healthz.
app.get('/healthz', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4001;
app.listen(PORT, () => console.log(`tracey-inventory listening on :${PORT}`));
