import { trace, type SpanContext } from '@opentelemetry/api';
import type { LogRecordProcessor, ReadWriteLogRecord } from '@opentelemetry/sdk-logs';

/**
 * ── Why most log records have no trace ids, and what this does about it ───
 * A log record's `trace_id` / `span_id` come from one place only: the span
 * active in the `Context` at `emit()` time. The SDK reads
 * `logRecord.context || context.active()` and copies the span context off it.
 *
 * Almost nothing this app emits is inside a span:
 *
 *   - `traceys.pizzeria.funnel.*`, `traceys.pizzeria.stage_changed`, validation `exception`s —
 *     emitted from click handlers and effects. No span exists; there is no
 *     network call to hang one off.
 *   - `browser.user_action.click`, `browser.web_vital`,
 *     `browser.navigation_timing`, `browser.resource_timing`, console records
 *     — emitted by the auto-instrumentations from DOM and
 *     PerformanceObserver callbacks, at root context.
 *   - Anything in a `catch` after an `await`. The Browser SDK installs a
 *     *synchronous stack* context manager (`getDefaultContextManager`), so
 *     context does not survive a microtask boundary. `FetchInstrumentation`
 *     activates its span only for the synchronous body of its wrapper.
 *
 * So the default outcome is empty trace ids on effectively every RUM log
 * event, which is what the collector's debug exporter shows.
 *
 * The fix is to give each *document* a trace of its own and attach every
 * otherwise-unparented log record to it. `startPageTrace` opens a marker
 * span, and the processor below fills in `spanContext` on any record that
 * does not already have one — so a record emitted inside a real operation
 * (see operation.ts) keeps its own, more specific trace, and everything else
 * falls back to the page view.
 *
 * Trade-off worth knowing: this *synthesises* correlation rather than
 * discovering it. A click and a web vital sharing a trace id means "same page
 * view", not "same causal operation" — the honest unit of causality for those
 * events. The marker span also ends immediately rather than on unload: a span
 * left open until `pagehide` would carry a real time-on-page duration, but
 * would never export if the tab is closed outright, leaving every log record
 * pointing at a trace that does not exist. Guaranteed export beats a duration
 * that `browser.navigation_timing` already measures.
 * ──────────────────────────────────────────────────────────────────────────
 */

let pageSpanContext: SpanContext | undefined;

/**
 * Open (and immediately close) this document's root span.
 *
 * Call ordering is constrained at both ends:
 *  - after `startTracesSdk`, or there is no real tracer and the recorded
 *    context is the non-recording default;
 *  - after `await sessionManager.start()`, because starting a span reads
 *    `getSessionId()`, which mints and persists a new session if the restore
 *    has not resolved yet. See the comment at the call site in otel-rum.ts.
 */
export function startPageTrace(routeId: string): SpanContext {
  const span = trace
    .getTracer('tracey.rum.page', '1.0.0')
    .startSpan('browser.document', { attributes: { 'traceys.pizzeria.route.id': routeId } });
  span.end();

  pageSpanContext = span.spanContext();
  return pageSpanContext;
}

export function getPageSpanContext(): SpanContext | undefined {
  return pageSpanContext;
}

class PageTraceLogRecordProcessor implements LogRecordProcessor {
  onEmit(logRecord: ReadWriteLogRecord): void {
    // Only fill the gap. A record emitted inside an operation span — or one
    // handed an explicit context by `emitAppError` — already has the trace
    // that actually caused it, and that is strictly better than the page's.
    if (logRecord.spanContext) return;
    if (pageSpanContext) logRecord.spanContext = pageSpanContext;
  }
  async forceFlush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

export function createPageTraceLogRecordProcessor(): LogRecordProcessor {
  return new PageTraceLogRecordProcessor();
}
