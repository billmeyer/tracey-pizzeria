import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
// Types only — the Bedrock client is a drop-in for the Anthropic one, so the
// request/response shapes still come from the core SDK's namespace.
import type Anthropic from '@anthropic-ai/sdk';

// The one line of observability in this file. Everything it implies — the
// span, the gen_ai.* attributes, the token and duration histograms, the
// content-capture gate — lives in claude-instrumentation.ts, which is also
// the only file here that imports @opentelemetry.
import { withGenAISpan } from './claude-instrumentation';

// The offline stand-in, used only when MOCK_LLM=true. Application code, not
// instrumentation — see claude-mock.ts for why that distinction is the point.
import { createMockMessage } from './claude-mock';

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

/**
 * Answer from `claude-mock.ts` instead of Bedrock.
 *
 * The escape hatch for the one failure this app cannot recover from on its own:
 * AWS_BEARER_TOKEN_BEDROCK is presigned and time-limited, so a token that dies
 * mid-session turns every chat turn into a 403 and there is nothing in the UI
 * that can fix it. Setting MOCK_LLM=true keeps the funnel orderable — and,
 * because the mock is swapped in *under* `withGenAISpan`, keeps every
 * gen_ai.* span and both histograms working exactly as they did.
 *
 * Read once at module load and announced on startup, because a mock that
 * engaged silently would be indistinguishable from a model giving strange
 * answers — which is a far worse debugging session than a missing token.
 */
const MOCK_LLM = process.env.MOCK_LLM === 'true';

if (MOCK_LLM) {
  console.warn('[claude] MOCK_LLM=true — answering from claude-mock.ts, Bedrock is not called');
}

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
 * One `tool_use` block as it comes back from Claude.
 *
 * Exported for the same reason as `ClaudeToolResult`: the agent loop passes a
 * whole block to `withToolSpan`, and the instrumentation needs a name for the
 * shape it reads `name` / `id` off.
 */
export type ClaudeToolUse = Anthropic.ToolUseBlock;

/**
 * The request `callClaude` sends.
 *
 * Narrowed from the SDK's own param type on one field: `system` there is a
 * string *or* an array of text blocks, and pinning it to the string this app
 * actually passes is what lets the instrumentation read the prompt straight
 * off the request instead of taking it as a second argument.
 */
export type ClaudeRequest = Omit<Anthropic.MessageCreateParamsNonStreaming, 'system'> & {
  system: string;
};

/**
 * One turn of the conversation, sent to Claude on Bedrock.
 *
 * `withGenAISpan` is the single line of observability in this file: it opens
 * the gen_ai.* client span and records both GenAI metrics around the call, and
 * all of that lives in claude-instrumentation.ts. Remove the wrapper and this
 * is a bare `anthropic.messages.create(request)` — which is the shape to aim
 * for in your own services, instrumentation you can see at the call site and
 * delete in one line rather than a tracer threaded through the logic.
 */
export async function callClaude(
  system: string,
  messages: ClaudeMessage[],
  tools: ClaudeTool[]
): Promise<ClaudeResponse> {
  const request: ClaudeRequest = {
    model: MODEL,
    max_tokens: 1024,
    system,
    messages,
    tools,
  };

  // The swap happens *inside* the wrapper, not around it: instrumentation reads
  // the response object, never the wire, so it cannot tell the two apart and
  // needs no branch of its own.
  return withGenAISpan(request, (req) =>
    MOCK_LLM ? createMockMessage(req) : anthropic.messages.create(req)
  );
}
