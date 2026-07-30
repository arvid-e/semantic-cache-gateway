import type { RequestContext } from '#src/platform/context/types.js';
import type { ChatCompletionRequest, ChatMessage, ChatRole } from './types.js';

/**
 * The gateway's extension of the shared request context, plus the helper that
 * fills it in before a provider is called.
 *
 * Two things live here and nothing else:
 *
 * 1. The conversation-context fields, added to the foundation's
 *    {@link RequestContext} by declaration merging so no downstream spec has to
 *    edit the foundation's interface (Req 5.2).
 * 2. {@link populateCompletionContext}, which writes the routing decision
 *    (provider, model, params) and the conversation onto a context.
 *
 * This module *exposes* the conversation; it never interprets it. The two
 * derived turns are structural lookups — the last `user` turn and the last
 * `assistant` turn — with no notion of topics, similarity, or cache validity.
 * `dual-layer-caching` owns topic-shift detection and context-chain
 * verification and reads these fields as its input (Req 5.3).
 *
 * Fields belonging to stages that have not run keep the defaults
 * `createDefaultContext()` gave them, so a reader never sees `undefined`
 * (Req 5.4). The defaults for the three fields declared below therefore live in
 * `src/platform/context/types.ts` alongside every other field's default: the
 * *types* are owned here, the zero values are owned by the one factory that
 * guarantees a complete context. Nothing in this module writes `tokenUsage` or
 * `latencyMs` — those are known only after the provider answers, and
 * `completion-service.ts` sets them then.
 */

// Declaration merging rather than an edit to the foundation's interface: the
// foundation defines the context's shape and defaults, and each later spec adds
// the fields it owns (foundation Req 7.2, 7.3).
declare module '#src/platform/context/types.js' {
  interface RequestContext {
    /**
     * The full validated conversation for this request, oldest turn first.
     * Default `[]` — the request has not been populated yet.
     */
    messages: ChatMessage[];
    /**
     * The most recent `user` turn, the request's actual prompt. Derived from
     * {@link RequestContext.messages}; `null` when the conversation holds no
     * user turn.
     */
    latestUserMessage: ChatMessage | null;
    /**
     * The most recent `assistant` turn — the previous AI response the latest
     * prompt follows on from. `null` on the first turn of a conversation, which
     * is why it is nullable rather than merely absent.
     */
    lastAssistantMessage: ChatMessage | null;
  }
}

/**
 * The last turn authored by `role`, or `null` when there is none.
 *
 * Scans from the end, so on a long conversation the answer is the *current*
 * turn rather than the opening one. `findLast` keeps that direction explicit.
 */
function lastMessageByRole(
  messages: readonly ChatMessage[],
  role: ChatRole,
): ChatMessage | null {
  return messages.findLast((message) => message.role === role) ?? null;
}

/**
 * The generation parameters in their provider-agnostic vocabulary.
 *
 * Only parameters the client actually sent are recorded: `params` is typed
 * `Record<string, unknown>`, so writing an omitted one would store an explicit
 * `undefined` that telemetry could not distinguish from "sent as undefined".
 * The names stay agnostic (`maxTokens`, not `max_tokens`/`num_predict`) —
 * translating them to a provider's wire vocabulary is the adapter's job, and
 * this context is read by stages that must not care which provider ran.
 *
 * `stop` is copied so a later mutation of the context cannot reach back into
 * the request body.
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
 * Write the routing decision and the conversation context onto `ctx`
 * (Req 5.1, 5.2).
 *
 * Called *before* the provider call, so every downstream stage — including one
 * that only runs on failure — can read what was attempted. `model` is the model
 * the client asked for; `completion-service.ts` overwrites it with the model the
 * provider reports having served once the response arrives (Req 2.4).
 *
 * Mutates in place, matching how the foundation's context is threaded through a
 * request. The message list is a shallow copy of the request's array: the turns
 * themselves are immutable (`ChatMessage` is fully `readonly`), but the array is
 * not, and the context outlives the handler that owns the body.
 *
 * No credential is taken as an argument, so none can be written here — the
 * context is logged and read by telemetry (Req 3.2, 4.3).
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
