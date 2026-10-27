import './instrument'; // must be the very first import

import express from 'express';
import { trace, SpanKind } from '@opentelemetry/api';
import { isAvailable } from './menu';

const app = express();
app.use(express.json());

const tracer = trace.getTracer('tracey.inventory');

app.post('/check-stock', async (req, res) => {
  const { toppings, chaos } = req.body as { toppings: string[]; chaos?: boolean };

  const results = await tracer.startActiveSpan(
    'check_stock',
    { kind: SpanKind.INTERNAL, attributes: { 'pizza.chaos_mode': !!chaos } },
    async (span) => {
      const out = toppings.map((topping) => ({
        topping,
        available: isAvailable(topping, !!chaos),
      }));
      span.setAttribute(
        'pizza.unavailable_count',
        out.filter((r) => !r.available).length
      );
      span.end();
      return out;
    }
  );

  res.json(results);
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4001;
app.listen(PORT, () => console.log(`tracey-inventory listening on :${PORT}`));
