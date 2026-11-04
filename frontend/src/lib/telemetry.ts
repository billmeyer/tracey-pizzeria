import type { Step } from './steps';

/**
 * ── The telemetry seam ────────────────────────────────────────────────────
 * Everything the application wants to *say* about itself, declared without
 * saying how it gets said. The functions exported here are what pages,
 * components and the rest of `lib/` call; `src/rum/install.ts` supplies the
 * implementation that turns each call into an OTel span or log record.
 *
 * Two properties follow from that, and both are the point:
 *
 *  1. No application file imports `@opentelemetry` or `../rum` — the same
 *     split the three Node services already make between their handlers and
 *     their `*-instrumentation.ts` files.
 *  2. Nothing is installed by default. Every function below is a no-op until
 *     `installTelemetry` is called, so deleting `src/rum/` leaves an app that
 *     still compiles, still navigates, and simply emits nothing.
 *
 * That second property is what makes the workshop's "before" state a
 * *deletion* rather than an edit: Chapter 01 removes `src/rum/` and three
 * lines of `bootstrap.tsx`, and the diff that adds observability back is one
 * directory plus those three lines — not a hundred call sites.
 *
 * Attribute *names* still appear in application code (the
 * `traceys.pizzeria.page.*` bags passed to `usePageEntered`, the operation
 * names passed to `startOperation`). That is deliberate: the app decides
 * which facts are worth reporting, the instrumentation layer decides what
 * becomes a span, a log, or nothing at all.
 * ──────────────────────────────────────────────────────────────────────────
 */

export type TelemetryAttributes = Record<string, string | number | boolean>;

/** Extra page-level detail on a page-entered record. */
export type PageAttributes = TelemetryAttributes;

export type SessionIdListener = (sessionId: string | null) => void;

/**
 * An opaque handle on "the trace this happened in". Deliberately `unknown`:
 * the application only ever receives one from `startOperation` and hands it
 * straight back to an `emit*` call, so it has no reason to know that the RUM
 * layer's version of it is an OTel `Context`.
 */
export type TraceContext = unknown;

/**
 * The operation handed out when nothing is installed. `run` still calls `fn`
 * — the work must happen regardless — and the rest is inert.
 */
const NO_OPERATION: Operation = {
  ctx: undefined,
  run: (fn) => fn(),
  fail: () => {},
  end: () => {},
};

/**
 * ── The uninstrumented app ────────────────────────────────────────────────
 * The implementation in force until `installTelemetry` replaces it, and the
 * one the app keeps forever once `src/rum/` is deleted. So this is not an
 * error fallback or a guard against a missed init — it *is* the workshop's
 * chapter 01 "before" state, expressed as code, and the reason that chapter
 * is a deletion rather than an edit.
 *
 * Inert is not the same as empty. Three members carry real obligations, and
 * returning a bare `undefined` from any of them would break the app rather
 * than merely silence it:
 *
 *  - `startOperation` hands back `NO_OPERATION`, whose `run` still invokes
 *    its callback — every fetch in the funnel goes through one.
 *  - `flush` resolves rather than pending, because `hardNavigate` awaits it
 *    before leaving the document.
 *  - `subscribeSessionId` honours the full contract — call the listener once,
 *    return an unsubscribe — because `useSessionId` passes the result
 *    straight to `useEffect` as its cleanup.
 *
 * Typing this as `Telemetry` is what keeps the two states in step: adding a
 * method to the interface fails the build here until a no-op exists for it,
 * so the uninstrumented app cannot silently rot while nobody is running it.
 * ──────────────────────────────────────────────────────────────────────────
 */
const NO_TELEMETRY: Telemetry = {
  emitAppError: () => {},
  emitFunnelCompletedAction: () => {},
  emitPageEnteredAction: () => {},
  emitStageChangedAction: () => {},
  emitStepCompletedAction: () => {},
  emitValidationError: () => {},
  // Resolved, not pending: `hardNavigate` awaits this before leaving the
  // document, so a promise that never settles would wedge the funnel.
  flush: async () => {},
  getSessionId: () => null,
  // No attributes, so a click lands in the DOM as an ordinary click. The
  // markup stays identical either way, which is why lighting up named actions
  // for all ~12 buttons is a change to one function rather than twelve.
  namedAction: () => ({}),
  setOrderContext: () => {},
  startOperation: () => NO_OPERATION,
  // Reports "no session" once, then nothing — the footer renders "starting…"
  // and stays there, rather than waiting on an id that will never arrive.
  subscribeSessionId: (listener) => {
    listener(null);
    return () => {};
  },
};

let telemetryInstance: Telemetry = NO_TELEMETRY;

/** Order attributes stamped onto everything the page subsequently emits. */
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

/**
 * A unit of work the app wants observed, and — more importantly — something
 * to attach a later failure to.
 *
 * Callers use it the same way whether or not telemetry is installed:
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
 */
export interface Operation {
  /**
   * Handle on this operation's trace. Pass it to `emitAppError` (or any other
   * `emit*`) so the record lands in the trace whose request actually failed,
   * rather than exporting with no trace ids at all.
   */
  readonly ctx: TraceContext;
  /** Invoke `fn` inside this operation, so any fetch it starts synchronously
   *  is recorded as part of it. */
  run<T>(fn: () => T): T;
  /** Record that this operation failed. */
  fail(error: unknown): void;
  /** Finish the operation. Idempotent, and must happen before any
   *  `hardNavigate`, which flushes and tears the exporters down. */
  end(): void;
}

export interface StageChangedOptions {
  /** Human-readable stage name, e.g. "In the oven" — what the customer sees. */
  label?: string;
  /** Context of the poll that observed the transition. */
  ctx?: TraceContext;
}

/** Everything the application asks of its telemetry, in one interface. */
export interface Telemetry {
  emitAppError(
    type: string,
    error: unknown,
    extra: Record<string, string>,
    ctx?: TraceContext
  ): void;
  emitFunnelCompletedAction(outcome: string, ctx?: TraceContext): void;
  emitPageEnteredAction(step: Step, attributes: PageAttributes): void;
  emitStageChangedAction(
    stage: string,
    stageIndex: number,
    totalStages: number,
    options: StageChangedOptions
  ): void;
  emitStepCompletedAction(step: Step, nextStep: Step | null): void;
  emitValidationError(field: string, rule: string, message: string, step: Step): void;
  flush(): Promise<void>;
  getSessionId(): string | null;
  namedAction(name: string, extra: Record<string, string>): Record<string, string>;
  setOrderContext(values: OrderContextValues): void;
  startOperation(name: string, attributes?: TelemetryAttributes): Operation;
  subscribeSessionId(listener: SessionIdListener): () => void;
}

/**
 * Hand the application a real implementation. Called once, from
 * `bootstrapPage`, before anything else runs — in particular before the first
 * `setOrderContext`, which has to reach the live context to be stamped onto
 * the document's earliest events.
 */
export function installTelemetry(implementation: Telemetry): void {
  telemetryInstance = implementation;
}

export function emitAppError(
  type: string,
  error: unknown,
  extra: Record<string, string> = {},
  ctx?: TraceContext
): void {
  telemetryInstance.emitAppError(type, error, extra, ctx);
}

export function emitFunnelCompletedAction(outcome: string, ctx?: TraceContext): void {
  telemetryInstance.emitFunnelCompletedAction(outcome, ctx);
}

export function emitPageEnteredAction(step: Step, attributes: PageAttributes = {}): void {
  telemetryInstance.emitPageEnteredAction(step, attributes);
}

export function emitStageChangedAction(
  stage: string,
  stageIndex: number,
  totalStages: number,
  options: StageChangedOptions = {}
): void {
  telemetryInstance.emitStageChangedAction(stage, stageIndex, totalStages, options);
}

export function emitStepCompletedAction(step: Step, nextStep: Step | null): void {
  telemetryInstance.emitStepCompletedAction(step, nextStep);
}

export function emitValidationError(
  field: string,
  rule: string,
  message: string,
  step: Step
): void {
  telemetryInstance.emitValidationError(field, rule, message, step);
}

/** Drain the exporters. Awaited before anything that ends the document. */
export function flushTelemetry(): Promise<void> {
  return telemetryInstance.flush();
}

/** The current session id, or null before (or without) a telemetry SDK. */
export function getTelemetrySessionId(): string | null {
  return telemetryInstance.getSessionId();
}

/**
 * Props that turn a click into a *named* action rather than an anonymous CSS
 * selector. Spread onto buttons:
 *
 *   <button {...namedAction('checkout.continue_to_payment')}>Next</button>
 */
export function namedAction(
  name: string,
  extra: Record<string, string> = {}
): Record<string, string> {
  return telemetryInstance.namedAction(name, extra);
}

/** Merge values into the order context. Later events pick the new values up. */
export function setOrderContext(values: OrderContextValues): void {
  telemetryInstance.setOrderContext(values);
}

export function startOperation(name: string, attributes?: TelemetryAttributes): Operation {
  return telemetryInstance.startOperation(name, attributes);
}

/**
 * Subscribe to session id changes. Invokes `listener` immediately with the
 * current value. Returns an unsubscribe function.
 */
export function subscribeTelemetrySession(listener: SessionIdListener): () => void {
  return telemetryInstance.subscribeSessionId(listener);
}
