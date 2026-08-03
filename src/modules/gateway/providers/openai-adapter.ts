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

export interface OpenAiClientOptions {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly maxRetries: number;
  readonly timeout: number;
}

/** Narrowed to the one call used, so tests can stub it without the whole SDK. */
export interface OpenAiChatClient {
  readonly chat: {
    readonly completions: {
      create(
        body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
      ): Promise<OpenAI.Chat.Completions.ChatCompletion>;
    };
  };
}

export type OpenAiClientFactory = (
  options: OpenAiClientOptions,
) => OpenAiChatClient;

export interface OpenAiAdapterConfig {
  readonly baseUrl: string;
}

const defaultClientFactory: OpenAiClientFactory = (options) =>
  new OpenAI(options);

/**
 * Holds only deployment config and the client factory — the tenant credential
 * and per-call options arrive per call, so one instance serves every tenant.
 */
export class OpenAiAdapter implements ProviderAdapter {
  readonly name: ProviderName = 'openai';

  readonly #config: OpenAiAdapterConfig;
  readonly #createClient: OpenAiClientFactory;

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
      // Retries are owned by resilience-failover, not the adapter.
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
 * Roles and content already match OpenAI's message shape one-to-one. The one
 * wrinkle is the token cap: `max_completion_tokens` is the current field, and
 * the older `max_tokens` is deprecated and rejected by o-series models.
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
    // The model the provider reports serving, not the one requested.
    model: completion.model,
    message: {
      role: 'assistant',
      content: choice.message.content ?? '',
    },
    usage: mapOpenAiUsage(completion.usage),
    finishReason: mapOpenAiFinishReason(choice.finish_reason),
  };
}

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
 * Drops the SDK error object, which can carry the request headers and therefore
 * the tenant key, and keeps only its message. OpenAI masks the key in its own
 * error messages.
 */
function redactedCause(error: unknown): Error {
  return new Error(error instanceof Error ? error.message : String(error));
}
