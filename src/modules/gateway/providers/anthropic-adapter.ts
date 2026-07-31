import Anthropic from '@anthropic-ai/sdk';
import type { ProviderName, ProviderSecret } from '#src/modules/auth/types.js';
import {
  ProviderError,
  type ChatCompletionRequest,
  type ChatMessage,
  type NormalizedResponse,
  type ProviderAdapter,
  type ProviderCallOptions,
} from '../types.js';
import { mapAnthropicStopReason, mapAnthropicUsage } from './mapping.js';

/**
 * Anthropic adapter for the shared {@link ProviderAdapter} seam.
 *
 * Translates the provider-agnostic {@link ChatCompletionRequest} into an
 * Anthropic Messages call and normalizes the reply back into the unified
 * {@link NormalizedResponse}. All Anthropic-specific request and response shapes
 * are confined to this file — nothing provider-specific crosses the adapter
 * boundary (Req 3.4, 4.1, 4.2).
 *
 * Anthropic diverges from the agnostic request in three ways this file absorbs:
 * system turns live in a top-level parameter rather than in `messages`,
 * `max_tokens` is required rather than optional, and the reply's text arrives as
 * a list of content blocks rather than a single string.
 *
 * The tenant's BYOK key is revealed only here, at the HTTP boundary, and is used
 * to build a fresh per-call client with retries disabled and the per-call
 * timeout applied (Req 3.2, 3.5). It is never logged, returned, or attached to a
 * {@link ProviderError} (Req 4.3).
 */

/**
 * Anthropic's ceiling for `temperature`. The boundary schema admits 0–2 (the
 * widest of the three providers), so a value in (1, 2] is valid input that this
 * provider would reject.
 */
const MAX_TEMPERATURE = 1;

/**
 * Separator for several system turns collapsed into the one system parameter.
 * A blank line keeps two independent instructions from reading as one sentence.
 */
const SYSTEM_SEPARATOR = '\n\n';

/** Per-call Anthropic client options the adapter builds from config + credential. */
export interface AnthropicClientOptions {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly maxRetries: number;
  readonly timeout: number;
  /** Carries `anthropic-version`; the SDK derives `x-api-key` from `apiKey`. */
  readonly defaultHeaders: Readonly<Record<string, string>>;
}

/**
 * The slice of the Anthropic client the adapter actually uses. Narrowed to the
 * one non-streaming call so the client can be substituted in tests without
 * standing up the whole SDK.
 */
export interface AnthropicMessagesClient {
  readonly messages: {
    create(
      body: Anthropic.MessageCreateParamsNonStreaming,
    ): Promise<Anthropic.Message>;
  };
}

/** Builds a per-request client; injectable so tests can stub the upstream call. */
export type AnthropicClientFactory = (
  options: AnthropicClientOptions,
) => AnthropicMessagesClient;

/** Deployment-side config the adapter captures (the per-call opts carry the rest). */
export interface AnthropicAdapterConfig {
  readonly baseUrl: string;
  /** Value for the `anthropic-version` header, pinned by the gateway config. */
  readonly version: string;
}

/** Real client factory: a fresh SDK client per call, keyed by the tenant secret. */
const defaultClientFactory: AnthropicClientFactory = (options) =>
  new Anthropic(options);

/**
 * The Anthropic Messages adapter.
 *
 * Holds only deployment config and the client factory: the tenant credential and
 * the per-call options arrive on each {@link AnthropicAdapter.complete} call, so
 * one instance serves every tenant and every request.
 */
export class AnthropicAdapter implements ProviderAdapter {
  readonly name: ProviderName = 'anthropic';

  readonly #config: AnthropicAdapterConfig;
  readonly #createClient: AnthropicClientFactory;

  /**
   * @param config - Provider base URL and API version (from the gateway config).
   * @param createClient - Client factory; defaults to the real Anthropic SDK.
   */
  constructor(
    config: AnthropicAdapterConfig,
    createClient: AnthropicClientFactory = defaultClientFactory,
  ) {
    this.#config = config;
    this.#createClient = createClient;
  }

  async complete(
    request: ChatCompletionRequest,
    credential: ProviderSecret,
    opts: ProviderCallOptions,
  ): Promise<NormalizedResponse> {
    const client = this.#createClient({
      // The one place the tenant secret is revealed: the HTTP boundary.
      apiKey: credential.reveal(),
      baseURL: this.#config.baseUrl,
      // Retries are owned by resilience-failover, not the adapter (Req 3.5).
      maxRetries: 0,
      timeout: opts.timeoutMs,
      // Pinned from config so a rollout can move to a newer dated release
      // without a code change; the SDK would otherwise send its own default.
      defaultHeaders: { 'anthropic-version': this.#config.version },
    });

    let message: Anthropic.Message;
    try {
      message = await client.messages.create(toAnthropicRequest(request, opts));
    } catch (error) {
      throw toProviderError(error);
    }

    return normalize(message);
  }
}

/**
 * Translate the agnostic request into Anthropic's non-streaming request shape.
 *
 * Two translations do real work. System turns are lifted out of `messages` into
 * the top-level `system` parameter — Anthropic's `messages` is for the
 * user/assistant exchange — and several of them are joined rather than the last
 * one winning, so no instruction the client sent is silently dropped.
 * `max_tokens` is required by this provider, so {@link ProviderCallOptions
 * .defaultMaxTokens} fills in when the client omitted one (Req 3.4).
 *
 * `stream: false` pins the single-response contract (Req 3.5). Everything else
 * is a rename: `topP` → `top_p`, `stop` → `stop_sequences`.
 *
 * A conversation of nothing but system turns leaves `messages` empty, which
 * Anthropic rejects with a 400. That is left to surface as an `upstream_error`
 * rather than pre-empted here: the adapter's error kinds describe provider
 * outcomes, and inventing a client-validation kind would widen the shared seam.
 */
function toAnthropicRequest(
  request: ChatCompletionRequest,
  opts: ProviderCallOptions,
): Anthropic.MessageCreateParamsNonStreaming {
  const system = request.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join(SYSTEM_SEPARATOR);

  const body: Anthropic.MessageCreateParamsNonStreaming = {
    model: request.model,
    messages: request.messages
      .filter(
        (message): message is ChatMessage & { role: 'user' | 'assistant' } =>
          message.role !== 'system',
      )
      .map((message) => ({
        role: message.role,
        content: message.content,
      })),
    max_tokens: request.maxTokens ?? opts.defaultMaxTokens,
    stream: false,
  };
  if (system !== '') body.system = system;
  /*
   * `temperature` is clamped rather than rejected so one agnostic request stays
   * servable by every provider — resilience-failover later retries the same
   * request against a different one, and a hard rejection here would break that.
   *
   * The SDK marks both sampling params deprecated: models after Claude Opus 4.6
   * accept only `temperature` 1.0 and `top_p` >= 0.99. That is a per-model rule
   * the adapter cannot evaluate — the same gateway serves older Claude models
   * where both are fully supported — so a value the client set is forwarded
   * rather than silently dropped, and a model that no longer accepts it answers
   * with its own 400.
   */
  /* eslint-disable @typescript-eslint/no-deprecated -- deliberate; see above. */
  if (request.temperature !== undefined) {
    body.temperature = Math.min(request.temperature, MAX_TEMPERATURE);
  }
  if (request.topP !== undefined) body.top_p = request.topP;
  /* eslint-enable @typescript-eslint/no-deprecated */
  if (request.stop !== undefined) body.stop_sequences = request.stop;
  return body;
}

/**
 * Normalize an Anthropic message into the unified response. The resolved model
 * comes from the reply, not the request (Req 2.4).
 *
 * Anthropic returns content as a list of typed blocks; the text blocks are
 * concatenated with no separator, since consecutive ones are pieces of one
 * continuous reply. Non-text blocks (thinking, tool use) carry no client-visible
 * message text and are skipped, so a tool-call reply normalizes to empty content
 * the same way OpenAI's does rather than leaking a provider-specific shape.
 */
function normalize(message: Anthropic.Message): NormalizedResponse {
  // A base URL can point at a proxy, so the body is not guaranteed to be an
  // Anthropic message however it is typed. A reply with no content list cannot
  // be normalized at all, which is a different failure from an empty one.
  if (!Array.isArray(message.content)) {
    throw new ProviderError('Anthropic returned no content blocks', {
      provider: 'anthropic',
      kind: 'invalid_response',
    });
  }

  const content = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  return {
    id: message.id,
    provider: 'anthropic',
    model: message.model,
    message: { role: 'assistant', content },
    usage: mapAnthropicUsage(message.usage),
    finishReason: mapAnthropicStopReason(message.stop_reason),
  };
}

/**
 * Map an upstream failure onto a credential-free {@link ProviderError}. The SDK
 * error object is deliberately not passed through as the cause: it can carry the
 * request headers, and therefore the tenant key (Req 4.3). Only a fresh error
 * holding the message is kept for diagnostics.
 */
function toProviderError(error: unknown): ProviderError {
  const cause = redactedCause(error);

  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new ProviderError('Anthropic request timed out', {
      provider: 'anthropic',
      kind: 'timeout',
      cause,
    });
  }

  if (error instanceof Anthropic.APIError) {
    return new ProviderError('Anthropic request failed', {
      provider: 'anthropic',
      kind: 'upstream_error',
      // APIError carries a status for HTTP failures and `undefined` otherwise;
      // only attach a real one (exactOptionalPropertyTypes).
      ...(typeof error.status === 'number' ? { status: error.status } : {}),
      cause,
    });
  }

  return new ProviderError('Anthropic request failed', {
    provider: 'anthropic',
    kind: 'upstream_error',
    cause,
  });
}

/**
 * A diagnostic-only cause that drops the SDK error object (headers/secret) and
 * keeps just its message. Anthropic builds its error messages from the response
 * body, which never echoes the key, so the message is safe to retain.
 */
function redactedCause(error: unknown): Error {
  return new Error(error instanceof Error ? error.message : String(error));
}
