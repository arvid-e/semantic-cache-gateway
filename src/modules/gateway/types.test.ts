import {
  PROVIDER_NAMES,
  ProviderSecret,
  type ProviderName,
} from '#src/modules/auth/types.js';
import {
  FINISH_REASONS,
  ProviderError,
  type ChatCompletionRequest,
  type NormalizedResponse,
  type ProviderAdapter,
  type ProviderCallOptions,
} from './types.js';

const RAW_KEY = 'sk-tenant-byok-secret';

const CALL_OPTIONS: ProviderCallOptions = {
  timeoutMs: 30_000,
  defaultMaxTokens: 1024,
};

const conversation: ChatCompletionRequest = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  messages: [
    { role: 'system', content: 'You are terse.' },
    { role: 'user', content: 'What is pgvector?' },
    { role: 'assistant', content: 'A Postgres extension for vectors.' },
    { role: 'user', content: 'And how do I index it?' },
  ],
  temperature: 0.2,
  maxTokens: 256,
  topP: 0.9,
  stop: ['\n\n'],
};

/**
 * Stands in for a real adapter: it is only used to exercise the shared contract
 * (return type, credential handling), never a provider.
 */
class StubAdapter implements ProviderAdapter {
  readonly name: ProviderName = 'openai';
  /** Records that the secret was revealed inside the adapter, not outside it. */
  revealedInsideAdapter: string | null = null;

  complete(
    request: ChatCompletionRequest,
    credential: ProviderSecret,
    opts: ProviderCallOptions,
  ): Promise<NormalizedResponse> {
    this.revealedInsideAdapter = credential.reveal();
    return Promise.resolve({
      id: 'resp_1',
      provider: this.name,
      model: `${request.model}-2024-07-18`,
      message: { role: 'assistant', content: 'Use an HNSW index.' },
      usage: {
        promptTokens: 12,
        completionTokens: 5,
        totalTokens: 17,
      },
      finishReason: opts.defaultMaxTokens > 0 ? 'stop' : 'length',
    });
  }
}

describe('supported providers', () => {
  it('is exactly the three providers the auth seam defines', () => {
    expect([...PROVIDER_NAMES]).toEqual(['openai', 'anthropic', 'ollama']);
    expect(PROVIDER_NAMES).toHaveLength(3);
  });

  it('types a request per supported provider without widening', () => {
    const requests = PROVIDER_NAMES.map((provider): ChatCompletionRequest => ({
      provider,
      model: 'some-model',
      messages: [{ role: 'user', content: 'hi' }],
    }));

    expect(requests.map((request) => request.provider)).toEqual([
      ...PROVIDER_NAMES,
    ]);
  });
});

describe('FinishReason', () => {
  it('is a closed union ending in an `other` fallback', () => {
    expect([...FINISH_REASONS]).toEqual([
      'stop',
      'length',
      'content_filter',
      'tool_use',
      'other',
    ]);
  });

  it('carries no provider-specific reason', () => {
    // The provider wire values (`end_turn`, `max_tokens`, `done`, …) are mapped
    // by the adapters; none of them may appear in the client contract.
    expect(FINISH_REASONS).not.toContain('end_turn');
    expect(FINISH_REASONS).not.toContain('max_tokens');
  });
});

describe('ChatCompletionRequest', () => {
  it('carries the full conversation, not only the latest user message', () => {
    expect(conversation.messages).toHaveLength(4);
    expect(conversation.messages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
  });

  it('leaves generation parameters optional', () => {
    const minimal: ChatCompletionRequest = {
      provider: 'ollama',
      model: 'llama3.1',
      messages: [{ role: 'user', content: 'hi' }],
    };

    expect(minimal.temperature).toBeUndefined();
    expect(minimal.maxTokens).toBeUndefined();
    expect(minimal.topP).toBeUndefined();
    expect(minimal.stop).toBeUndefined();
  });
});

describe('ProviderAdapter', () => {
  it('returns only the normalized response shape', async () => {
    const adapter = new StubAdapter();

    const response = await adapter.complete(
      conversation,
      new ProviderSecret(RAW_KEY),
      CALL_OPTIONS,
    );

    expect(Object.keys(response).sort()).toEqual([
      'finishReason',
      'id',
      'message',
      'model',
      'provider',
      'usage',
    ]);
    expect(Object.keys(response.message).sort()).toEqual(['content', 'role']);
    expect(Object.keys(response.usage).sort()).toEqual([
      'completionTokens',
      'promptTokens',
      'totalTokens',
    ]);
  });

  it('resolves to nothing but the normalized response', () => {
    // Compile-time: `complete` may resolve to nothing but NormalizedResponse,
    // so no provider-specific shape can ride along.
    type AdapterResult = Awaited<ReturnType<ProviderAdapter['complete']>>;
    const asNormalized = (result: AdapterResult): NormalizedResponse => result;

    const response = asNormalized({
      id: 'resp_2',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5-20250929',
      message: { role: 'assistant', content: 'ok' },
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      finishReason: 'stop',
    });

    expect(response.provider).toBe('anthropic');
    expect(response.model).toBe('claude-sonnet-4-5-20250929');
    expect(response.message.role).toBe('assistant');
  });

  it('takes the credential wrapped and never returns it', async () => {
    const adapter = new StubAdapter();

    const response = await adapter.complete(
      conversation,
      new ProviderSecret(RAW_KEY),
      CALL_OPTIONS,
    );

    expect(adapter.revealedInsideAdapter).toBe(RAW_KEY);
    expect(JSON.stringify(response)).not.toContain(RAW_KEY);
  });
});

describe('ProviderError', () => {
  it('is an Error naming the provider and the failure kind', () => {
    const err = new ProviderError('Upstream returned 500', {
      provider: 'openai',
      kind: 'upstream_error',
      status: 500,
    });

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ProviderError');
    expect(err.message).toBe('Upstream returned 500');
    expect(err.provider).toBe('openai');
    expect(err.kind).toBe('upstream_error');
    expect(err.status).toBe(500);
  });

  it('leaves the status undefined when the failure carried none', () => {
    const err = new ProviderError('Request timed out', {
      provider: 'ollama',
      kind: 'timeout',
    });

    expect(err.kind).toBe('timeout');
    expect(err.status).toBeUndefined();
  });

  it('exposes no field that could carry the credential', () => {
    const err = new ProviderError('Malformed provider payload', {
      provider: 'anthropic',
      kind: 'invalid_response',
    });

    // The declared surface is the guard: there is no slot a secret could be
    // written into, so no call site can leak one through the error.
    expect(Object.keys(err).sort()).toEqual([
      'kind',
      'name',
      'provider',
      'status',
    ]);
    expect(
      JSON.stringify({ err, secret: new ProviderSecret(RAW_KEY) }),
    ).not.toContain(RAW_KEY);
  });

  it('keeps the upstream failure as a non-enumerable cause', () => {
    const upstream = new Error('socket hang up');
    const err = new ProviderError('Upstream call failed', {
      provider: 'openai',
      kind: 'upstream_error',
      cause: upstream,
    });

    expect(err.cause).toBe(upstream);
    // Non-enumerable, so a cause carrying upstream detail cannot ride out to the
    // client through serialization of the error.
    expect(Object.keys(err)).not.toContain('cause');
    expect(JSON.stringify(err)).not.toContain('socket hang up');
  });
});
