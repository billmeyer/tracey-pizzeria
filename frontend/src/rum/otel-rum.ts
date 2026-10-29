import {SeverityNumber} from '@opentelemetry/api-logs';
import type {LogRecord} from '@opentelemetry/api-logs';
import {registerInstrumentations} from '@opentelemetry/instrumentation';
import {startLogsSdk} from '@opentelemetry/browser-sdk/logs';
import {startTracesSdk} from '@opentelemetry/browser-sdk/traces';
import { browserDetector } from '@opentelemetry/opentelemetry-browser-detector';
import {
    detectResources,
    resourceFromAttributes,
} from '@opentelemetry/resources';

import {
    ATTR_SERVICE_NAME,
    ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

// The browser.* and session.* conventions are still experimental, so — like
// gen_ai.* on the backend — their constants live behind the package's
// `/incubating` entry point rather than the stable root above.
// EVENT_SESSION_START / _END are the conventional *event names*, not
// attribute keys: "session.start" / "session.end".
import {
    ATTR_BROWSER_DOCUMENT_URL_FULL,
    ATTR_SESSION_ID,
    EVENT_SESSION_END,
    EVENT_SESSION_START,
} from '@opentelemetry/semantic-conventions/incubating';

import {
    ConsoleLogRecordExporter,
    SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';

import {
    ConsoleSpanExporter,
    SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace';

import {
    createDefaultSessionIdGenerator,
    createLocalStorageSessionStore,
    createSessionLogRecordProcessor,
    createSessionManager,
    createSessionSpanProcessor,
} from '@opentelemetry/browser-sdk/session';

import {
    createDocumentLogRecordProcessor,
    createDocumentSpanProcessor,
    createLocationDocumentProvider
} from "@opentelemetry/browser-sdk/document";

import type {SessionManager} from '@opentelemetry/browser-sdk/session';
import {ConsoleInstrumentation} from "@opentelemetry/browser-instrumentation/experimental/console";
import {ErrorsInstrumentation} from '@opentelemetry/browser-instrumentation/experimental/errors';
import {FetchInstrumentation} from '@opentelemetry/browser-instrumentation/experimental/fetch';
import {InstrumentationBase} from '@opentelemetry/instrumentation';
import {NavigationInstrumentation} from '@opentelemetry/browser-instrumentation/experimental/navigation';
import {NavigationTimingInstrumentation} from '@opentelemetry/browser-instrumentation/experimental/navigation-timing';
import {ResourceTimingInstrumentation} from "@opentelemetry/browser-instrumentation/experimental/resource-timing";
import {UserActionInstrumentation} from '@opentelemetry/browser-instrumentation/experimental/user-action';
import {WebVitalsInstrumentation} from '@opentelemetry/browser-instrumentation/experimental/web-vitals';
import { XhrInstrumentation } from '@opentelemetry/browser-instrumentation/experimental/xhr';

import {
    createOrderContextLogRecordProcessor,
    createOrderContextSpanProcessor,
} from './order-context';
import {
    createPageTraceLogRecordProcessor,
    startPageTrace,
} from './page-trace';
import { notifySessionReady, registerSessionManager } from './session';
import type {Step} from './events';

// Per the Datadog RUM x OTel integration guide's Session Management section:
// expire after 4h of continuous activity or 15 min of inactivity.
const SESSION_MAX_DURATION_SECONDS = 4 * 60 * 60;
const SESSION_INACTIVITY_TIMEOUT_SECONDS = 15 * 60;

// Tightened from the SDK defaults (5000 traces / 1000 logs). With hard page
// transitions a document can be only a few seconds old when the customer
// clicks through, so a long scheduled delay means more telemetry riding on
// the pre-navigation flush than necessary.
const TRACES_SCHEDULED_DELAY_MS = 2000;
const LOGS_SCHEDULED_DELAY_MS = 1000;

/**
 * URLs `ResourceTimingInstrumentation` must not report on.
 *
 * The OTLP endpoints are the important entry, and not merely for tidiness:
 * every export POST is itself a resource, so exporting log records creates
 * `browser.resource_timing` records *describing that export*, which fill the
 * next batch, which exports, which creates more. Left unfiltered it is a
 * self-sustaining feedback loop — 1,735 of the 6,266 log records in one
 * session were /v1/logs POSTs describing earlier /v1/logs POSTs.
 *
 * The dev-server entries are a different problem: Vite serves every module
 * unbundled, so one page load reports ~100 script resources that simply do
 * not exist in a production build. Filtering them only under `DEV` keeps dev
 * telemetry shaped like production telemetry, rather than teaching people to
 * read a resource waterfall that is an artifact of the dev server. A real
 * production build still reports its actual bundles.
 */
const RESOURCE_TIMING_IGNORE_URLS: RegExp[] = [
    /\/v1\/(traces|logs|metrics)(\?|$)/,
    ...(import.meta.env.DEV
        ? [/\/node_modules\//, /\/@vite\//, /\/@react-refresh/, /\/src\/.+\.(ts|tsx|css)(\?|$)/]
        : []),
];

/**
 * Session lifecycle -> event_name "session.start" / "session.end" -> Datadog RUM Session
 * Mirrors the other browser-instrumentation classes below, but wraps the
 * OTel-native SessionManager (which has no built-in instrumentation of its
 * own) so session.start/end show up alongside the rest of the RUM event
 * taxonomy in one place.
 *
 * Note this is also what proves the hard page transitions are *one* session:
 * the session id lives in localStorage, so step 2/3/4 restore the same
 * session rather than starting a new one, and only the first document emits
 * session.start.
 */
class SessionInstrumentation extends InstrumentationBase {
    private readonly sessionManager: SessionManager;
    private enabled = false;

    constructor(sessionManager: SessionManager) {
        // enabled: false — InstrumentationBase's constructor calls enable()
        // synchronously during super(), before this.sessionManager below is
        // assigned. Defer enabling until the field is actually set.
        super('tracey.rum.session', '1.0.0', {enabled: false});
        this.sessionManager = sessionManager;
        this.enable();
    }

    init() {
        return [];
    }

    enable() {
        if (this.enabled) return;

        this.enabled = true;

        console.log(`adding observer to session manager`)
        this.sessionManager.addObserver({
            onSessionStarted: (session) => {
                console.log(`session started: ${JSON.stringify(session)}`);
                this.logger.emit({
                    eventName: EVENT_SESSION_START,
                    severityNumber: SeverityNumber.INFO,
                    attributes: {[ATTR_SESSION_ID]: session.id},
                });
            },
            onSessionEnded: (session) => {
                console.log(`session ended: ${JSON.stringify(session)}`);
                this.logger.emit({
                    eventName: EVENT_SESSION_END,
                    severityNumber: SeverityNumber.INFO,
                    attributes: {[ATTR_SESSION_ID]: session.id},
                });
            },
        });
    }

    disable() {
        this.enabled = false;
    }
}

/**
 * Promote the `data-otel-action-name` DOM attribute that
 * `UserActionInstrumentation` collected into a first-class attribute.
 *
 * The instrumentation copies every `data-otel-*` attribute off the clicked
 * element into the nested `browser.element.attributes` map (stripping the
 * `data-otel-` prefix). Nested maps are awkward to facet on, so lift the
 * action name up to `traceys.pizzeria.action.name`. That turns "click on
 * `div#root>div>button:nth-of-type(2)`" into "click on
 * `payment.place_order`" when you group RUM actions.
 */
function promoteNamedAction(logRecord: LogRecord): void {
    const attributes = logRecord.attributes as Record<string, unknown> | undefined;
    if (!attributes) return;

    const elementAttributes = attributes['browser.element.attributes'] as
        | Record<string, string>
        | undefined;
    const actionName = elementAttributes?.['action-name'];
    if (actionName) attributes['traceys.pizzeria.action.name'] = actionName;
}

export interface InitOtelRumOptions {
    /** Which funnel document this is. Becomes `traceys.pizzeria.route.id` on navigation events. */
    routeId: Step;
}

export interface RumHandle {
    shutdown(): Promise<void>;
}

let activeSdks: RumHandle[] = [];

/**
 * ── OTel-native RUM (replaces @datadog/browser-rum) ─────────────────────
 * Sends OTLP logs + spans straight from the browser to the collector's
 * OTLP receiver (see collector-config.yaml's `otlp` pipeline,
 * which forwards to Datadog's OTLP intake instead of the `datadog` native
 * exporter — the latter doesn't route to RUM).
 *
 * Every emitted event must carry, per the guide's "Required Fields":
 *   - session.id            -> attached to every span/log by the session
 *                               processors below
 *   - datadog.application.id -> resource attribute, set once at init
 *   - event_name             -> set by each auto-instrumentation
 *   - telemetry.sdk.name / telemetry.sdk.language
 *                            -> added automatically by the Browser SDK's
 *                               default resource ("opentelemetry" / "webjs")
 * Plus the "Strongly Recommended" browser.document.url.full, which the
 * document provider below keeps current.
 *
 * This runs once per *document*. The app uses hard page transitions
 * (location.assign) rather than client-side routing, so each funnel step is
 * a real browser navigation: its own unload/load, its own
 * `browser.navigation_timing`, its own Core Web Vitals — all stitched into
 * one RUM session by the localStorage-backed session id.
 * ─────────────────────────────────────────────────────────────────────────
 */
export async function initOtelRum(options: InitOtelRumOptions): Promise<void> {
    const applicationId = import.meta.env.VITE_DD_RUM_APPLICATION_ID || 'YOUR_RUM_APPLICATION_ID';
    const collectorUrl = import.meta.env.VITE_OTEL_COLLECTOR_URL || 'http://localhost:4318';
    const serviceName = import.meta.env.VITE_OTEL_SERVICE_NAME || 'tracey-frontend';
    const serviceVersion = import.meta.env.VITE_OTEL_SERVICE_VERSION || '0.0.1';

    // ── Resource detection ──────────────────────────────────────────────────────
    // browserDetector contributes user_agent.original and browser.language,
    // plus browser.platform/brands/mobile where navigator.userAgentData is
    // supported. It reads those synchronously, so there are no async resource
    // attributes to wait on here.
    const resource = resourceFromAttributes({
        [ATTR_SERVICE_NAME]: serviceName,
        [ATTR_SERVICE_VERSION]: serviceVersion,
    }).merge(detectResources({ detectors: [browserDetector] }));

    // Both SDKs take a plain attribute bag rather than a Resource, and freeze
    // it when they start — so the detected resource has to be flattened in
    // here or it never reaches an exported span or log. App-specific
    // attributes come last so they win any key collision.
    const resourceAttributes = {
        ...resource.attributes,
        'datadog.application.id': applicationId,
        [ATTR_BROWSER_DOCUMENT_URL_FULL]: window.location.href,
        // Stable identifier for the document, independent of the URL, so the
        // four steps are comparable in RUM even if paths change.
        'traceys.pizzeria.route.id': options.routeId,
    };
    console.log(resourceAttributes);

    // ── Sessions ────────────────────────────────────────────────────────────────
    // The session processors must run BEFORE the export processors so the
    // session.id attribute is set on each log record before it is exported.
    const sessionManager = createSessionManager({
        sessionIdGenerator: createDefaultSessionIdGenerator(),
        sessionStore: createLocalStorageSessionStore(),
        maxDuration: SESSION_MAX_DURATION_SECONDS,
        inactivityTimeout: SESSION_INACTIVITY_TIMEOUT_SECONDS,
    });

    // Hand the manager to the UI layer before start() below, so the footer's
    // observer is attached in time for the first onSessionStarted rather than
    // having to poll for it.
    registerSessionManager(sessionManager);

    // ── Document context ────────────────────────────────────────────────────────
    // Reads `location.href` as each span starts and each log record is emitted,
    // so `browser.document.url.full` follows soft navigations with no bookkeeping.
    const documentProvider = createLocationDocumentProvider();

    // ── Span processors ───────────────────────────────────────────────────────
    // context first (so session.id, browser.document.url.full and the
    // traceys.pizzeria.* attributes are set) → console → batching OTLP exporter,
    // which startTracesSdk appends because exportConfig is set.
    const spanProcessors = [
        createSessionSpanProcessor(sessionManager),
        createDocumentSpanProcessor(documentProvider),
        createOrderContextSpanProcessor(),
        new SimpleSpanProcessor({ exporter: new ConsoleSpanExporter() }),
    ];

    console.log("Starting OTel Traces SDK");
    const tracesSdk = startTracesSdk({
        serviceName,
        resourceAttributes,
        processors: spanProcessors,
        exportConfig: {url: `${collectorUrl}/v1/traces`},
        batchProcessorConfig: {scheduledDelayMillis: TRACES_SCHEDULED_DELAY_MS},
    });

    // ── Log record processors ─────────────────────────────────────────────────
    const logProcessors = [
        createSessionLogRecordProcessor(sessionManager),
        createDocumentLogRecordProcessor(documentProvider),
        createOrderContextLogRecordProcessor(),
        // After the context processors, before the exporters: it only fills in
        // a spanContext the record does not already have, and both the console
        // and OTLP exporters downstream need to see the filled-in value.
        createPageTraceLogRecordProcessor(),
        new SimpleLogRecordProcessor({ exporter: new ConsoleLogRecordExporter() }),
    ];

    console.log("Starting OTel Logs SDK");
    const logsSdk = startLogsSdk({
        serviceName,
        resourceAttributes,
        processors: logProcessors,
        exportConfig: {url: `${collectorUrl}/v1/logs`},
        batchProcessorConfig: {scheduledDelayMillis: LOGS_SCHEDULED_DELAY_MS},
    });

    activeSdks = [tracesSdk, logsSdk];

    // See https://docs.google.com/document/d/1eQOOG9973NB27xxiB9zJcrTWHcx-F20S7gUVXAw_vEQ/edit?tab=t.crjfpnx16m1w#heading=h.r6gqdymwfioc
    // See https://github.com/open-telemetry/opentelemetry-browser/blob/main/packages/instrumentation/README.md
    registerInstrumentations({
        instrumentations: [
            new SessionInstrumentation(sessionManager), // Session lifecycle -> event_name "session.start" / "session.end" -> Datadog RUM Session
            new UserActionInstrumentation({             // User Actions -> Clicks -> event_name "browser.user_action.click" -> Datadog RUM Action
                applyCustomLogRecordData: promoteNamedAction,
            }),
            new ErrorsInstrumentation(),                // Uncaught errors -> event_name "exception" -> Datadog RUM Error
            new ConsoleInstrumentation(),               // console.* calls -> log records
            new NavigationTimingInstrumentation(),      // Page navigation -> event_name "browser.navigation_timing" -> Datadog RUM Resource
            new NavigationInstrumentation(),            // Page view marker -> event_name "browser.navigation"
            new WebVitalsInstrumentation(),             // Core Web Vitals -> event_name "browser.web_vital"

            new ResourceTimingInstrumentation({
                // Without this list, `browser.resource_timing` is ~90% of all
                // log volume and buries every traceys.pizzeria.* event the pages emit.
                // Note this is a *separate* filter from the `ignoreUrls` on
                // Fetch/Xhr below: that one suppresses the request *spans*,
                // this one suppresses the resource *log records*.
                ignoreUrls: RESOURCE_TIMING_IGNORE_URLS,

                // Process 100 resources per batch (default: 50)
                batchSize: 100,

                // Wait max 2 seconds for idle time before forcing processing (default: 1000)
                forceProcessingAfter: 2000,

                // Spend max 100ms processing per idle callback (default: 50)
                maxProcessingTime: 100,

                // Maximum queue size before forcing immediate flush (default: 1000)
                maxQueueSize: 2000,
            }),

            // Last, and the only one here producing *spans* rather than log
            // records. Covers fetch("/api/...") calls, propagating W3C
            // traceparent so Datadog can correlate this session with the
            // backend's APM trace.
            //
            // There is deliberately no XHR instrumentation alongside it: the
            // app uses fetch exclusively, and registering an unused transport's
            // instrumentation buys nothing but patched globals.
            new FetchInstrumentation({
                propagateTraceHeaderCorsUrls: [/.*/],
                ignoreUrls: ["http://localhost:4318/v1/traces", "http://localhost:4318/v1/logs"],
            }),

            new XhrInstrumentation({
                propagateTraceHeaderCorsUrls: [/.*/],
                ignoreUrls: ["http://localhost:4318/v1/traces", "http://localhost:4318/v1/logs"],
            }),
        ],
    });

    // Start (or restore) the session only after all instrumentations —
    // including SessionInstrumentation's observer — are wired up, so the
    // very first session.start event and the events it gates all fire.
    await sessionManager.start();

    // Only now is the session id safe to read: start() resolves the restore
    // from localStorage, and reading before this point would mint a new
    // session instead (see session.ts). A session *restored* here fires no
    // onSessionStarted, so the footer needs this explicit nudge.
    notifySessionReady();

    // ── Ordering constraint, load-bearing ─────────────────────────────────
    // This document's root span, which the page-trace processor above uses to
    // give otherwise-unparented log records a trace id.
    //
    // It must come *after* sessionManager.start(). Starting a span runs
    // createSessionSpanProcessor's onStart, which calls getSessionId(), and
    // SessionManager.getSession() mints *and persists* a brand-new session
    // whenever its internal _session is still unset — which it is until the
    // async start() above resolves. Opening this span any earlier therefore
    // overwrote the stored session on every single document load: a new RUM
    // session id per page, and no session.start event either, because the
    // session was created before SessionInstrumentation's observer existed.
    startPageTrace(options.routeId);
}

/**
 * Force the batch processors to drain before the document goes away.
 *
 * This is the one piece hard page transitions genuinely require. Both SDKs
 * export on a timer (see the *_SCHEDULED_DELAY_MS constants) and neither
 * installs a `pagehide` flush, so a `traceys.pizzeria.funnel.step_completed` event
 * emitted immediately before `location.assign()` would be thrown away with
 * the document — the single most important event of the transition, lost.
 *
 * `shutdown()` force-flushes and then tears the provider down, which is
 * exactly right here: we are about to unload anyway. The timeout keeps a
 * dead collector from stranding the customer on the current page.
 */
export async function flushRum(timeoutMs = 1500): Promise<void> {
    const sdks = activeSdks;
    activeSdks = [];
    if (sdks.length === 0) return;

    await Promise.race([
        Promise.allSettled(sdks.map((sdk) => sdk.shutdown())),
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
}
