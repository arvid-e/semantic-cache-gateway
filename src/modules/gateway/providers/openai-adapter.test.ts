import OpenAI from 'openai';
import { ProviderSecret } from '#src/modules/auth/types.js';
import { ProviderError, type ChatCompletionRequest } from '../types.js';
import {
  createOpenAiAdapter,
  type OpenAiChatClient,
  type OpenAiClientFactory,
  type OpenAiClientOptions,
} from './openai-adapter.js';

/** A revealable secret whose plaintext we assert never escapes into an error. */
const SECRET = 'sk-tenant-super-secret-key';

const BASE_OPTS = { timeoutMs: 15_000, defaultMaxTokens: 1024 } as const;

const REQUEST: ChatCompletionRequest = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  messages: [
    { role: 'system', content: 'You are terse.' },
    { role: 'user', content: 'Hi there.' },
  ],
  temperature: 0.5,
  maxTokens: 256,
  topP: 0.9,
  stop: ['\n\n'],
};

/** A representative successful OpenAI reply. */
function stubCompletion(
  overrides: Partial<OpenAI.Chat.Completions.ChatCompletion> = {},
): OpenAI.Chat.Completions.ChatCompletion {
  return {
    id: 'chatcmpl-abc123',
    object: 'chat.completion',
    created: 1_700_000_000,
    // The provider echoes the *resolved* model, which differs from the request.
    model: 'gpt-4o-mini-2024-07-18',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        logprobs: null,
        message: {
          role: 'assistant',
          content: 'Hello.',
          refusal: null,
        },
      },
    ],
    usage: {
      prompt_tokens: 11,
      completion_tokens: 3,
      total_tokens: 14,
    },
    ...overrides,
  };
}

/**
 * A stub client factory that records what the adapter built and returns (or
 * throws) a canned result.
 */
function stubFactory(
  result:
    | { readonly ok: OpenAI.Chat.Completions.ChatCompletion }
    | { readonly err: unknown },
): {
  readonly factory: OpenAiClientFactory;
  readonly seen: {
    options?: OpenAiClientOptions;
    body?: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
    calls: number;
  };
} {
  const seen = { calls: 0 } as {
    options?: OpenAiClientOptions;
    body?: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;
    calls: number;
  };

  const client: OpenAiChatClient = {
    chat: {
      completions: {
        create(body) {
          seen.calls += 1;
          seen.body = body;
          if ('err' in result) {
            const reason =
              result.err instanceof Error
                ? result.err
                : new Error(String(result.err));
            return Promise.reject(reason);
          }
          return Promise.resolve(result.ok);
        },
      },
    },
  };

  return {
    seen,
    factory: (options) => {
      seen.options = options;
      return client;
    },
  };
}

describe('OpenAI adapter', () => {
  it('exposes the openai provider name', () => {
    const adapter = createOpenAiAdapter({ baseUrl: 'https://api.openai.com/v1' });
    expect(adapter.name).toBe('openai');
  });

  it('builds a per-call client with the revealed key, base URL, no retries, and the timeout', async () => {
    const { factory, seen } = stubFactory({ ok: stubCompletion() });
    const adapter = createOpenAiAdapter(
      { baseUrl: 'https://proxy.internal/openai' },
      factory,
    );

    await adapter.complete(REQUEST, new ProviderSecret(SECRET), BASE_OPTS);

    expect(seen.options).toEqual({
      apiKey: SECRET,
      baseURL: 'https://proxy.internal/openai',
      maxRetries: 0,
      timeout: BASE_OPTS.timeoutMs,
    });
  });

  it('translates the agnostic request into a non-streaming OpenAI request', async () => {
    const { factory, seen } = stubFactory({ ok: stubCompletion() });
    const adapter = createOpenAiAdapter({ baseUrl: 'https://x' }, factory);

    await adapter.complete(REQUEST, new ProviderSecret(SECRET), BASE_OPTS);

    expect(seen.body).toEqual({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: 'Hi there.' },
      ],
      stream: false,
      temperature: 0.5,
      max_completion_tokens: 256,
      top_p: 0.9,
      stop: ['\n\n'],
    });
  });

  it('omits optional params the client did not supply', async () => {
    const { factory, seen } = stubFactory({ ok: stubCompletion() });
    const adapter = createOpenAiAdapter({ baseUrl: 'https://x' }, factory);

    await adapter.complete(
      { provider: 'openai', model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] },
      new ProviderSecret(SECRET),
      BASE_OPTS,
    );

    expect(seen.body).toEqual({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });
  });

  it('normalizes a successful reply to the unified schema with the resolved model', async () => {
    const { factory } = stubFactory({ ok: stubCompletion() });
    const adapter = createOpenAiAdapter({ baseUrl: 'https://x' }, factory);

    const result = await adapter.complete(
      REQUEST,
      new ProviderSecret(SECRET),
      BASE_OPTS,
    );

    expect(result).toEqual({
      id: 'chatcmpl-abc123',
      provider: 'openai',
      model: 'gpt-4o-mini-2024-07-18',
      message: { role: 'assistant', content: 'Hello.' },
      usage: { promptTokens: 11, completionTokens: 3, totalTokens: 14 },
      finishReason: 'stop',
    });
  });

  it('carries no provider-specific fields into the normalized response', async () => {
    const { factory } = stubFactory({ ok: stubCompletion() });
    const adapter = createOpenAiAdapter({ baseUrl: 'https://x' }, factory);

    const result = await adapter.complete(
      REQUEST,
      new ProviderSecret(SECRET),
      BASE_OPTS,
    );

    expect(Object.keys(result).sort()).toEqual([
      'finishReason',
      'id',
      'message',
      'model',
      'provider',
      'usage',
    ]);
  });

  it('maps the OpenAI finish reason onto the closed union', async () => {
    const { factory } = stubFactory({
      ok: stubCompletion({
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            logprobs: null,
            message: { role: 'assistant', content: '', refusal: null },
          },
        ],
      }),
    });
    const adapter = createOpenAiAdapter({ baseUrl: 'https://x' }, factory);

    const result = await adapter.complete(
      REQUEST,
      new ProviderSecret(SECRET),
      BASE_OPTS,
    );

    expect(result.finishReason).toBe('tool_use');
  });

  it('treats a null message content as an empty string', async () => {
    const { factory } = stubFactory({
      ok: stubCompletion({
        choices: [
          {
            index: 0,
            finish_reason: 'content_filter',
            logprobs: null,
            message: { role: 'assistant', content: null, refusal: null },
          },
        ],
      }),
    });
    const adapter = createOpenAiAdapter({ baseUrl: 'https://x' }, factory);

    const result = await adapter.complete(
      REQUEST,
      new ProviderSecret(SECRET),
      BASE_OPTS,
    );

    expect(result.message.content).toBe('');
  });

  it('surfaces a reply with no choices as an invalid_response error', async () => {
    const { factory } = stubFactory({ ok: stubCompletion({ choices: [] }) });
    const adapter = createOpenAiAdapter({ baseUrl: 'https://x' }, factory);

    await expect(
      adapter.complete(REQUEST, new ProviderSecret(SECRET), BASE_OPTS),
    ).rejects.toMatchObject({
      name: 'ProviderError',
      provider: 'openai',
      kind: 'invalid_response',
    });
  });

  it('maps an HTTP failure to an upstream_error ProviderError with the status', async () => {
    const apiError = new OpenAI.APIError(
      429,
      { error: { message: 'rate limited' } },
      'rate limited',
      new Headers(),
    );
    const { factory } = stubFactory({ err: apiError });
    const adapter = createOpenAiAdapter({ baseUrl: 'https://x' }, factory);

    const error = await adapter
      .complete(REQUEST, new ProviderSecret(SECRET), BASE_OPTS)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      provider: 'openai',
      kind: 'upstream_error',
      status: 429,
    });
  });

  it('maps a timeout to a timeout ProviderError with no status', async () => {
    const timeout = new OpenAI.APIConnectionTimeoutError({ message: 'timed out' });
    const { factory } = stubFactory({ err: timeout });
    const adapter = createOpenAiAdapter({ baseUrl: 'https://x' }, factory);

    const error = (await adapter
      .complete(REQUEST, new ProviderSecret(SECRET), BASE_OPTS)
      .catch((caught: unknown) => caught)) as ProviderError;

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.kind).toBe('timeout');
    expect(error.status).toBeUndefined();
  });

  it('never lets the credential escape into the thrown error', async () => {
    // An auth-style failure whose message *does* mention a key — the adapter must
    // still not carry the real tenant secret anywhere on the error.
    const apiError = new OpenAI.APIError(
      401,
      { error: { message: 'Incorrect API key provided' } },
      'Incorrect API key provided',
      new Headers({ authorization: `Bearer ${SECRET}` }),
    );
    const { factory } = stubFactory({ err: apiError });
    const adapter = createOpenAiAdapter({ baseUrl: 'https://x' }, factory);

    const error = (await adapter
      .complete(REQUEST, new ProviderSecret(SECRET), BASE_OPTS)
      .catch((caught: unknown) => caught)) as ProviderError;

    // Neither the error nor its cause chain (serialized) may contain the secret.
    const serialized = JSON.stringify({
      message: error.message,
      cause: (error.cause as Error | undefined)?.message,
      stack: error.stack,
    });
    expect(serialized).not.toContain(SECRET);
    // The SDK error object (which holds the auth header) is not the cause.
    expect(error.cause).not.toBe(apiError);
  });
});
