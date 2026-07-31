import OpenAI from 'openai';
import type { ProviderName, ProviderSecret } from '#src/modules/auth/types.js';
import {
  ProviderError,
  type ChatCompletionRequest,
  type NormalizedResponse,
  type ProviderAdapter,
  type ProviderCallOptions,
} from '../types.js';
import { mapOpenAiFinishReason, mapOpenAiUsage } from './mapping.js';

/**
 * OpenAI adapter for the shared {@link ProviderAdapter} seam.
 *
 * Translates the provider-agnostic {@link ChatCompletionRequest} into an OpenAI
 * Chat Completions call and normalizes the reply back into the unified
 * {@link NormalizedResponse}. All OpenAI-specific request and response shapes are
 * confined to this file — nothing provider-specific crosses the adapter boundary
 * (Req 3.4, 4.1, 4.2).
 *
 * The tenant's BYOK key is revealed only here, at the HTTP boundary, and is used
 * to build a fresh per-call client with retries disabled and the per-call
 * timeout applied (Req 3.2, 3.5). It is never logged, returned, or attached to a
 * {@link ProviderError} (Req 4.3).
 */

/** Per-call OpenAI client options the adapter builds from config + credential. */
export interface OpenAiClientOptions {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly maxRetries: number;
  readonly timeout: number;
}

/**
 * The slice of the OpenAI client the adapter actually uses. Narrowed to the one
 * non-streaming call so the client can be substituted in tests without standing
 * up the whole SDK.
 */
export interface OpenAiChatClient {
  readonly chat: {
    readonly completions: {
      create(
        body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
      ): Promise<OpenAI.Chat.Completions.ChatCompletion>;
    };
  };
}

/** Builds a per-request client; injectable so tests can stub the upstream call. */
export type OpenAiClientFactory = (
  options: OpenAiClientOptions,
) => OpenAiChatClient;

/** Deployment-side config the adapter captures (the per-call opts carry the rest). */
export interface OpenAiAdapterConfig {
  readonly baseUrl: string;
}

/** Real client factory: a fresh SDK client per call, keyed by the tenant secret. */
const defaultClientFactory: OpenAiClientFactory = (options) =>
  new OpenAI(options);

/**
 * The OpenAI Chat Completions adapter.
 *
 * Holds only deployment config and the client factory: the tenant credential and
 * the per-call options arrive on each {@link OpenAiAdapter.complete} call, so one
 * instance serves every tenant and every request.
 */
export class OpenAiAdapter implements ProviderAdapter {
  readonly name: ProviderName = 'openai';

  readonly #config: OpenAiAdapterConfig;
  readonly #createClient: OpenAiClientFactory;

  /**
   * @param config - Provider base URL (from the gateway config).
   * @param createClient - Client factory; defaults to the real OpenAI SDK.
   */
  constructor(
    config: OpenAiAdapterConfig,
    createClient: OpenAiClientFactory = defaultClientFactory,
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
    });

    let completion: OpenAI.Chat.Completions.ChatCompletion;
    try {
      completion = await client.chat.completions.create(
        toOpenAiRequest(request),
      );
    } catch (error) {
      throw toProviderError(error);
    }

    return normalize(completion);
  }
}

/**
 * Translate the agnostic request into OpenAI's non-streaming request shape. Only
 * params the client supplied are forwarded; the roles and content already match
 * OpenAI's message shape one-to-one. `stream: false` pins the single-response
 * contract (Req 3.5). OpenAI needs no default max-tokens, so one is sent only
 * when the client asked for it — via `max_completion_tokens`, the current field
 * (`max_tokens` is deprecated and rejected by o-series models).
 */
function toOpenAiRequest(
  request: ChatCompletionRequest,
): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
  const body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
    model: request.model,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    stream: false,
  };
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.maxTokens !== undefined) {
    body.max_completion_tokens = request.maxTokens;
  }
  if (request.topP !== undefined) body.top_p = request.topP;
  if (request.stop !== undefined) body.stop = request.stop;
  return body;
}

/**
 * Normalize an OpenAI completion into the unified response. The resolved model
 * comes from the reply, not the request (Req 2.4). A reply with no choice cannot
 * be normalized, so it surfaces as an `invalid_response` error rather than an
 * empty message.
 */
function normalize(
  completion: OpenAI.Chat.Completions.ChatCompletion,
): NormalizedResponse {
  const choice = completion.choices[0];
  if (choice === undefined) {
    throw new ProviderError('OpenAI returned no completion choices', {
      provider: 'openai',
      kind: 'invalid_response',
    });
  }

  return {
    id: completion.id,
    provider: 'openai',
    model: completion.model,
    message: {
      role: 'assistant',
      content: choice.message.content ?? '',
    },
    usage: mapOpenAiUsage(completion.usage),
    finishReason: mapOpenAiFinishReason(choice.finish_reason),
  };
}

/**
 * Map an upstream failure onto a credential-free {@link ProviderError}. The SDK
 * error object is deliberately not passed through as the cause: it can carry the
 * request headers, and therefore the tenant key (note 1.1, Req 4.3). Only a
 * fresh error holding the (key-masked) message is kept for diagnostics.
 */
function toProviderError(error: unknown): ProviderError {
  const cause = redactedCause(error);

  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return new ProviderError('OpenAI request timed out', {
      provider: 'openai',
      kind: 'timeout',
      cause,
    });
  }

  if (error instanceof OpenAI.APIError) {
    return new ProviderError('OpenAI request failed', {
      provider: 'openai',
      kind: 'upstream_error',
      // APIError carries a status for HTTP failures and `undefined` otherwise;
      // only attach a real one (exactOptionalPropertyTypes).
      ...(typeof error.status === 'number' ? { status: error.status } : {}),
      cause,
    });
  }

  return new ProviderError('OpenAI request failed', {
    provider: 'openai',
    kind: 'upstream_error',
    cause,
  });
}

/**
 * A diagnostic-only cause that drops the SDK error object (headers/secret) and
 * keeps just its message. OpenAI masks the key in its own error messages, so the
 * message is safe to retain.
 */
function redactedCause(error: unknown): Error {
  return new Error(error instanceof Error ? error.message : String(error));
}
