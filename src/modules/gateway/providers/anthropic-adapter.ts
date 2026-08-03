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
 * Anthropic's ceiling for `temperature`. The boundary schema admits 0-2 (the
 * widest of the three providers), so a value in (1, 2] is valid input that this
 * provider would reject.
 */
const MAX_TEMPERATURE = 1;

/** A blank line keeps two joined system instructions from reading as one sentence. */
const SYSTEM_SEPARATOR = '\n\n';

export interface AnthropicClientOptions {
  readonly apiKey: string;
  readonly baseURL: string;
  readonly maxRetries: number;
  readonly timeout: number;
  /** Carries `anthropic-version`; the SDK derives `x-api-key` from `apiKey`. */
  readonly defaultHeaders: Readonly<Record<string, string>>;
}

/** Narrowed to the one call used, so tests can stub it without the whole SDK. */
export interface AnthropicMessagesClient {
  readonly messages: {
    create(
      body: Anthropic.MessageCreateParamsNonStreaming,
    ): Promise<Anthropic.Message>;
  };
}

export type AnthropicClientFactory = (
  options: AnthropicClientOptions,
) => AnthropicMessagesClient;

export interface AnthropicAdapterConfig {
  readonly baseUrl: string;
  /** Value for the `anthropic-version` header, pinned by the gateway config. */
  readonly version: string;
}

const defaultClientFactory: AnthropicClientFactory = (options) =>
  new Anthropic(options);

/**
 * Holds only deployment config and the client factory — the tenant credential
 * and per-call options arrive per call, so one instance serves every tenant.
 */
export class AnthropicAdapter implements ProviderAdapter {
  readonly name: ProviderName = 'anthropic';

  readonly #config: AnthropicAdapterConfig;
  readonly #createClient: AnthropicClientFactory;

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
      // Retries are owned by resilience-failover, not the adapter.
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
 * Anthropic keeps system turns in a top-level param rather than in `messages`,
 * and requires `max_tokens`. Several system turns are joined rather than
 * last-wins, so no instruction the client sent is silently dropped.
 *
 * A conversation of nothing but system turns leaves `messages` empty, which
 * Anthropic rejects with a 400. That is left to surface as an `upstream_error`
 * rather than pre-empted here: inventing a client-validation error kind would
 * widen the shared adapter seam.
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
   * Clamped rather than rejected so one agnostic request stays servable by every
   * provider — resilience-failover retries the same request against a different
   * one, and a hard rejection here would break that.
   *
   * The SDK marks both sampling params deprecated: models after Claude Opus 4.6
   * accept only `temperature` 1.0 and `top_p` >= 0.99. That is a per-model rule
   * this adapter cannot evaluate, since the same gateway also serves older
   * Claude models, so a client-set value is forwarded and a model that no longer
   * accepts it answers with its own 400.
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
 * Text blocks are concatenated with no separator, since consecutive ones are
 * pieces of one continuous reply. Non-text blocks (thinking, tool use) carry no
 * client-visible text, so a tool-call reply normalizes to empty content the same
 * way OpenAI's does rather than leaking a provider-specific shape.
 */
function normalize(message: Anthropic.Message): NormalizedResponse {
  // A base URL can point at a proxy, so the body is not guaranteed to be an
  // Anthropic message however it is typed.
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
    // The model the provider reports serving, not the one requested.
    model: message.model,
    message: { role: 'assistant', content },
    usage: mapAnthropicUsage(message.usage),
    finishReason: mapAnthropicStopReason(message.stop_reason),
  };
}

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
 * Drops the SDK error object, which can carry the request headers and therefore
 * the tenant key, and keeps only its message. Anthropic builds error messages
 * from the response body, which never echoes the key.
 */
function redactedCause(error: unknown): Error {
  return new Error(error instanceof Error ? error.message : String(error));
}
