import type { Attributes } from '@opentelemetry/api';
import type { SpanProcessor, Span, ReadableSpan } from '@opentelemetry/sdk-trace';
import type { LogRecordProcessor, ReadWriteLogRecord } from '@opentelemetry/sdk-logs';

/**
 * ── Order context ─────────────────────────────────────────────────────────
 * A mutable bag of order attributes that gets stamped onto *every* span and
 * log record the page emits. Modelled on the Browser SDK's own
 * `createDocumentSpanProcessor` / `createDocumentLogRecordProcessor` pair
 * (which stamps `browser.document.url.full` the same way).
 *
 * Why a processor and not resource attributes: the resource is frozen when
 * the SDK starts, but the order keeps changing *within* a page view — the
 * customer picks delivery, then types a tip, then pays. A processor reads
 * the live value at emit time, so a web vital recorded before the tip was
 * entered and a click recorded after it both carry the correct total.
 *
 * In Datadog these land as attributes on every RUM view, action, resource,
 * and error, so you can facet the whole funnel by `traceys.pizzeria.fulfillment`,
 * `traceys.pizzeria.total`, topping count, and so on.
 * ──────────────────────────────────────────────────────────────────────────
 */

export interface OrderContextValues {
  /** Which funnel step this document represents: order | checkout | payment | tracking */
  step?: string;
  stepIndex?: number;
  size?: string;
  crust?: string;
  toppingCount?: number;
  toppings?: string;
  fulfillment?: string;
  tipPercent?: number;
  subtotal?: number;
  total?: number;
  orderNumber?: string;
  stage?: string;
  chaos?: boolean;
}

let current: OrderContextValues = {};

/** Merge values into the order context. Later events pick the new values up. */
export function setOrderContext(values: OrderContextValues): void {
  current = { ...current, ...values };
}

export function getOrderContext(): OrderContextValues {
  return current;
}

/**
 * Flattened, prefixed, undefined-stripped view of the context — the exact
 * attribute set written onto each span/log.
 */
export function orderContextAttributes(): Attributes {
  const raw: Record<string, string | number | boolean | undefined> = {
    'traceys.pizzeria.funnel.step': current.step,
    'traceys.pizzeria.funnel.step_index': current.stepIndex,
    'traceys.pizzeria.size': current.size,
    'traceys.pizzeria.crust': current.crust,
    'traceys.pizzeria.topping_count': current.toppingCount,
    'traceys.pizzeria.toppings': current.toppings,
    'traceys.pizzeria.fulfillment': current.fulfillment,
    'traceys.pizzeria.tip_percent': current.tipPercent,
    'traceys.pizzeria.subtotal': current.subtotal,
    'traceys.pizzeria.total': current.total,
    'traceys.pizzeria.number': current.orderNumber,
    'traceys.pizzeria.stage': current.stage,
    'traceys.pizzeria.chaos_mode': current.chaos,
  };

  const attributes: Attributes = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined && value !== null && value !== '') attributes[key] = value;
  }
  return attributes;
}

class OrderContextSpanProcessor implements SpanProcessor {
  // Stamped at onStart (matching DocumentSpanProcessor) so a span that
  // outlives a form interaction keeps the context it began with.
  onStart(span: Span): void {
    span.setAttributes(orderContextAttributes());
  }
  onEnd(_span: ReadableSpan): void {}
  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

class OrderContextLogRecordProcessor implements LogRecordProcessor {
  onEmit(logRecord: ReadWriteLogRecord): void {
    logRecord.setAttributes(orderContextAttributes());
  }
  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

export function createOrderContextSpanProcessor(): SpanProcessor {
  return new OrderContextSpanProcessor();
}

export function createOrderContextLogRecordProcessor(): LogRecordProcessor {
  return new OrderContextLogRecordProcessor();
}
