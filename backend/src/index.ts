import './otel'; // must be the very first import — see otel.ts

import express from 'express';

// callClaudeWithGenAI, not the plain callClaude: the chat endpoint is the one
// the lab's traces are built around, so it takes the instrumented path. The
// uninstrumented sibling is there to be swapped in for the Section 1 exercise.
import { callClaudeWithGenAI, ClaudeMessage, ClaudeTool, ClaudeToolResult } from './claude';
import {
  getSession,
  hasSession,
  resetSession,
  Address,
  Fulfillment,
  OrderStatus,
} from './state';
import { priceOrder } from './pricing';

// The application the agent loop drives: one function per tool Claude can
// call, plus the order payload every checkout page re-hydrates from. Neither
// file imports `@opentelemetry` — see order-instrumentation.ts.
import { orderPayload, updateOrder, UpdateOrderInput } from './order';

import { confirmPizza, CONFIRM_PIZZA_SUMMARY, KITCHEN_URL } from './pizza';

import {
  applyCardDetails,
  CardDeclinedError,
  chargeAndPlaceOrder,
  clearCardDetails,
} from './payment';

// The whole of this file's observability, in one import. Every span it opens,
// every pizza.* attribute, every gen_ai.tool.* attribute lives in
// order-instrumentation.ts — this file has no `@opentelemetry` import, and
// each of the four calls below is a wrapper you can delete in one line. See
// that file's header for why it is shaped this way.
import {
  recordFulfillment,
  recordOrderStatus,
  withChargeSpan,
  withToolSpan,
} from './order-instrumentation';

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

const app = express();

// No CORS middleware, deliberately.
//
// This used to be a bare `app.use(cors())`, which answers every request with
// `Access-Control-Allow-Origin: *` — on an API that mutates orders and takes
// card numbers. It was never needed: the browser reaches `/api/*` through the
// frontend dev server's same-origin proxy (see vite.config.ts), so those
// requests are not cross-origin and never consult CORS at all.
//
// Port 4000 is published for curl and `docker compose exec`, neither of which
// enforces CORS, so nothing in the supported flow regressed by removing it.
// If a future chapter does need a browser on another origin to call this API
// directly, add `cors()` back with an explicit `origin` allowlist rather than
// the wildcard default.
app.use(express.json());

/**
 * ── Checkout funnel API ───────────────────────────────────────────────────
 * Each hard page transition lands on a fresh document that knows only its
 * sessionId, so every page re-hydrates through GET /api/order/:sessionId.
 * That GET is deliberate: it gives each new page view a real fetch span the
 * browser SDK can correlate to a backend APM trace, instead of a page view
 * with no network activity behind it.
 * ──────────────────────────────────────────────────────────────────────────
 */

/** Re-hydrate a page: the order and its pricing, for any funnel step to render. */
app.get('/api/order/:sessionId', (req, res) => {
  const { sessionId } = req.params;

  // A session that was never seen gets an empty order rather than a 404 —
  // the frontend treats "no confirmed pizza" as "go back to the order page".
  if (!hasSession(sessionId)) {
    return res.json({ ...orderPayload(sessionId), known: false });
  }
  res.json({ ...orderPayload(sessionId), known: true });
});

/**
 * Start over. Wipes the order and the chat transcript but keeps the session id,
 * so "Order another" opens a clean funnel inside the same RUM session.
 */
app.post('/api/order/:sessionId/reset', (req, res) => {
  resetSession(req.params.sessionId);
  res.json(orderPayload(req.params.sessionId));
});

/**
 * Funnel step 1 — one turn of the conversation with Tracey.
 *
 * Takes the customer's message, runs the agent loop until Claude stops asking
 * for tools, and answers with the reply plus the order as it now stands — so
 * the chat bubble and the order summary beside it update from one round trip.
 * The order lives server-side, keyed by sessionId; the browser sends no state.
 */
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
      const response = await callClaudeWithGenAI(SYSTEM_PROMPT, session.history, TOOLS);
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

      // Typed as the block, not as ClaudeMessage['content']: that indexed
      // access collapses to text-only blocks now that MessageParam is a union
      // of per-role shapes (see ClaudeToolResult in claude.ts).
      const toolResults: ClaudeToolResult[] = [];

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;

        if (block.name === 'update_order') {
          try {
            // The one instrumentation call: `updateOrder(...)` is the whole
            // uninstrumented version of this line.
            const result = await withToolSpan(block, () =>
              updateOrder(block.input as UpdateOrderInput, session, !!chaos)
            );
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: result.summary,
            });
          } catch {
            // Already recorded on the span by withToolSpan, which rethrows so
            // this decision — hand the failure back to Claude rather than fail
            // the turn — stays with the application.
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: 'Inventory check failed — tell the customer to try again.',
              is_error: true,
            });
          }
        }

        if (block.name === 'confirm_pizza') {
          await withToolSpan(block, () => confirmPizza(session));
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: CONFIRM_PIZZA_SUMMARY,
          });
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
 * Funnel step 2 — pickup or delivery, plus the address if it's delivery.
 *
 * The address is validated here rather than only in the browser: this API is
 * reachable with curl, and a delivery order with no street is not an order.
 */
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

  recordFulfillment(fulfillment);

  res.json(orderPayload(sessionId));
});

/**
 * Funnel step 3 — take the card and place the order. The only endpoint that
 * reaches the kitchen, and the only one that can fail in two different ways:
 * 402 when the card is declined (retry with another), 502 when the kitchen is
 * unreachable (nothing was charged). Both are deliberate demo material.
 */
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

  if (!applyCardDetails(session, cardNumber, tipPercent)) {
    return res.status(400).json({ error: 'Card number must be 16 digits.' });
  }

  const pricing = priceOrder(session.order);

  try {
    // Same one-line shape as the tool calls: `chargeAndPlaceOrder(session,
    // !!chaos)` is the uninstrumented version.
    const receipt = await withChargeSpan(session.order, pricing, () =>
      chargeAndPlaceOrder(session, !!chaos)
    );

    session.order.receipt = receipt;
    res.json({ ...orderPayload(sessionId), receipt });
  } catch (err) {
    const declined = err instanceof CardDeclinedError;
    clearCardDetails(session);
    res.status(declined ? 402 : 502).json({
      error: declined
        ? 'Card declined — try a different card.'
        : 'The kitchen is not responding. Your card was not charged.',
      code: declined ? 'card_declined' : 'kitchen_unavailable',
    });
  }
});

/**
 * Funnel step 4 — how the bake is going, proxied from the kitchen.
 *
 * The tracking page polls this every few seconds, which is what gives the RUM
 * session a steady run of fetches each correlated to a trace that crosses two
 * services. Session-scoped rather than taking an order number, so a customer
 * can only ever poll their own order.
 */
app.get('/api/order/:sessionId/status', async (req, res) => {
  const { sessionId } = req.params;
  const session = getSession(sessionId);
  const orderNumber = session.order.receipt?.orderNumber;

  if (!orderNumber) {
    return res.status(409).json({ error: 'This order has not been placed yet.' });
  }

  try {
    const upstream = await fetch(`${KITCHEN_URL}/status/${orderNumber}`);
    if (!upstream.ok) throw new Error(`kitchen returned ${upstream.status}`);
    const status = (await upstream.json()) as OrderStatus;

    recordOrderStatus(orderNumber, status.stage);

    res.json(status);
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Cannot reach the kitchen for a status update.' });
  }
});

// Liveness probe for Compose's healthcheck (see compose.yaml), which gates
// startup order. Its spans are dropped at the Collector rather than here —
// polled every few seconds by three services, they would otherwise be most of
// the trace volume. See collector-config.yaml's filter/healthz.
app.get('/healthz', (_req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`tracey-backend listening on :${PORT}`));
