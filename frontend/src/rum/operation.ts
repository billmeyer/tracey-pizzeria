import {
  context,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
} from '@opentelemetry/api';

/**
 * ── Operation spans, and why log records need one ─────────────────────────
 * A log record only carries `trace_id` / `span_id` if a span is active in the
 * `Context` at `emit()` time — the SDK reads `logRecord.context ||
 * context.active()` and copies the span context off it, nothing more.
 *
 * The Browser SDK installs a *synchronous stack* context manager (no Zone, no
 * AsyncLocalStorage): `startTracesSdk` falls back to
 * `getDefaultContextManager()`, which is a single variable swapped around a
 * sync call and restored in a `finally`. So the context does not survive an
 * `await`.
 *
 * `FetchInstrumentation` activates its span only for the synchronous body of
 * its wrapper — `context.with(fetchContext, () => fetch(...).then(...))`. The
 * moment that promise yields, the active context is back to ROOT. Every
 * `emitAppError` in this app runs in a `catch` *after* an `await`, which is
 * why those RUM Errors exported with no trace ids: there was genuinely no
 * span active.
 *
 * The fix is to stop relying on ambient context and carry it explicitly:
 * start a span for the operation, keep its `Context` in a variable, run the
 * fetch inside it (so the fetch span becomes a child), and hand the same
 * `Context` to `emitAppError` so the log lands in that trace.
 *
 *   const op = startOperation('checkout.save_fulfillment');
 *   try {
 *     result = await op.run(() => saveFulfillment(...));
 *   } catch (err) {
 *     op.fail(err);
 *     emitAppError('FulfillmentSaveError', err, {...}, op.ctx);
 *   } finally {
 *     op.end();
 *   }
 *
 * `op.run()` works on async callees because an async function body runs
 * synchronously up to its first `await` — `await fetch(url)` evaluates
 * `fetch(url)` while our context is still active, which is all the fetch
 * instrumentation needs to parent its span correctly.
 * ──────────────────────────────────────────────────────────────────────────
 */

function tracer() {
  return trace.getTracer('tracey.rum.operation', '1.0.0');
}

export interface Operation {
  /**
   * Context with this operation's span active. Pass it to `emitAppError` (or
   * any other `emit*`) so the log record carries this trace's ids instead of
   * exporting bare.
   */
  readonly ctx: Context;
  /**
   * Invoke `fn` with the span active, so any fetch it starts synchronously
   * becomes a child span of this operation rather than a trace of its own.
   */
  run<T>(fn: () => T): T;
  /** Record the failure on the span, so the trace shows it too. */
  fail(error: unknown): void;
  /**
   * End the span. Idempotent, so a caller can end it on the happy path and
   * still end it unconditionally from a `catch` without tripping the SDK's
   * "span ended twice" warning.
   *
   * Must happen before any `hardNavigate`, which flushes and shuts the SDKs
   * down — an unended span is dropped.
   */
  end(): void;
}

export function startOperation(name: string, attributes?: Attributes): Operation {
  const span = tracer().startSpan(name, { attributes });
  const ctx = trace.setSpan(context.active(), span);
  let ended = false;

  return {
    ctx,
    run: (fn) => context.with(ctx, fn),
    fail: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof Error) span.recordException(error);
      span.setStatus({ code: SpanStatusCode.ERROR, message });
    },
    end: () => {
      if (ended) return;
      ended = true;
      span.end();
    },
  };
}
