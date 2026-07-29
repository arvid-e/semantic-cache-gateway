import Anthropic from '@anthropic-ai/sdk';
import { ProviderSecret } from '#src/modules/auth/types.js';
import { ProviderError, type ChatCompletionRequest } from '../types.js';
import {
  createAnthropicAdapter,
  type AnthropicClientFactory,
  type AnthropicClientOptions,
  type AnthropicMessagesClient,
} from './anthropic-adapter.js';

/** A revealable secret whose plaintext we assert never escapes into an error. */
const SECRET = 'sk-ant-tenant-super-secret-key';

const BASE_OPTS = { timeoutMs: 15_000, defaultMaxTokens: 1024 } as const;

const CONFIG = {
  baseUrl: 'https://api.anthropic.com',
  version: '2023-06-01',
} as const;

const REQUEST: ChatCompletionRequest = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-5',
  messages: [
    { role: 'system', content: 'You are terse.' },
    { role: 'user', content: 'Hi there.' },
  ],
  temperature: 0.5,
  maxTokens: 256,
  topP: 0.9,
  stop: ['\n\n'],
};

/** A single text content block, spelled out because `citations` is required. */
function textBlock(text: string): Anthropic.TextBlock {
  return { type: 'text', text, citations: null };
}

/** Anthropic's usage object; only the two token counts carry meaning for us. */
function usage(inputTokens: number, outputTokens: number): Anthropic.Usage {
  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_creation: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    inference_geo: null,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
  };
}

/** A representative successful Anthropic reply. */
function stubMessage(
  overrides: Partial<Anthropic.Message> = {},
): Anthropic.Message {
  return {
    id: 'msg_01ABCdef',
    type: 'message',
    role: 'assistant',
    // The provider echoes the *resolved* model, which differs from the request.
    model: 'claude-sonnet-4-5-20250929',
    content: [textBlock('Hello.')],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    container: null,
    usage: usage(11, 3),
    ...overrides,
  };
}

/**
 * A stub client factory that records what the adapter built and returns (or
 * throws) a canned result.
 */
function stubFactory(
  result: { readonly ok: Anthropic.Message } | { readonly err: unknown },
): {
  readonly factory: AnthropicClientFactory;
  readonly seen: {
    options?: AnthropicClientOptions;
    body?: Anthropic.MessageCreateParamsNonStreaming;
    calls: number;
  };
} {
  const seen = { calls: 0 } as {
    options?: AnthropicClientOptions;
    body?: Anthropic.MessageCreateParamsNonStreaming;
    calls: number;
  };

  const client: AnthropicMessagesClient = {
    messages: {
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
  };

  return {
    seen,
    factory: (options) => {
      seen.options = options;
      return client;
    },
  };
}

describe('Anthropic adapter', () => {
  it('exposes the anthropic provider name', () => {
    const adapter = createAnthropicAdapter(CONFIG);
    expect(adapter.name).toBe('anthropic');
  });

  it('builds a per-call client with the revealed key, base URL, version header, no retries, and the timeout', async () => {
    const { factory, seen } = stubFactory({ ok: stubMessage() });
    const adapter = createAnthropicAdapter(
      { baseUrl: 'https://proxy.internal/anthropic', version: '2024-10-22' },
      factory,
    );

    await adapter.complete(REQUEST, new ProviderSecret(SECRET), BASE_OPTS);

    expect(seen.options).toEqual({
      apiKey: SECRET,
      baseURL: 'https://proxy.internal/anthropic',
      maxRetries: 0,
      timeout: BASE_OPTS.timeoutMs,
      defaultHeaders: { 'anthropic-version': '2024-10-22' },
    });
  });

  it('lifts system messages into the top-level system parameter', async () => {
    const { factory, seen } = stubFactory({ ok: stubMessage() });
    const adapter = createAnthropicAdapter(CONFIG, factory);

    await adapter.complete(REQUEST, new ProviderSecret(SECRET), BASE_OPTS);

    expect(seen.body?.system).toBe('You are terse.');
    expect(seen.body?.messages).toEqual([{ role: 'user', content: 'Hi there.' }]);
  });

  it('joins several system messages into one system parameter, wherever they sit', async () => {
    const { factory, seen } = stubFactory({ ok: stubMessage() });
    const adapter = createAnthropicAdapter(CONFIG, factory);

    await adapter.complete(
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        messages: [
          { role: 'system', content: 'Be terse.' },
          { role: 'user', content: 'Hi.' },
          { role: 'assistant', content: 'Hey.' },
          { role: 'system', content: 'Answer in English.' },
          { role: 'user', content: 'Again?' },
        ],
      },
      new ProviderSecret(SECRET),
      BASE_OPTS,
    );

    expect(seen.body?.system).toBe('Be terse.\n\nAnswer in English.');
    expect(seen.body?.messages).toEqual([
      { role: 'user', content: 'Hi.' },
      { role: 'assistant', content: 'Hey.' },
      { role: 'user', content: 'Again?' },
    ]);
  });

  it('omits the system parameter when the conversation has no system message', async () => {
    const { factory, seen } = stubFactory({ ok: stubMessage() });
    const adapter = createAnthropicAdapter(CONFIG, factory);

    await adapter.complete(
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'hi' }],
      },
      new ProviderSecret(SECRET),
      BASE_OPTS,
    );

    expect(seen.body).not.toHaveProperty('system');
  });

  it('translates the agnostic request into a non-streaming Anthropic request', async () => {
    const { factory, seen } = stubFactory({ ok: stubMessage() });
    const adapter = createAnthropicAdapter(CONFIG, factory);

    await adapter.complete(REQUEST, new ProviderSecret(SECRET), BASE_OPTS);

    expect(seen.body).toEqual({
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'Hi there.' }],
      system: 'You are terse.',
      max_tokens: 256,
      stream: false,
      temperature: 0.5,
      top_p: 0.9,
      stop_sequences: ['\n\n'],
    });
  });

  it('supplies the default max tokens when the client omitted one', async () => {
    const { factory, seen } = stubFactory({ ok: stubMessage() });
    const adapter = createAnthropicAdapter(CONFIG, factory);

    await adapter.complete(
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'hi' }],
      },
      new ProviderSecret(SECRET),
      BASE_OPTS,
    );

    expect(seen.body?.max_tokens).toBe(BASE_OPTS.defaultMaxTokens);
  });

  it('clamps a temperature above the Anthropic maximum instead of failing the call', async () => {
    const { factory, seen } = stubFactory({ ok: stubMessage() });
    const adapter = createAnthropicAdapter(CONFIG, factory);

    await adapter.complete(
      {
        provider: 'anthropic',
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 1.7,
      },
      new ProviderSecret(SECRET),
      BASE_OPTS,
    );

    // eslint-disable-next-line @typescript-eslint/no-deprecated -- asserting the adapter's clamp; see the request translator.
    expect(seen.body?.temperature).toBe(1);
  });

  it('normalizes a successful reply to the unified schema with the resolved model', async () => {
    const { factory } = stubFactory({ ok: stubMessage() });
    const adapter = createAnthropicAdapter(CONFIG, factory);

    const result = await adapter.complete(
      REQUEST,
      new ProviderSecret(SECRET),
      BASE_OPTS,
    );

    expect(result).toEqual({
      id: 'msg_01ABCdef',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      message: { role: 'assistant', content: 'Hello.' },
      usage: { promptTokens: 11, completionTokens: 3, totalTokens: 14 },
      finishReason: 'stop',
    });
  });

  it('concatenates the text content blocks and ignores non-text blocks', async () => {
    const { factory } = stubFactory({
      ok: stubMessage({
        content: [
          { type: 'thinking', thinking: 'hidden reasoning', signature: 'sig' },
          textBlock('Part one. '),
          textBlock('Part two.'),
        ],
        stop_reason: 'tool_use',
      }),
    });
    const adapter = createAnthropicAdapter(CONFIG, factory);

    const result = await adapter.complete(
      REQUEST,
      new ProviderSecret(SECRET),
      BASE_OPTS,
    );

    expect(result.message.content).toBe('Part one. Part two.');
    expect(result.finishReason).toBe('tool_use');
  });

  it('yields empty content for a reply carrying no text block', async () => {
    const { factory } = stubFactory({ ok: stubMessage({ content: [] }) });
    const adapter = createAnthropicAdapter(CONFIG, factory);

    const result = await adapter.complete(
      REQUEST,
      new ProviderSecret(SECRET),
      BASE_OPTS,
    );

    expect(result.message.content).toBe('');
  });

  it('computes the token total as input plus output, since Anthropic reports none', async () => {
    const { factory } = stubFactory({
      ok: stubMessage({ usage: usage(120, 37) }),
    });
    const adapter = createAnthropicAdapter(CONFIG, factory);

    const result = await adapter.complete(
      REQUEST,
      new ProviderSecret(SECRET),
      BASE_OPTS,
    );

    expect(result.usage).toEqual({
      promptTokens: 120,
      completionTokens: 37,
      totalTokens: 157,
    });
  });

  it('carries no provider-specific fields into the normalized response', async () => {
    const { factory } = stubFactory({ ok: stubMessage() });
    const adapter = createAnthropicAdapter(CONFIG, factory);

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

  it('maps the Anthropic stop reason onto the closed union', async () => {
    const { factory } = stubFactory({
      ok: stubMessage({ stop_reason: 'max_tokens' }),
    });
    const adapter = createAnthropicAdapter(CONFIG, factory);

    const result = await adapter.complete(
      REQUEST,
      new ProviderSecret(SECRET),
      BASE_OPTS,
    );

    expect(result.finishReason).toBe('length');
  });

  it('surfaces a reply with no content array as an invalid_response error', async () => {
    const { factory } = stubFactory({
      // A non-Anthropic body from an overridden base URL: the SDK hands it back
      // untyped, so the cast reproduces what actually reaches the adapter.
      ok: stubMessage({
        content: undefined as unknown as Anthropic.Message['content'],
      }),
    });
    const adapter = createAnthropicAdapter(CONFIG, factory);

    await expect(
      adapter.complete(REQUEST, new ProviderSecret(SECRET), BASE_OPTS),
    ).rejects.toMatchObject({
      name: 'ProviderError',
      provider: 'anthropic',
      kind: 'invalid_response',
    });
  });

  it('maps an HTTP failure to an upstream_error ProviderError with the status', async () => {
    const apiError = new Anthropic.APIError(
      429,
      { error: { message: 'rate limited' } },
      'rate limited',
      new Headers(),
    );
    const { factory } = stubFactory({ err: apiError });
    const adapter = createAnthropicAdapter(CONFIG, factory);

    const error = await adapter
      .complete(REQUEST, new ProviderSecret(SECRET), BASE_OPTS)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      provider: 'anthropic',
      kind: 'upstream_error',
      status: 429,
    });
  });

  it('maps a timeout to a timeout ProviderError with no status', async () => {
    const timeout = new Anthropic.APIConnectionTimeoutError({
      message: 'timed out',
    });
    const { factory } = stubFactory({ err: timeout });
    const adapter = createAnthropicAdapter(CONFIG, factory);

    const error = (await adapter
      .complete(REQUEST, new ProviderSecret(SECRET), BASE_OPTS)
      .catch((caught: unknown) => caught)) as ProviderError;

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.kind).toBe('timeout');
    expect(error.status).toBeUndefined();
  });

  it('never lets the credential escape into the thrown error', async () => {
    // An auth-style failure whose headers carry the key — the adapter must still
    // not carry the real tenant secret anywhere on the error.
    const apiError = new Anthropic.APIError(
      401,
      { error: { message: 'invalid x-api-key' } },
      'invalid x-api-key',
      new Headers({ 'x-api-key': SECRET }),
    );
    const { factory } = stubFactory({ err: apiError });
    const adapter = createAnthropicAdapter(CONFIG, factory);

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
