import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
// Types only — the Bedrock client is a drop-in for the Anthropic one, so the
// request/response shapes still come from the core SDK's namespace.
import type Anthropic from '@anthropic-ai/sdk';
import { metrics, trace, SpanKind, SpanStatusCode } from '@opentelemetry/api';
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

// Claude is reached through Amazon Bedrock rather than Anthropic's own API, so
// there is no ANTHROPIC_API_KEY anywhere in this stack. `AnthropicBedrock` is
// the bedrock-runtime (InvokeModel) client, which is the one that accepts the
// `us.anthropic.…-v1:0` cross-region inference profile IDs the lab provisions.
// Its `.messages.create()` surface is identical to the first-party client's —
// that is the whole point of using it instead of hand-rolling signed requests.
//
// Authentication is a Bedrock API key (AWS_BEARER_TOKEN_BEDROCK), which the
// client sends as a bearer token. Both fields *default* to exactly these
// environment variables, so the bare `new AnthropicBedrock()` would behave the
// same; naming them keeps the dependency on the environment visible at the one
// place a reader looks for it.
//
// That token is presigned and time-limited. When it expires mid-session
// Bedrock answers 403 and the chat endpoint 500s — the span still carries
// error.type, so the trace shows the failure, but the cause is an expired
// credential rather than anything about the request. If chat starts failing
// partway through a lab, check the token before debugging the call.
const anthropic = new AnthropicBedrock({
  awsRegion: process.env.AWS_REGION,
  apiKey: process.env.AWS_BEARER_TOKEN_BEDROCK,
});
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
 * Bedrock model identifier — note this is NOT the first-party model ID.
 *
 * Bedrock IDs carry a provider prefix and a version suffix, and the leading
 * `us.` marks a *cross-region inference profile* rather than a single-region
 * model: requests are served from whichever US region has capacity. That is
 * also why the first-party `claude-haiku-4-5-20251001` would 404 here.
 *
 * Read from the environment so the lab can repoint at another model without a
 * code change, with the provisioned value as the fallback. This string lands
 * on every span twice over — as the span *name* (`chat us.anthropic.…`, per
 * the GenAI convention's "{operation} {model}" pattern) and as
 * gen_ai.request.model — so changing it reshapes the traces attendees see.
 */
export const MODEL =
  process.env.BEDROCK_MODEL_ID || 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

export type ClaudeMessage = Anthropic.MessageParam;
export type ClaudeTool = Anthropic.Tool;
export type ClaudeResponse = Anthropic.Message;

/**
 * One `tool_result` block to hand back to Claude.
 *
 * Exported because `ClaudeMessage['content']` cannot express this: as of SDK
 * v1, `MessageParam` is a union of per-role shapes, and the `system` member
 * narrows content to text blocks only — so indexing into it yields an array
 * that rejects `tool_result`. Naming the block type directly is both more
 * honest about what the array holds and immune to that union growing again.
 */
export type ClaudeToolResult = Anthropic.ToolResultBlockParam;

/**
 * Converts an Anthropic content block (request or response side) into a
 * gen_ai.*.messages "part", per the OTel GenAI semantic conventions'
 * message/part shape (https://github.com/open-telemetry/semantic-conventions-genai).
 */
type GenAIContent = Anthropic.MessageParam['content'] | ClaudeResponse['content'];

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
 * ── WORKSHOP EXERCISE 1 (Section 1) ─────────────────────────────────────
 * This is the manual gen_ai.* span referenced in the lab guide. It uses
 * ONLY the OpenTelemetry API — no Datadog import anywhere in this file —
 * and follows the OTel GenAI Semantic Conventions (v1.37+) span-naming
 * pattern: "{gen_ai.operation.name} {gen_ai.request.model}".
 *
 * If you're running this as a live exercise rather than the finished
 * reference, delete the body of the tracer.startActiveSpan callback below
 * (keep the anthropic.messages.create call) and have attendees rebuild it.
 * ─────────────────────────────────────────────────────────────────────────
 */
export async function callClaude(
  system: string,
  messages: ClaudeMessage[],
  tools: ClaudeTool[]
): Promise<ClaudeResponse> {
  // Needed by the duration histogram below — the span's own duration is not
  // readable from the API, so we time the call ourselves.
  const startedAt = Date.now();

  return tracer.startActiveSpan(
    `${GEN_AI_OPERATION_NAME_VALUE_CHAT} ${MODEL}`,
    {
      kind: SpanKind.CLIENT,
      attributes: {
        [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_CHAT,
        [ATTR_GEN_AI_PROVIDER_NAME]: GEN_AI_PROVIDER_NAME_VALUE_AWS_BEDROCK,
        [ATTR_GEN_AI_REQUEST_MODEL]: MODEL,
        [ATTR_GEN_AI_REQUEST_MAX_TOKENS]: 1024,
        // Gated — see captureMessageContent above. Note the metrics and every
        // other attribute on this span are unaffected: turning content
        // capture off costs you the prompt text, not the observability.
        ...(captureMessageContent
          ? { [ATTR_GEN_AI_INPUT_MESSAGES]: toGenAIInputMessages(system, messages) }
          : {}),
      },
    },
    async (span) => {
      const common = {
        [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_CHAT,
        [ATTR_GEN_AI_PROVIDER_NAME]: GEN_AI_PROVIDER_NAME_VALUE_AWS_BEDROCK,
        [ATTR_GEN_AI_REQUEST_MODEL]: MODEL,
      };

      try {
        const response = await anthropic.messages.create({
          model: MODEL,
          max_tokens: 1024,
          system,
          messages,
          tools,
        });

        if (captureMessageContent) {
          span.setAttribute(ATTR_GEN_AI_OUTPUT_MESSAGES, toGenAIOutputMessages(response));
        }
        span.setAttribute(ATTR_GEN_AI_RESPONSE_ID, response.id);
        span.setAttribute(ATTR_GEN_AI_RESPONSE_MODEL, response.model);
        span.setAttribute(ATTR_GEN_AI_RESPONSE_FINISH_REASONS, [response.stop_reason ?? 'unknown']);
        span.setAttribute(ATTR_GEN_AI_USAGE_INPUT_TOKENS, response.usage.input_tokens);
        span.setAttribute(ATTR_GEN_AI_USAGE_OUTPUT_TOKENS, response.usage.output_tokens);

        // The same three constants the span opened with. One vocabulary across
        // both signals, so a metric time series and a span filter agree.
        //
        // These are *dimensions*: every distinct combination is its own time
        // series, so nothing high-cardinality belongs here —
        // gen_ai.response.id above is exactly what must never appear below.
        tokenUsage.record(response.usage.input_tokens, {
          ...common,
          [ATTR_GEN_AI_TOKEN_TYPE]: GEN_AI_TOKEN_TYPE_VALUE_INPUT,
        });
        tokenUsage.record(response.usage.output_tokens, {
          ...common,
          [ATTR_GEN_AI_TOKEN_TYPE]: GEN_AI_TOKEN_TYPE_VALUE_OUTPUT,
        });
        // Seconds, matching the convention's declared unit. Getting this wrong
        // is silent and poisons every dashboard built on it.
        operationDuration.record((Date.now() - startedAt) / 1000, common);

        return response;
      } catch (err) {
        const error = err as Error;
        span.setAttribute(ATTR_ERROR_TYPE, error.name);
        // Failed calls still took time, and the convention carries error.type
        // as a dimension so the success and failure latencies stay separable.
        operationDuration.record((Date.now() - startedAt) / 1000, {
          ...common,
          [ATTR_ERROR_TYPE]: error.name,
        });
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        throw err;
      } finally {
        span.end();
      }
    }
  );
}
