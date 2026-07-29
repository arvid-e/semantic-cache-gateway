import { ProviderSecret } from '#src/modules/auth/types.js';
import { ProviderError, type ChatCompletionRequest } from '../types.js';
import {
  createOllamaAdapter,
  type OllamaFetch,
  type OllamaHttpRequest,
} from './ollama-adapter.js';

/** A revealable secret whose plaintext we assert never escapes into an error. */
const SECRET = 'ollama-tenant-super-secret-key';

const BASE_OPTS = { timeoutMs: 15_000, defaultMaxTokens: 1024 } as const;

const CONFIG = { baseUrl: 'http://localhost:11434' } as const;

const REQUEST: ChatCompletionRequest = {
  provider: 'ollama',
  model: 'llama3.2',
  messages: [
    { role: 'system', content: 'You are terse.' },
    { role: 'user', content: 'Hi there.' },
  ],
  temperature: 0.5,
  maxTokens: 256,
  topP: 0.9,
  stop: ['\n\n'],
};

/** A representative successful `/api/chat` reply. */
function stubBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: 'llama3.2',
    created_at: '2026-07-29T10:00:00.000Z',
    message: { role: 'assistant', content: 'Hello.' },
    done: true,
    done_reason: 'stop',
    total_duration: 1_234_567,
    prompt_eval_count: 11,
    eval_count: 3,
    ...overrides,
  });
}

/** The parsed request body, so tests can assert on what was actually posted. */
function sentBody(seen: { init?: OllamaHttpRequest }): Record<string, unknown> {
  return JSON.parse(seen.init?.body ?? '{}') as Record<string, unknown>;
}

/**
 * A stub `fetch` that records what the adapter sent and returns (or throws) a
 * canned result. `hang` never settles until the adapter's timeout aborts it.
 */
function stubFetch(
  result:
    | { readonly ok: string; readonly status?: number }
    | { readonly err: unknown }
    | { readonly hang: true },
): {
  readonly doFetch: OllamaFetch;
  readonly seen: { url?: string; init?: OllamaHttpRequest; calls: number };
} {
  const seen = { calls: 0 } as {
    url?: string;
    init?: OllamaHttpRequest;
    calls: number;
  };

  return {
    seen,
    doFetch: (url, init) => {
      seen.calls += 1;
      seen.url = url;
      seen.init = init;
      if ('hang' in result) {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(init.signal.reason as Error);
          });
        });
      }
      if ('err' in result) {
        const reason =
          result.err instanceof Error
            ? result.err
            : new Error(String(result.err));
        return Promise.reject(reason);
      }
      return Promise.resolve(
        new Response(result.ok, { status: result.status ?? 200 }),
      );
    },
  };
}

describe('Ollama adapter', () => {
  it('exposes the ollama provider name', () => {
    const adapter = createOllamaAdapter(CONFIG);
    expect(adapter.name).toBe('ollama');
  });

  it('posts to /api/chat with the JSON content type and the revealed key', async () => {
    const { doFetch, seen } = stubFetch({ ok: stubBody() });
    const adapter = createOllamaAdapter(CONFIG, doFetch);

    await adapter.complete(REQUEST, new ProviderSecret(SECRET), BASE_OPTS);

    expect(seen.url).toBe('http://localhost:11434/api/chat');
    expect(seen.init?.method).toBe('POST');
    expect(seen.init?.headers).toEqual({
      'content-type': 'application/json',
      authorization: `Bearer ${SECRET}`,
    });
  });

  it('keeps a base URL that carries a path prefix or a trailing slash', async () => {
    const { doFetch, seen } = stubFetch({ ok: stubBody() });
    const adapter = createOllamaAdapter(
      { baseUrl: 'https://proxy.internal/ollama/' },
      doFetch,
    );

    await adapter.complete(REQUEST, new ProviderSecret(SECRET), BASE_OPTS);

    expect(seen.url).toBe('https://proxy.internal/ollama/api/chat');
  });

  it('translates the agnostic request into a non-streaming /api/chat request', async () => {
    const { doFetch, seen } = stubFetch({ ok: stubBody() });
    const adapter = createOllamaAdapter(CONFIG, doFetch);

    await adapter.complete(REQUEST, new ProviderSecret(SECRET), BASE_OPTS);

    expect(sentBody(seen)).toEqual({
      model: 'llama3.2',
      messages: [
        { role: 'system', content: 'You are terse.' },
        { role: 'user', content: 'Hi there.' },
      ],
      stream: false,
      options: {
        temperature: 0.5,
        top_p: 0.9,
        num_predict: 256,
        stop: ['\n\n'],
      },
    });
  });

  it('omits the options object when the client supplied no generation params', async () => {
    const { doFetch, seen } = stubFetch({ ok: stubBody() });
    const adapter = createOllamaAdapter(CONFIG, doFetch);

    await adapter.complete(
      {
        provider: 'ollama',
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'hi' }],
      },
      new ProviderSecret(SECRET),
      BASE_OPTS,
    );

    expect(sentBody(seen)).toEqual({
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    });
  });

  it('normalizes a successful reply to the unified schema with the resolved model', async () => {
    const { doFetch } = stubFetch({ ok: stubBody() });
    const adapter = createOllamaAdapter(CONFIG, doFetch);

    const result = await adapter.complete(
      REQUEST,
      new ProviderSecret(SECRET),
      BASE_OPTS,
    );

    expect(result).toMatchObject({
      provider: 'ollama',
      model: 'llama3.2',
      message: { role: 'assistant', content: 'Hello.' },
      usage: { promptTokens: 11, completionTokens: 3, totalTokens: 14 },
      finishReason: 'stop',
    });
  });

  it('supplies an id per completion, since Ollama returns none', async () => {
    const { doFetch } = stubFetch({ ok: stubBody() });
    const adapter = createOllamaAdapter(CONFIG, doFetch);

    const first = await adapter.complete(
      REQUEST,
      new ProviderSecret(SECRET),
      BASE_OPTS,
    );
    const second = await adapter.complete(
      REQUEST,
      new ProviderSecret(SECRET),
      BASE_OPTS,
    );

    expect(first.id).not.toBe('');
    expect(first.id).not.toBe(second.id);
  });

  it('carries no provider-specific fields into the normalized response', async () => {
    const { doFetch } = stubFetch({ ok: stubBody() });
    const adapter = createOllamaAdapter(CONFIG, doFetch);

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

  it('maps the Ollama done reason onto the closed union', async () => {
    const { doFetch } = stubFetch({ ok: stubBody({ done_reason: 'length' }) });
    const adapter = createOllamaAdapter(CONFIG, doFetch);

    const result = await adapter.complete(
      REQUEST,
      new ProviderSecret(SECRET),
      BASE_OPTS,
    );

    expect(result.finishReason).toBe('length');
  });

  it('falls back to other for an absent done reason', async () => {
    const { doFetch } = stubFetch({ ok: stubBody({ done_reason: undefined }) });
    const adapter = createOllamaAdapter(CONFIG, doFetch);

    const result = await adapter.complete(
      REQUEST,
      new ProviderSecret(SECRET),
      BASE_OPTS,
    );

    expect(result.finishReason).toBe('other');
  });

  it('computes the token total as prompt-eval plus eval, since Ollama reports none', async () => {
    const { doFetch } = stubFetch({
      ok: stubBody({ prompt_eval_count: 120, eval_count: 37 }),
    });
    const adapter = createOllamaAdapter(CONFIG, doFetch);

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

  it('treats absent token counts as zero', async () => {
    const { doFetch } = stubFetch({
      ok: stubBody({ prompt_eval_count: undefined, eval_count: undefined }),
    });
    const adapter = createOllamaAdapter(CONFIG, doFetch);

    const result = await adapter.complete(
      REQUEST,
      new ProviderSecret(SECRET),
      BASE_OPTS,
    );

    expect(result.usage).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
  });

  it('maps a non-2xx reply to an upstream_error ProviderError with the status', async () => {
    const { doFetch } = stubFetch({
      ok: JSON.stringify({ error: 'model "nope" not found' }),
      status: 404,
    });
    const adapter = createOllamaAdapter(CONFIG, doFetch);

    const error = await adapter
      .complete(REQUEST, new ProviderSecret(SECRET), BASE_OPTS)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({
      provider: 'ollama',
      kind: 'upstream_error',
      status: 404,
    });
  });

  it('maps a transport failure to an upstream_error ProviderError with no status', async () => {
    const { doFetch } = stubFetch({ err: new TypeError('fetch failed') });
    const adapter = createOllamaAdapter(CONFIG, doFetch);

    const error = (await adapter
      .complete(REQUEST, new ProviderSecret(SECRET), BASE_OPTS)
      .catch((caught: unknown) => caught)) as ProviderError;

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.kind).toBe('upstream_error');
    expect(error.status).toBeUndefined();
  });

  it('aborts a call that outlives the timeout and reports it as a timeout', async () => {
    const { doFetch, seen } = stubFetch({ hang: true });
    const adapter = createOllamaAdapter(CONFIG, doFetch);

    const error = (await adapter
      .complete(REQUEST, new ProviderSecret(SECRET), {
        ...BASE_OPTS,
        timeoutMs: 10,
      })
      .catch((caught: unknown) => caught)) as ProviderError;

    expect(error).toBeInstanceOf(ProviderError);
    expect(error.kind).toBe('timeout');
    expect(error.status).toBeUndefined();
    expect(seen.init?.signal.aborted).toBe(true);
  });

  it('surfaces a body that is not JSON as an invalid_response error', async () => {
    const { doFetch } = stubFetch({ ok: '<html>proxy error</html>' });
    const adapter = createOllamaAdapter(CONFIG, doFetch);

    await expect(
      adapter.complete(REQUEST, new ProviderSecret(SECRET), BASE_OPTS),
    ).rejects.toMatchObject({
      name: 'ProviderError',
      provider: 'ollama',
      kind: 'invalid_response',
    });
  });

  it('surfaces a reply with no assistant message as an invalid_response error', async () => {
    const { doFetch } = stubFetch({ ok: stubBody({ message: undefined }) });
    const adapter = createOllamaAdapter(CONFIG, doFetch);

    await expect(
      adapter.complete(REQUEST, new ProviderSecret(SECRET), BASE_OPTS),
    ).rejects.toMatchObject({
      name: 'ProviderError',
      provider: 'ollama',
      kind: 'invalid_response',
    });
  });

  it('never lets the credential escape into the thrown error', async () => {
    // Ollama echoes no key, but a fronting proxy can put one in its 401 body;
    // the adapter must not carry the tenant secret anywhere on the error.
    const { doFetch } = stubFetch({
      ok: JSON.stringify({ error: `invalid token ${SECRET}` }),
      status: 401,
    });
    const adapter = createOllamaAdapter(CONFIG, doFetch);

    const error = (await adapter
      .complete(REQUEST, new ProviderSecret(SECRET), BASE_OPTS)
      .catch((caught: unknown) => caught)) as ProviderError;

    const serialized = JSON.stringify({
      message: error.message,
      cause: (error.cause as Error | undefined)?.message,
      stack: error.stack,
    });
    expect(serialized).not.toContain(SECRET);
  });
});
