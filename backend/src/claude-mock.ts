/**
 * ── Offline fallback for the Bedrock call ────────────────────────────────────
 * A keyword-driven stand-in for Claude, used when MOCK_LLM=true. It exists for
 * one reason: AWS_BEARER_TOKEN_BEDROCK is presigned and time-limited, and a
 * token that expires at minute 3 of a workshop otherwise locks an attendee out
 * of every remaining chapter with no recovery path.
 *
 * It is deliberately NOT instrumentation. It sits on the application side of
 * the seam claude-instrumentation.ts describes — `withGenAISpan` wraps this
 * exactly as it wraps the real client, reads the same response object, and does
 * not know which one it got. That is the point: a mock that required a second
 * instrumentation path would prove nothing about the first.
 *
 * It is also not a simulator. It reads the last user turn for a size, a crust
 * and some toppings, and answers with the tool call the real model would make —
 * enough to drive the funnel end to end, so the `execute_tool` spans Exercise
 * 5.3 builds still have something to wrap. Anything off that script gets a text
 * reply saying so, rather than a confident wrong answer.
 * ────────────────────────────────────────────────────────────────────────────
 */
import type Anthropic from '@anthropic-ai/sdk';

import type { ClaudeMessage, ClaudeRequest, ClaudeResponse } from './claude';

const SIZES = ['small', 'medium', 'large', 'xlarge'] as const;
const CRUSTS = ['thin', 'regular', 'deep'] as const;

// Not the inventory's vocabulary — inventory/src/menu.ts accepts any string and
// only pineapple is permanently out of stock. This is just what the mock knows
// how to *hear*, and pineapple is on it on purpose: the running bit is also the
// easiest way to see an unavailable-topping error span without chaos mode.
//
// Spelled as alias -> canonical rather than singularised with a regex, because
// English plurals do not survive one: "tomatoes" minus a trailing `s` is
// "tomatoe" and "anchovies" is "anchovie". A table is longer and right.
const TOPPINGS: Record<string, string> = {
  pepperoni: 'pepperoni',
  sausage: 'sausage',
  mushroom: 'mushroom',
  mushrooms: 'mushroom',
  onion: 'onion',
  onions: 'onion',
  pepper: 'pepper',
  peppers: 'pepper',
  olive: 'olive',
  olives: 'olive',
  bacon: 'bacon',
  ham: 'ham',
  pineapple: 'pineapple',
  basil: 'basil',
  anchovy: 'anchovy',
  anchovies: 'anchovy',
  spinach: 'spinach',
  tomato: 'tomato',
  tomatoes: 'tomato',
  cheese: 'cheese',
};

/** Phrases that mean "I'm done building the pizza" — confirm_pizza's trigger. */
const DONE_PATTERNS = [
  /\bthat'?s it\b/,
  /\bthat'?s all\b/,
  /\bi'?m done\b/,
  /\bdone\b/,
  /\bfinish(ed)?\b/,
  /\bconfirm\b/,
  /\bcheck ?out\b/,
  /\bnothing else\b/,
  /\bno more\b/,
];

/**
 * Flattens one request message back to plain text.
 *
 * `MessageParam['content']` is a string or an array of blocks, and the agent
 * loop pushes both shapes, so the only safe read is to pull the text blocks out
 * and ignore the rest — a tool_result block has no prose worth matching on.
 */
function messageText(message: ClaudeMessage): string {
  const { content } = message;
  if (typeof content === 'string') return content;
  return content
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join(' ');
}

/** The customer's most recent words, which is all this mock reasons about. */
function lastUserText(messages: ClaudeMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messageText(messages[i]).toLowerCase();
  }
  return '';
}

/** Whether the loop has already run a tool this turn, via its tool_result blocks. */
function toolAlreadyRan(messages: ClaudeMessage[], toolName: string): boolean {
  // The loop pushes `{role: 'assistant', content: response.content}` after every
  // round, so a tool_use block for this tool anywhere after the last user turn
  // means this mock already asked for it and must not ask again — without this
  // the loop would re-issue the same call until MAX_TOOL_ROUNDS runs out.
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && typeof messages[i].content === 'string') {
      lastUser = i;
      break;
    }
  }

  return messages.slice(lastUser + 1).some((message) => {
    const { content } = message;
    if (typeof content === 'string') return false;
    return content.some(
      (block) => block.type === 'tool_use' && (block as Anthropic.ToolUseBlock).name === toolName
    );
  });
}

interface OrderEdits {
  size?: string;
  crust?: string;
  toppings?: string[];
}

/** Reads whatever order details the sentence happens to carry. */
function parseOrderEdits(text: string): OrderEdits {
  const edits: OrderEdits = {};

  // 'xlarge' before 'large', or "xlarge" matches the 'large' branch first.
  const size = [...SIZES].reverse().find((candidate) => text.includes(candidate));
  if (size) edits.size = size;

  // 'regular' is the crust default and rarely said out loud; 'deep' covers
  // "deep dish" without needing the second word.
  const crust = CRUSTS.find((candidate) => text.includes(candidate));
  if (crust) edits.crust = crust;

  // Word-boundary matched, not `includes`, and that is load-bearing: "pepper"
  // is a substring of "pepperoni", so a plain `includes` put *both* on every
  // pepperoni pizza. `\bpepper\b` cannot match inside "pepperoni" because the
  // following `o` is a word character, which is exactly the property wanted.
  //
  // De-duplicated through the canonical form, so "mushroom" and "mushrooms" in
  // one sentence do not become two toppings on the pizza.
  const toppings = [
    ...new Set(
      Object.keys(TOPPINGS)
        .filter((alias) => new RegExp(`\\b${alias}\\b`).test(text))
        .map((alias) => TOPPINGS[alias])
    ),
  ];
  if (toppings.length) edits.toppings = toppings;

  return edits;
}

let mockResponseCounter = 0;

/**
 * Builds the response envelope, so the three branches below differ only in
 * their content blocks and stop reason.
 *
 * The token counts are estimates, not inventions: input is the whole request
 * rounded to the conventional ~4 characters per token, output is the same for
 * the blocks going back. They end up on `gen_ai.usage.*` and in the token
 * histogram, so a flat constant would make Chapter 06's dashboards read as a
 * straight line and quietly teach the wrong thing about what those charts show.
 */
function mockMessage(
  request: ClaudeRequest,
  content: Anthropic.ContentBlock[],
  stopReason: Anthropic.Message['stop_reason']
): ClaudeResponse {
  const inputChars =
    request.system.length + request.messages.map(messageText).join(' ').length;
  const outputChars = JSON.stringify(content).length;

  return {
    id: `msg_mock_${(mockResponseCounter += 1).toString().padStart(4, '0')}`,
    type: 'message',
    role: 'assistant',
    // The configured model, not a literal: the span name and
    // gen_ai.response.model both read this, and a mock that renamed itself
    // would make every trace in mock mode look like a different provider.
    model: request.model,
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: Math.max(1, Math.ceil(inputChars / 4)),
      output_tokens: Math.max(1, Math.ceil(outputChars / 4)),
    },
  } as ClaudeResponse;
}

function textBlock(text: string): Anthropic.ContentBlock {
  return { type: 'text', text, citations: null } as Anthropic.ContentBlock;
}

function toolUseBlock(name: string, input: unknown): Anthropic.ContentBlock {
  return {
    type: 'tool_use',
    id: `toolu_mock_${(mockResponseCounter += 1).toString().padStart(4, '0')}`,
    name,
    input,
  } as Anthropic.ContentBlock;
}

/**
 * The canned counterpart to `anthropic.messages.create`.
 *
 * Same signature, same return type, and it is handed to `withGenAISpan` the
 * same way — so every gen_ai.* attribute, both histograms and the error path
 * behave identically to a live call.
 */
export async function createMockMessage(request: ClaudeRequest): Promise<ClaudeResponse> {
  const text = lastUserText(request.messages);
  const edits = parseOrderEdits(text);
  const updated = toolAlreadyRan(request.messages, 'update_order');
  const confirmed = toolAlreadyRan(request.messages, 'confirm_pizza');

  // Order matters: a customer who says "large thin pepperoni, that's it" has
  // asked for both, and the real model would update first and confirm on the
  // next round. Checking the edits first reproduces that two-round shape, which
  // is also what gives the trace two execute_tool spans instead of one.
  if (Object.keys(edits).length > 0 && !updated) {
    return mockMessage(
      request,
      [textBlock('Got it, writing that down.'), toolUseBlock('update_order', edits)],
      'tool_use'
    );
  }

  if (DONE_PATTERNS.some((pattern) => pattern.test(text))) {
    if (!confirmed) {
      return mockMessage(
        request,
        [textBlock('Locked in. Hit Checkout when you are ready.'), toolUseBlock('confirm_pizza', {})],
        'tool_use'
      );
    }
    return mockMessage(request, [textBlock('All set — hit Checkout.')], 'end_turn');
  }

  // The second round of a tool turn: the loop has the tool_result and is asking
  // what to say about it. Without this branch it would fall through to the
  // off-script reply below and tell a customer whose order just succeeded that
  // the mock did not understand them.
  if (updated) {
    return mockMessage(
      request,
      [textBlock('On the pizza. Anything else, or is that it?')],
      'end_turn'
    );
  }

  if (confirmed) {
    return mockMessage(request, [textBlock('All set — hit Checkout.')], 'end_turn');
  }

  // The honest branch. Saying so is better than a plausible reply, because an
  // attendee debugging "why did my pizza not update" should be able to tell a
  // mock from a model.
  return mockMessage(
    request,
    [
      textBlock(
        'Mock mode — no model behind this. Tell me a size, a crust and some toppings ' +
          '("large thin crust with pepperoni"), then say "that\'s it".'
      ),
    ],
    'end_turn'
  );
}
