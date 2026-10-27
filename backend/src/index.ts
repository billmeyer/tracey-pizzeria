import './instrument'; // must be the very first import — see instrument.ts

import express from 'express';
import cors from 'cors';
import { trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
// Same package and same /incubating entry point as claude.ts: the convention
// travels with the constants, not with the file that happens to use them. The
// gen_ai.tool.* group is experimental, hence /incubating rather than the root.
import {
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_TOOL_TYPE,
  GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
} from '@opentelemetry/semantic-conventions/incubating';
import { callClaude, ClaudeMessage, ClaudeTool } from './claude';
import { getSession, hasSession, resetSession, Address, Fulfillment } from './state';
import { priceOrder } from './pricing';

const app = express();
app.use(cors());
app.use(express.json());

const tracer = trace.getTracer('tracey.backend');

const INVENTORY_URL = process.env.INVENTORY_URL || 'http://inventory-service:4001';
const KITCHEN_URL = process.env.KITCHEN_URL || 'http://kitchen-service:4002';

const SYSTEM_PROMPT = `
You are Tracey, the fast-talking, mildly sarcastic AI order-taker at Tracey's Pizzeria.
Take the customer's order conversationally. Use the update_order tool whenever the
customer specifies a size, crust, or toppings — even partial info. Use the confirm_pizza
tool only when the customer says they're done building the pizza. That tool does NOT
charge them or send anything to the kitchen — it just locks in the pizza and unlocks the
checkout screen, where they'll choose pickup or delivery and pay. So after calling it,
tell them to hit the Checkout button; never claim the order is placed or give an ETA.
If a topping comes back unavailable, tell the customer with personality and suggest
an alternative. Never quote prices, subtotals, or totals — money is shown on the
checkout and payment screens, not in the chat. Keep replies short — one or two
sentences, kiosk-screen length.
`.trim();

const TOOLS: ClaudeTool[] = [
  {
    name: 'update_order',
    description: "Add or update the customer's pizza order details.",
    input_schema: {
      type: 'object',
      properties: {
        size: { type: 'string', enum: ['small', 'medium', 'large', 'xlarge'] },
        crust: { type: 'string', enum: ['thin', 'regular', 'deep'] },
        toppings: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'confirm_pizza',
    description:
      "Lock in the pizza the customer has built and unlock the checkout screen. Does not charge the customer or send anything to the kitchen — payment happens on the checkout and payment pages.",
    input_schema: { type: 'object', properties: {} },
  },
];

async function checkStock(toppings: string[], chaos: boolean) {
  const res = await fetch(`${INVENTORY_URL}/check-stock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ toppings, chaos }),
  });
  if (!res.ok) throw new Error(`inventory-service returned ${res.status}`);
  return (await res.json()) as { topping: string; available: boolean }[];
}

async function bakePizza(order: unknown, chaos: boolean, fulfillment: Fulfillment) {
  const res = await fetch(`${KITCHEN_URL}/bake`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ order, chaos, fulfillment }),
  });
  if (!res.ok) throw new Error(`kitchen-service returned ${res.status}`);
  return (await res.json()) as { orderNumber: string; etaMinutes: number };
}

app.post('/api/chat', async (req, res) => {
  const { sessionId, message, chaos } = req.body as {
    sessionId: string;
    message: string;
    chaos?: boolean;
  };

  if (!sessionId || !message) {
    return res.status(400).json({ error: 'sessionId and message are required' });
  }

  const session = getSession(sessionId);
  session.history.push({ role: 'user', content: message });

  try {
    // Collect text from *every* round, not just the final one. Claude
    // routinely emits a text block alongside a tool_use block ("Got it,
    // locking that in." + confirm_pizza), and that turn's stop_reason is
    // `tool_use` — so reading text only from the non-tool_use round throws
    // the reply away and leaves the customer with the "I got a little lost"
    // fallback even though the tool ran fine.
    const textParts: string[] = [];
    const MAX_TOOL_ROUNDS = 4;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await callClaude(SYSTEM_PROMPT, session.history, TOOLS);
      session.history.push({ role: 'assistant', content: response.content });

      const roundText = response.content
        .filter((block) => block.type === 'text')
        .map((block) => (block as { text: string }).text)
        .join(' ')
        .trim();
      if (roundText) textParts.push(roundText);

      if (response.stop_reason !== 'tool_use') {
        break;
      }

      const toolResults: ClaudeMessage['content'] = [];

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        if (block.name === 'update_order') {
          await tracer.startActiveSpan(
            // Conventional tool span. Same tracer, same body, same INTERNAL
            // kind as the old 'tool.update_order' name — the only change is a
            // naming discipline, and it is what lets an LLM-aware backend
            // reconstruct the agent loop instead of seeing an opaque span.
            // 'function' stays a literal: gen_ai.tool.type has no value
            // constants in semconv 1.43.0.
            `${GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL} ${block.name}`,
            {
              kind: SpanKind.INTERNAL,
              attributes: {
                [ATTR_GEN_AI_TOOL_NAME]: block.name,
                [ATTR_GEN_AI_TOOL_CALL_ID]: block.id,
                [ATTR_GEN_AI_TOOL_TYPE]: 'function',
              },
            },
            async (span) => {
              try {
                const input = block.input as {
                  size?: string;
                  crust?: string;
                  toppings?: string[];
                };
                if (input.size) session.order.size = input.size as any;
                if (input.crust) session.order.crust = input.crust as any;

                let summary = 'Order updated.';
                if (input.toppings?.length) {
                  span.setAttribute('pizza.requested_toppings', input.toppings);
                  const stockResults = await checkStock(input.toppings, !!chaos);
                  const available = stockResults.filter((s) => s.available).map((s) => s.topping);
                  const unavailable = stockResults.filter((s) => !s.available).map((s) => s.topping);

                  session.order.toppings.push(...available);
                  session.order.unavailableToppings.push(...unavailable);

                  span.setAttribute('pizza.available_toppings', available);
                  span.setAttribute('pizza.unavailable_toppings', unavailable);

                  summary = `Added: ${available.join(', ') || 'none'}.${
                    unavailable.length ? ` Unavailable: ${unavailable.join(', ')}.` : ''
                  }`;
                }

                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: block.id,
                  content: summary,
                });
              } catch (err) {
                span.recordException(err as Error);
                span.setStatus({ code: SpanStatusCode.ERROR });
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: block.id,
                  content: 'Inventory check failed — tell the customer to try again.',
                  is_error: true,
                });
              } finally {
                span.end();
              }
            }
          );
        }

        // Confirming the pizza no longer touches the kitchen — it only flips
        // the gate that lets the frontend hard-navigate to /checkout/. The
        // kitchen call moved to POST /api/order/:sessionId/payment, so the
        // bake happens when the customer actually pays.
        if (block.name === 'confirm_pizza') {
          await tracer.startActiveSpan(
            // Identical shape to update_order above — the conventional
            // attributes all read off `block`, so one form covers every tool.
            `${GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL} ${block.name}`,
            {
              kind: SpanKind.INTERNAL,
              attributes: {
                [ATTR_GEN_AI_TOOL_NAME]: block.name,
                [ATTR_GEN_AI_TOOL_CALL_ID]: block.id,
                [ATTR_GEN_AI_TOOL_TYPE]: 'function',
              },
            },
            async (span) => {
              session.order.confirmed = true;
              const pricing = priceOrder(session.order);
              span.setAttribute('pizza.size', session.order.size ?? 'medium');
              span.setAttribute('pizza.crust', session.order.crust ?? 'regular');
              span.setAttribute('pizza.topping_count', session.order.toppings.length);
              span.setAttribute('pizza.subtotal', pricing.subtotal);

              // The subtotal stays on the span for APM/RUM faceting but is
              // deliberately kept out of the tool result: pricing is not
              // shown anywhere on the order view, and handing Claude a
              // number is the surest way to have it quoted in the chat.
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content:
                  'Pizza locked in. The checkout screen is now unlocked. Reply with one short line telling the customer to tap Checkout to choose pickup or delivery. Do not mention any prices or totals.',
              });
              span.end();
            }
          );
        }
      }

      session.history.push({ role: 'user', content: toolResults });
    }

    res.json({
      reply:
        textParts.join(' ') ||
        (session.order.confirmed
          ? "You're all set — tap Checkout to pick pickup or delivery."
          : "Sorry, I got a little lost — can you say that again?"),
      order: session.order,
      pricing: priceOrder(session.order),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong talking to Tracey.' });
  }
});

/**
 * ── Checkout funnel API ───────────────────────────────────────────────────
 * Each hard page transition lands on a fresh document that knows only its
 * sessionId, so every page re-hydrates through GET /api/order/:sessionId.
 * That GET is deliberate: it gives each new page view a real fetch span the
 * browser SDK can correlate to a backend APM trace, instead of a page view
 * with no network activity behind it.
 * ──────────────────────────────────────────────────────────────────────────
 */

function orderPayload(sessionId: string) {
  const session = getSession(sessionId);
  return { order: session.order, pricing: priceOrder(session.order) };
}

app.get('/api/order/:sessionId', (req, res) => {
  const { sessionId } = req.params;

  // A session that was never seen gets an empty order rather than a 404 —
  // the frontend treats "no confirmed pizza" as "go back to the order page".
  if (!hasSession(sessionId)) {
    return res.json({ ...orderPayload(sessionId), known: false });
  }
  res.json({ ...orderPayload(sessionId), known: true });
});

app.post('/api/order/:sessionId/reset', (req, res) => {
  resetSession(req.params.sessionId);
  res.json(orderPayload(req.params.sessionId));
});

app.post('/api/order/:sessionId/fulfillment', (req, res) => {
  const { sessionId } = req.params;
  const { fulfillment, address } = req.body as {
    fulfillment?: Fulfillment;
    address?: Address | null;
  };

  if (fulfillment !== 'pickup' && fulfillment !== 'delivery') {
    return res.status(400).json({ error: "fulfillment must be 'pickup' or 'delivery'" });
  }
  if (fulfillment === 'delivery') {
    const missing = !address?.street?.trim() || !address?.city?.trim() || !address?.zip?.trim();
    if (missing) {
      return res
        .status(400)
        .json({ error: 'A delivery order needs a street, city, and ZIP.' });
    }
  }

  const session = getSession(sessionId);
  session.order.fulfillment = fulfillment;
  session.order.address = fulfillment === 'delivery' ? (address as Address) : null;

  const span = trace.getActiveSpan();
  span?.setAttribute('pizza.fulfillment', fulfillment);

  res.json(orderPayload(sessionId));
});

app.post('/api/order/:sessionId/payment', async (req, res) => {
  const { sessionId } = req.params;
  const { cardNumber, tipPercent, chaos } = req.body as {
    cardNumber?: string;
    tipPercent?: number;
    chaos?: boolean;
  };

  const session = getSession(sessionId);
  if (!session.order.fulfillment) {
    return res.status(409).json({ error: 'Choose pickup or delivery before paying.' });
  }

  const digits = (cardNumber ?? '').replace(/\D/g, '');
  if (digits.length !== 16) {
    return res.status(400).json({ error: 'Card number must be 16 digits.' });
  }

  session.order.tipPercent = typeof tipPercent === 'number' ? tipPercent : 0;
  session.order.payment = {
    method: 'card',
    last4: digits.slice(-4),
    tipPercent: session.order.tipPercent,
  };

  const pricing = priceOrder(session.order);

  try {
    const receipt = await tracer.startActiveSpan(
      'charge_and_place_order',
      { kind: SpanKind.INTERNAL },
      async (span) => {
        span.setAttribute('pizza.order_total', pricing.total);
        span.setAttribute('pizza.tip_percent', session.order.tipPercent ?? 0);
        span.setAttribute('pizza.fulfillment', session.order.fulfillment!);

        // Chaos mode declines roughly one card in three, so the payment page
        // has a reliable way to produce a RUM error on demand.
        if (chaos && Math.random() < 0.34) {
          const err = new Error('Card declined by issuer');
          span.recordException(err);
          span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
          span.end();
          throw err;
        }

        try {
          const baked = await bakePizza(
            session.order,
            !!chaos,
            session.order.fulfillment!
          );
          span.setAttribute('pizza.order_number', baked.orderNumber);
          span.end();
          return baked;
        } catch (err) {
          span.recordException(err as Error);
          span.setStatus({ code: SpanStatusCode.ERROR });
          span.end();
          throw err;
        }
      }
    );

    session.order.receipt = receipt;
    res.json({ ...orderPayload(sessionId), receipt });
  } catch (err) {
    const declined = (err as Error).message.includes('declined');
    session.order.payment = null;
    res.status(declined ? 402 : 502).json({
      error: declined
        ? 'Card declined — try a different card.'
        : 'The kitchen is not responding. Your card was not charged.',
      code: declined ? 'card_declined' : 'kitchen_unavailable',
    });
  }
});

app.get('/api/order/:sessionId/status', async (req, res) => {
  const { sessionId } = req.params;
  const session = getSession(sessionId);
  const orderNumber = session.order.receipt?.orderNumber;

  if (!orderNumber) {
    return res.status(409).json({ error: 'This order has not been placed yet.' });
  }

  try {
    const upstream = await fetch(`${KITCHEN_URL}/status/${orderNumber}`);
    if (!upstream.ok) throw new Error(`kitchen-service returned ${upstream.status}`);
    const status = await upstream.json();

    const span = trace.getActiveSpan();
    span?.setAttribute('pizza.order_number', orderNumber);
    span?.setAttribute('pizza.stage', (status as { stage: string }).stage);

    res.json(status);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Cannot reach the kitchen for a status update.' });
  }
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`tracey-backend listening on :${PORT}`));
