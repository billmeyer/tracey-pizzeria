/**
 * ── WORKSHOP EXERCISE 1 (Section 1) ─────────────────────────────────────────
 * The manual gen_ai.* instrumentation referenced in the lab guide: every span
 * attribute, both metrics, and the content-capture gate, in one file.
 *
 * It uses ONLY the OpenTelemetry API — there is no Datadog import anywhere in
 * here — and follows the OTel GenAI Semantic Conventions (v1.37+).
 *
 * The split from claude.ts is itself part of the lesson. claude.ts is the
 * application: build a request, send it to Bedrock, return the response, with
 * no `@opentelemetry` import in sight. Everything observability-shaped lives
 * here, behind one function — `withGenAISpan` — that the app calls and nothing
 * else. Delete this file and claude.ts still compiles once that one call is
 * removed; that is the test of whether instrumentation is bolted on or
 * tangled in.
 *
 * If you're running this as a live exercise rather than the finished
 * reference, hand attendees `withGenAISpan` as an empty passthrough —
 * `(request, call) => call(request)` — and have them build it up from there.
 * ────────────────────────────────────────────────────────────────────────────
 */
import { metrics, trace, SpanKind, SpanStatusCode, type Span } from '@opentelemetry/api';
// error.type is a *stable* attribute, so it comes from the package root.
// Contrast the gen_ai.* import below: two entry points, one per stability
// level, and the import path is the only place that distinction is visible.
import { ATTR_ERROR_TYPE } from '@opentelemetry/semantic-conventions';

// The gen_ai.* conventions are still *experimental*, so their constants ship
// from the package's `/incubating` entry point rather than its root (which
// exports only stable attributes). That split is the stability guarantee made
// visible: anything imported below can be renamed in a future semconv
// release, and when it is, this becomes a dependency bump instead of a grep.
import {
  ATTR_GEN_AI_INPUT_MESSAGES,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_OUTPUT_MESSAGES,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MAX_TOKENS,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_FINISH_REASONS,
  ATTR_GEN_AI_RESPONSE_ID,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_TOKEN_TYPE,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
  GEN_AI_PROVIDER_NAME_VALUE_AWS_BEDROCK,
  GEN_AI_TOKEN_TYPE_VALUE_INPUT,
  GEN_AI_TOKEN_TYPE_VALUE_OUTPUT,
  METRIC_GEN_AI_CLIENT_OPERATION_DURATION,
  METRIC_GEN_AI_CLIENT_TOKEN_USAGE,
} from '@opentelemetry/semantic-conventions/incubating';

// Types only, so this import is erased at compile time — claude.ts importing
// withGenAISpan while this file imports its types back is a cycle on paper
// and nothing at all at runtime.
import type { ClaudeMessage, ClaudeRequest, ClaudeResponse } from './claude';

const tracer = trace.getTracer('tracey.llm');

// The GenAI conventions define metrics as well as spans, and the *instrument
// names* are constants too — same vocabulary, second signal.
const meter = metrics.getMeter('tracey.llm');
const tokenUsage = meter.createHistogram(METRIC_GEN_AI_CLIENT_TOKEN_USAGE, {
  unit: '{token}',
  description: 'Number of input and output tokens used',
});
const operationDuration = meter.createHistogram(METRIC_GEN_AI_CLIENT_OPERATION_DURATION, {
  unit: 's',
  description: 'GenAI operation duration',
});

/**
 * Whether to put the actual prompt and completion on the span, via
 * gen_ai.input.messages / gen_ai.output.messages.
 *
 * The GenAI conventions make this **opt-in and default it off**, and the
 * reason is not squeamishness: the prompt is the highest-sensitivity payload
 * in an LLM system. Whatever the user typed, whatever you retrieved and
 * stuffed into context, whatever the system prompt reveals about your
 * business logic — all of it ends up in a span attribute, which then flows to
 * your observability vendor and sits in their index for the retention period.
 * PII, credentials pasted into a chat box, another customer's data pulled in
 * by a bad RAG query. Spans are not a system of record and were never
 * designed to hold any of that.
 *
 * So this reads the conventional environment variable rather than inventing a
 * flag, and defaults to false when it is unset. The lab turns it on
 * explicitly (see the Makefile's run-backend target) because seeing your own
 * prompts is the entire point of the exercise — but that is a lab decision,
 * made once, in the open.
 *
 * Parsing mirrors the OTel JS instrumentations' own getEnvBool: unset or
 * empty falls through to the default, "true"/"false" are case-insensitive,
 * and anything else warns rather than being quietly read as false.
 */
const CAPTURE_CONTENT_ENV_VAR = 'OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT';

function captureMessageContentFromEnv(): boolean {
  const raw = process.env[CAPTURE_CONTENT_ENV_VAR];
  if (raw === undefined || raw === '') return false;

  const value = raw.toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;

  // Deliberately console.warn and not diag.warn: the services run with
  // OTEL_LOG_LEVEL=error, which would swallow a diag warning — and a silently
  // ignored typo here looks exactly like "content capture is broken".
  console.warn(
    `invalid boolean value for environment variable: ${CAPTURE_CONTENT_ENV_VAR}=${raw}; ` +
      'ignoring, message content will NOT be captured'
  );
  return false;
}

const captureMessageContent = captureMessageContentFromEnv();

/**
 * Converts an Anthropic content block (request or response side) into a
 * gen_ai.*.messages "part", per the OTel GenAI semantic conventions'
 * message/part shape (https://github.com/open-telemetry/semantic-conventions-genai).
 */
type GenAIContent = ClaudeMessage['content'] | ClaudeResponse['content'];

function toGenAIParts(content: GenAIContent): unknown[] {
  if (typeof content === 'string') {
    return [{ type: 'text', content }];
  }
  return content.map((block: (typeof content)[number]) => {
    switch (block.type) {
      case 'text':
        return { type: 'text', content: block.text };
      case 'tool_use':
        return { type: 'tool_call', id: block.id, name: block.name, arguments: block.input };
      case 'tool_result':
        return { type: 'tool_call_response', id: block.tool_use_id, response: block.content };
      default:
        return { type: block.type };
    }
  });
}

function toGenAIInputMessages(system: string, messages: ClaudeMessage[]): string {
  const genAIMessages = [
    ...(system ? [{ role: 'system', parts: [{ type: 'text', content: system }] }] : []),
    ...messages.map((message) => ({ role: message.role, parts: toGenAIParts(message.content) })),
  ];
  return JSON.stringify(genAIMessages);
}

function toGenAIOutputMessages(response: ClaudeResponse): string {
  return JSON.stringify([
    {
      role: response.role,
      parts: toGenAIParts(response.content),
      finish_reason: response.stop_reason ?? 'unknown',
    },
  ]);
}

/**
 * Span attributes known before the call goes out.
 *
 * Everything here is read off the request rather than restated, so there is no
 * second copy of max_tokens to drift away from the one Bedrock is actually
 * given — a wrong value there is invisible until someone trusts it.
 */
function requestAttributes(request: ClaudeRequest) {
  return {
    [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_CHAT,
    [ATTR_GEN_AI_PROVIDER_NAME]: GEN_AI_PROVIDER_NAME_VALUE_AWS_BEDROCK,
    [ATTR_GEN_AI_REQUEST_MODEL]: request.model,
    [ATTR_GEN_AI_REQUEST_MAX_TOKENS]: request.max_tokens,
    // Gated — see captureMessageContent above. Note the metrics and every
    // other attribute on this span are unaffected: turning content capture off
    // costs you the prompt text, not the observability.
    ...(captureMessageContent
      ? { [ATTR_GEN_AI_INPUT_MESSAGES]: toGenAIInputMessages(request.system, request.messages) }
      : {}),
  };
}

/**
 * The low-cardinality dimensions shared by both histograms, and by the span.
 * One vocabulary across both signals, so a metric time series and a span
 * filter agree on what they are describing.
 *
 * These are *dimensions*: every distinct combination is its own time series,
 * so nothing high-cardinality belongs here — gen_ai.response.id is exactly
 * what must never appear in this object.
 */
function metricAttributes(request: ClaudeRequest) {
  return {
    [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_CHAT,
    [ATTR_GEN_AI_PROVIDER_NAME]: GEN_AI_PROVIDER_NAME_VALUE_AWS_BEDROCK,
    [ATTR_GEN_AI_REQUEST_MODEL]: request.model,
  };
}

/** Records what only the response can tell us, onto the span and the metrics. */
function recordResponse(
  span: Span,
  request: ClaudeRequest,
  response: ClaudeResponse,
  elapsedSeconds: number
): void {
  if (captureMessageContent) {
    span.setAttribute(ATTR_GEN_AI_OUTPUT_MESSAGES, toGenAIOutputMessages(response));
  }
  span.setAttribute(ATTR_GEN_AI_RESPONSE_ID, response.id);
  span.setAttribute(ATTR_GEN_AI_RESPONSE_MODEL, response.model);
  span.setAttribute(ATTR_GEN_AI_RESPONSE_FINISH_REASONS, [response.stop_reason ?? 'unknown']);
  span.setAttribute(ATTR_GEN_AI_USAGE_INPUT_TOKENS, response.usage.input_tokens);
  span.setAttribute(ATTR_GEN_AI_USAGE_OUTPUT_TOKENS, response.usage.output_tokens);

  const common = metricAttributes(request);
  tokenUsage.record(response.usage.input_tokens, {
    ...common,
    [ATTR_GEN_AI_TOKEN_TYPE]: GEN_AI_TOKEN_TYPE_VALUE_INPUT,
  });
  tokenUsage.record(response.usage.output_tokens, {
    ...common,
    [ATTR_GEN_AI_TOKEN_TYPE]: GEN_AI_TOKEN_TYPE_VALUE_OUTPUT,
  });
  // Seconds, matching the convention's declared unit. Getting this wrong is
  // silent and poisons every dashboard built on it.
  operationDuration.record(elapsedSeconds, common);
}

/** The failure counterpart of recordResponse. */
function recordError(
  span: Span,
  request: ClaudeRequest,
  error: Error,
  elapsedSeconds: number
): void {
  span.setAttribute(ATTR_ERROR_TYPE, error.name);
  // Failed calls still took time, and the convention carries error.type as a
  // dimension so the success and failure latencies stay separable.
  operationDuration.record(elapsedSeconds, {
    ...metricAttributes(request),
    [ATTR_ERROR_TYPE]: error.name,
  });
  span.recordException(error);
  span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
}

/**
 * Runs `call` inside a gen_ai.* client span and records both GenAI metrics.
 *
 * This is the whole surface claude.ts touches, and the reason that file can
 * stay free of OpenTelemetry: the app says "make this call", and whether that
 * call is observed is decided here. Note what the signature does *not* let
 * this function do — it takes the request and hands it straight back to the
 * caller, so instrumentation can read the request but never rewrite it.
 *
 * The span is CLIENT because the work happens in a remote service we are a
 * consumer of. The name follows the convention's "{operation} {model}"
 * pattern, which is why the model ID shows up in the trace twice: once as the
 * span name and once as gen_ai.request.model.
 */
export function withGenAISpan(
  request: ClaudeRequest,
  call: (request: ClaudeRequest) => Promise<ClaudeResponse>
): Promise<ClaudeResponse> {
  // The span's own duration is not readable back from the API, so the duration
  // histogram needs its own clock.
  const startedAt = Date.now();
  const elapsedSeconds = () => (Date.now() - startedAt) / 1000;

  return tracer.startActiveSpan(
    `${GEN_AI_OPERATION_NAME_VALUE_CHAT} ${request.model}`,
    { kind: SpanKind.CLIENT, attributes: requestAttributes(request) },
    async (span) => {
      try {
        const response = await call(request);
        recordResponse(span, request, response, elapsedSeconds());
        return response;
      } catch (err) {
        recordError(span, request, err as Error, elapsedSeconds());
        throw err;
      } finally {
        span.end();
      }
    }
  );
}
