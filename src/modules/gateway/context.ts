import type { RequestContext } from '#src/platform/context/types.js';
import type { ChatCompletionRequest, ChatMessage, ChatRole } from './types.js';

/**
 * This module *exposes* the conversation; it never interprets it. The two
 * derived turns are structural lookups — the last `user` turn and the last
 * `assistant` turn — with no notion of topics, similarity, or cache validity.
 * `dual-layer-caching` owns topic-shift detection and context-chain
 * verification and reads these fields as its input.
 */

// Declaration merging rather than an edit to the foundation's interface: the
// foundation defines the context's shape and defaults, and each later spec adds
// the fields it owns. The zero values live in `platform/context/types.ts`
// alongside every other field's default, so a reader never sees `undefined`.
declare module '#src/platform/context/types.js' {
  interface RequestContext {
    /** The full validated conversation for this request, oldest turn first. */
    messages: ChatMessage[];
    /** The most recent `user` turn — the request's actual prompt. */
    latestUserMessage: ChatMessage | null;
    /**
     * The most recent `assistant` turn. `null` on the first turn of a
     * conversation, which is why it is nullable rather than merely absent.
     */
    lastAssistantMessage: ChatMessage | null;
  }
}

/** Scans from the end, so on a long conversation the answer is the *current*
 * turn rather than the opening one. */
function lastMessageByRole(
  messages: readonly ChatMessage[],
  role: ChatRole,
): ChatMessage | null {
  return messages.findLast((message) => message.role === role) ?? null;
}

/**
 * Only params the client actually sent are recorded: `params` is typed
 * `Record<string, unknown>`, so writing an omitted one would store an explicit
 * `undefined` that telemetry could not distinguish from "sent as undefined".
 *
 * The names stay provider-agnostic (`maxTokens`, not `max_tokens`/`num_predict`)
 * — translating them is the adapter's job. `stop` is copied so a later mutation
 * of the context cannot reach back into the request body.
 */
function toParams(request: ChatCompletionRequest): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (request.temperature !== undefined)
    params.temperature = request.temperature;
  if (request.maxTokens !== undefined) params.maxTokens = request.maxTokens;
  if (request.topP !== undefined) params.topP = request.topP;
  if (request.stop !== undefined) params.stop = [...request.stop];
  return params;
}

/**
 * Called *before* the provider call, so every downstream stage — including one
 * that only runs on failure — can read what was attempted. `model` is what the
 * client asked for; `completion-service.ts` overwrites it with the model the
 * provider reports having served.
 *
 * The message list is a shallow copy: the turns are immutable (`ChatMessage` is
 * fully `readonly`) but the array is not, and the context outlives the handler
 * that owns the body. No credential is taken as an argument, so none can be
 * written here — the context is logged and read by telemetry.
 */
export function populateCompletionContext(
  ctx: RequestContext,
  request: ChatCompletionRequest,
): void {
  ctx.provider = request.provider;
  ctx.model = request.model;
  ctx.params = toParams(request);
  ctx.messages = [...request.messages];
  ctx.latestUserMessage = lastMessageByRole(ctx.messages, 'user');
  ctx.lastAssistantMessage = lastMessageByRole(ctx.messages, 'assistant');
}
