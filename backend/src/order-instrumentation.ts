/**
 * ── WORKSHOP EXERCISE 2 ─────────────────────────────────────────────────────
 * Manual instrumentation for the *application* — the agent's tool loop and the
 * checkout funnel — in the same shape claude-instrumentation.ts uses for the
 * LLM call: OpenTelemetry API only, no Datadog import, and nothing in here that
 * index.ts has to know about beyond the four functions it calls.
 *
 * The point of the split is visible in the diff. index.ts is the uninstrumented
 * application — an Express app and an agent loop — calling handlers in order.ts
 * and pizza.ts, each one a plain function that takes input and returns a
 * result. Adding observability to all of it is one import and four call sites
 * that go from
 *
 *     const result = await updateOrder(input, session, chaos);
 *
 * to
 *
 *     const result = await withToolSpan(block, () => updateOrder(input, session, chaos));
 *
 * and nothing else. No tracer in the handler, no `span.setAttribute` between
 * two lines of business logic, no `finally { span.end() }` wrapped around code
 * that is trying to make a pizza. order.ts and pizza.ts have no idea this file
 * exists. Delete it, unwrap those four calls, and the app is exactly what it
 * was.
 *
 * That shape is bought by one deliberate choice: the handlers *return* the
 * facts worth observing (which toppings were requested, which were in stock,
 * what the subtotal came to) instead of writing them onto a span themselves.
 * The handler's return value is its own business — this file is what decides
 * some of it is also telemetry. `toolSpanAttributes` below is where that
 * translation lives, and it is the only place that knows a pizza has toppings.
 * ────────────────────────────────────────────────────────────────────────────
 */
import {
  trace,
  SpanKind,
  SpanStatusCode,
  type Attributes,
  type Span,
} from '@opentelemetry/api';

// Same package and same /incubating entry point as claude-instrumentation.ts:
// the convention travels with the constants, not with the file that happens to
// use them. The gen_ai.tool.* group is experimental, hence /incubating rather
// than the root.
import {
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_TOOL_TYPE,
  GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
} from '@opentelemetry/semantic-conventions/incubating';

import type { ClaudeToolUse } from './claude';
// Types only, so these imports are erased at compile time — and they point at
// the handler modules rather than at index.ts, so the dependency runs one way:
// order.ts and pizza.ts know nothing about this file.
import type { UpdateOrderInput, UpdateOrderResult } from './order';
import type { ConfirmPizzaResult } from './pizza';
import type { Fulfillment, OrderState, Pricing, Receipt, Stage } from './state';

const tracer = trace.getTracer('tracey.backend');

/**
 * Attributes known from the tool call itself, before the handler runs.
 *
 * Same known-before / known-after split as claude-instrumentation.ts
 * (`requestAttributes` vs `recordResponse`), and it earns its keep on the
 * failure path: when the inventory service is down there is no result to read
 * attributes off, but `pizza.requested_toppings` is exactly what you want on
 * the error span — "which toppings was it asking about when it broke".
 */
function toolInputAttributes(block: ClaudeToolUse): Attributes {
  if (block.name === 'update_order') {
    const { toppings } = block.input as UpdateOrderInput;
    if (toppings?.length) return { 'pizza.requested_toppings': toppings };
  }
  return {};
}

/**
 * Turns a tool handler's return value into span attributes.
 *
 * This is the seam. Everything domain-specific about the telemetry — that a
 * pizza has requested and unavailable toppings, that a confirmed order has a
 * subtotal — is here rather than in the handlers, so the handlers stay
 * readable as pizza code and this file stays deletable.
 *
 * `pizza.*` is a private namespace, not a semantic convention: no OTel
 * convention describes a pizza. The gen_ai.tool.* attributes below are the
 * conventional half, and keeping the two visibly separate is the lesson —
 * conventions for what a backend can interpret, your own namespace for what
 * only your business understands.
 *
 * A `switch` rather than a lookup table because the cast per branch is the
 * honest version: the agent loop knows which handler it called, this function
 * only gets the name, and narrowing by name is where that knowledge is
 * recovered.
 */
function toolSpanAttributes(toolName: string, result: unknown): Attributes {
  switch (toolName) {
    case 'update_order': {
      const { requestedToppings, availableToppings, unavailableToppings } =
        result as UpdateOrderResult;
      // A size-or-crust-only change still gets a span — it just has no topping
      // attributes on it, rather than two empty arrays.
      if (!requestedToppings.length) return {};
      return {
        'pizza.available_toppings': availableToppings,
        'pizza.unavailable_toppings': unavailableToppings,
      };
    }
    case 'confirm_pizza': {
      const { size, crust, toppingCount, subtotal } = result as ConfirmPizzaResult;
      return {
        'pizza.size': size,
        'pizza.crust': crust,
        'pizza.topping_count': toppingCount,
        'pizza.subtotal': subtotal,
      };
    }
    default:
      return {};
  }
}

/** Records a thrown error onto a span, the same way in both wrappers below. */
function recordError(span: Span, err: unknown): void {
  span.recordException(err as Error);
  span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
}

/**
 * Runs a tool handler inside a conventional `execute_tool` span.
 *
 * The span name and all three attributes read straight off the `tool_use`
 * block, so one form covers every tool the agent ever grows — adding a third
 * tool to index.ts needs no change here unless it has attributes worth
 * recording, and then the change is one `case`.
 *
 * INTERNAL kind, because the tool runs in this process. The naming discipline
 * (`execute_tool {name}` plus gen_ai.tool.name / .call_id) is what lets an
 * LLM-aware backend stitch the agent loop back together — tie the tool call to
 * the `chat` span that requested it by call id — instead of seeing an opaque
 * span sitting under an HTTP handler. 'function' stays a literal:
 * gen_ai.tool.type has no value constants in semconv 1.43.0.
 */
export function withToolSpan<T>(block: ClaudeToolUse, call: () => Promise<T> | T): Promise<T> {
  return tracer.startActiveSpan(
    `${GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL} ${block.name}`,
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        [ATTR_GEN_AI_TOOL_NAME]: block.name,
        [ATTR_GEN_AI_TOOL_CALL_ID]: block.id,
        [ATTR_GEN_AI_TOOL_TYPE]: 'function',
        ...toolInputAttributes(block),
      },
    },
    async (span) => {
      try {
        const result = await call();
        span.setAttributes(toolSpanAttributes(block.name, result));
        return result;
      } catch (err) {
        recordError(span, err);
        // Rethrown, always: whether a failed tool call is fatal or gets handed
        // back to Claude as an error result is the application's decision, and
        // instrumentation that swallowed it would be making that decision.
        throw err;
      } finally {
        span.end();
      }
    }
  );
}

/**
 * Runs the charge-and-place step inside its own span.
 *
 * Narrower than `withToolSpan` on purpose: this one operation is worth naming,
 * so the wrapper is named too, and the attributes it needs come from the order
 * going in and the receipt coming out rather than from a translation table.
 *
 * Without this span the whole charge is just a gap inside the POST handler
 * with a kitchen call somewhere in it. With it, a decline and a kitchen outage
 * are two different error spans at two different depths, which is the
 * difference between "payment endpoint is failing" and knowing why.
 */
export function withChargeSpan(
  order: OrderState,
  pricing: Pricing,
  call: () => Promise<Receipt>
): Promise<Receipt> {
  return tracer.startActiveSpan(
    'charge_and_place_order',
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        'pizza.order_total': pricing.total,
        'pizza.tip_percent': order.tipPercent ?? 0,
        'pizza.fulfillment': order.fulfillment ?? 'unknown',
      },
    },
    async (span) => {
      try {
        const receipt = await call();
        span.setAttribute('pizza.order_number', receipt.orderNumber);
        return receipt;
      } catch (err) {
        recordError(span, err);
        throw err;
      } finally {
        span.end();
      }
    }
  );
}

/**
 * ── Annotating a span someone else started ──────────────────────────────────
 * The two functions below open no span at all. The fulfillment and status
 * endpoints are already wrapped in an Express span by the auto-instrumentation,
 * and a second span around a handler that only writes to a Map or forwards one
 * fetch would add depth and no information. What those traces are missing is
 * not structure, it's facets — so these reach for the *active* span and add
 * them.
 *
 * `?.` and not `!`: with the SDK disabled or the handler called outside a
 * request there is no active span, and telemetry is never worth a 500.
 * ────────────────────────────────────────────────────────────────────────────
 */

/** Facets the active request span by pickup vs delivery. */
export function recordFulfillment(fulfillment: Fulfillment): void {
  trace.getActiveSpan()?.setAttribute('pizza.fulfillment', fulfillment);
}

/** Facets a status poll by which order it asked about and what it got back. */
export function recordOrderStatus(orderNumber: string, stage: Stage): void {
  const span = trace.getActiveSpan();
  span?.setAttribute('pizza.order_number', orderNumber);
  span?.setAttribute('pizza.stage', stage);
}
