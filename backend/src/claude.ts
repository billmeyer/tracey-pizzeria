import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
// Types only — the Bedrock client is a drop-in for the Anthropic one, so the
// request/response shapes still come from the core SDK's namespace.
import type Anthropic from '@anthropic-ai/sdk';

// The one line of observability in this file. Everything it implies — the
// span, the gen_ai.* attributes, the token and duration histograms, the
// content-capture gate — lives in claude-instrumentation.ts, which is also
// the only file here that imports @opentelemetry.
import { withGenAISpan } from './claude-instrumentation';

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
 * The request both `callClaude` and `callClaudeWithGenAI` send.
 *
 * Narrowed from the SDK's own param type on one field: `system` there is a
 * string *or* an array of text blocks, and pinning it to the string this app
 * actually passes is what lets the instrumentation read the prompt straight
 * off the request instead of taking it as a second argument.
 */
export type ClaudeRequest = Omit<Anthropic.MessageCreateParamsNonStreaming, 'system'> & {
  system: string;
};

function buildRequest(
  system: string,
  messages: ClaudeMessage[],
  tools: ClaudeTool[]
): ClaudeRequest {
  return {
    model: MODEL,
    max_tokens: 1024,
    system,
    messages,
    tools,
  };
}

/**
 * ── WORKSHOP EXERCISE 1 (Section 1) ─────────────────────────────────────
 * The instrumented path. `withGenAISpan` opens a gen_ai.* client span around
 * the call and records the GenAI spans and metrics the lab guide walks
 * through; see claude-instrumentation.ts for all of it.
 *
 * Read this against the plain `callClaude` below: same request, same
 * response, one wrapper between them. That is the shape to aim for in your own
 * services — instrumentation you can see at the call site and delete in one
 * line, not a tracer threaded through the business logic.
 * ─────────────────────────────────────────────────────────────────────────
 */
export async function callClaudeWithGenAI(
  system: string,
  messages: ClaudeMessage[],
  tools: ClaudeTool[]
): Promise<ClaudeResponse> {
  const request = buildRequest(system, messages, tools);

  return withGenAISpan(request, (req) => anthropic.messages.create(req));
}

/**
 * The same Bedrock call as `callClaudeWithGenAI`, with no manual instrumentation at
 * all. The request it sends and the response it returns are identical — the
 * shared `buildRequest` is what guarantees that.
 *
 * It is the "before" half of the Section 1 exercise, and it carries the plain
 * name on purpose: this is what calling an LLM looks like before anyone
 * thinks about observability. Point the chat endpoint at it, look at the
 * trace, and the call is simply absent — the request handler shows a
 * multi-second gap with nothing in it, no model, no token counts, nothing to
 * attribute cost or latency to. Switch to `callClaudeWithGenAI` and that gap
 * becomes the span.
 *
 * One caveat worth saying out loud, because it is visible in the trace: this
 * is not *zero* telemetry. The HTTP instrumentation still records the outbound
 * POST to Bedrock as a client span, so you get a URL and a status code. What
 * you lose is everything that makes it an LLM call rather than an HTTP call.
 */
export async function callClaude(
  system: string,
  messages: ClaudeMessage[],
  tools: ClaudeTool[]
): Promise<ClaudeResponse> {
  const request = buildRequest(system, messages, tools);

  return anthropic.messages.create(request);
}
