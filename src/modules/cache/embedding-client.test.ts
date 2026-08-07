import {
  EMBEDDING_DIMENSIONS,
  EmbeddingUnavailableError,
  OllamaEmbeddingClient,
  type EmbeddingFetch,
  type EmbeddingHttpRequest,
} from './embedding-client.js';

const CONFIG = {
  baseUrl: 'http://localhost:11434',
  model: 'nomic-embed-text',
} as const;

function vector(fill = 0.5): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, () => fill);
}

/** The parsed request body, so tests can assert on what was actually posted. */
function sentBody(seen: {
  init?: EmbeddingHttpRequest;
}): Record<string, unknown> {
  return JSON.parse(seen.init?.body ?? '{}') as Record<string, unknown>;
}

/**
 * A stub `fetch` recording what the client sent. `hang` never settles until the
 * client's own timeout aborts it.
 */
function stubFetch(
  result:
    | { readonly ok: string; readonly status?: number }
    | { readonly err: Error }
    | { readonly hang: true },
): {
  readonly doFetch: EmbeddingFetch;
  readonly seen: { url?: string; init?: EmbeddingHttpRequest; calls: number };
} {
  const seen: { url?: string; init?: EmbeddingHttpRequest; calls: number } = {
    calls: 0,
  };

  const doFetch: EmbeddingFetch = (url, init) => {
    seen.url = url;
    seen.init = init;
    seen.calls += 1;

    if ('err' in result) return Promise.reject(result.err);
    if ('hang' in result) {
      return new Promise<Response>((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });
    }
    return Promise.resolve(
      new Response(result.ok, { status: result.status ?? 200 }),
    );
  };

  return { doFetch, seen };
}

function bodyOf(embeddings: unknown): string {
  return JSON.stringify({ model: 'nomic-embed-text', embeddings });
}

describe('OllamaEmbeddingClient — the request it sends', () => {
  it('posts the batch to /api/embed under the configured model', async () => {
    const { doFetch, seen } = stubFetch({
      ok: bodyOf([vector(), vector(0.25)]),
    });

    await new OllamaEmbeddingClient(CONFIG, doFetch).embed(['first', 'second']);

    expect(seen.url).toBe('http://localhost:11434/api/embed');
    expect(seen.init?.method).toBe('POST');
    expect(sentBody(seen)).toEqual({
      model: 'nomic-embed-text',
      input: ['first', 'second'],
    });
  });

  it('sends no authorization header', async () => {
    // Req 3.4/6.3: the cache path calls no keyed service. A credential on this
    // request would mean the in-stack embedder could be swapped for a billed
    // one without anything failing.
    const { doFetch, seen } = stubFetch({ ok: bodyOf([vector()]) });

    await new OllamaEmbeddingClient(CONFIG, doFetch).embed(['only']);

    const headers = Object.keys(seen.init?.headers ?? {}).map((h) =>
      h.toLowerCase(),
    );
    expect(headers).not.toContain('authorization');
  });

  it('preserves a path prefix on the base URL', async () => {
    // `new URL(path, base)` would resolve from the root and call the proxy's
    // own /api/embed rather than the one it fronts.
    const { doFetch, seen } = stubFetch({ ok: bodyOf([vector()]) });

    await new OllamaEmbeddingClient(
      { ...CONFIG, baseUrl: 'https://proxy.internal/ollama/' },
      doFetch,
    ).embed(['only']);

    expect(seen.url).toBe('https://proxy.internal/ollama/api/embed');
  });

  it('makes no request at all for an empty batch', async () => {
    // A first turn has no last AI response to embed.
    const { doFetch, seen } = stubFetch({ ok: bodyOf([]) });

    await expect(
      new OllamaEmbeddingClient(CONFIG, doFetch).embed([]),
    ).resolves.toEqual([]);
    expect(seen.calls).toBe(0);
  });
});

describe('OllamaEmbeddingClient — successful embedding', () => {
  it('returns one 768-dim vector per input, in input order', async () => {
    const first = vector(0.1);
    const second = vector(0.2);
    const { doFetch } = stubFetch({ ok: bodyOf([first, second]) });

    const embeddings = await new OllamaEmbeddingClient(CONFIG, doFetch).embed([
      'user message',
      'last ai response',
    ]);

    expect(embeddings).toHaveLength(2);
    expect(embeddings[0]).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(embeddings[0]?.[0]).toBe(0.1);
    expect(embeddings[1]?.[0]).toBe(0.2);
  });
});

describe('OllamaEmbeddingClient — every failure is the same signal', () => {
  const cases: { name: string; result: Parameters<typeof stubFetch>[0] }[] = [
    { name: 'a non-2xx status', result: { ok: '{}', status: 503 } },
    { name: 'a transport failure', result: { err: new Error('ECONNREFUSED') } },
    { name: 'a body that is not JSON', result: { ok: 'not json at all' } },
  ];

  for (const { name, result } of cases) {
    it(`raises embedding-unavailable on ${name}`, async () => {
      const { doFetch } = stubFetch(result);

      await expect(
        new OllamaEmbeddingClient(CONFIG, doFetch).embed(['x']),
      ).rejects.toBeInstanceOf(EmbeddingUnavailableError);
    });
  }

  it('raises embedding-unavailable when the call outlives its budget', async () => {
    const { doFetch } = stubFetch({ hang: true });

    await expect(
      new OllamaEmbeddingClient({ ...CONFIG, timeoutMs: 5 }, doFetch).embed([
        'x',
      ]),
    ).rejects.toBeInstanceOf(EmbeddingUnavailableError);
  });

  it('rejects a short batch rather than returning a partial one', async () => {
    // Results are paired with inputs positionally, so a missing element would
    // silently attach every later vector to the wrong text.
    const { doFetch } = stubFetch({ ok: bodyOf([vector()]) });

    await expect(
      new OllamaEmbeddingClient(CONFIG, doFetch).embed(['first', 'second']),
    ).rejects.toBeInstanceOf(EmbeddingUnavailableError);
  });

  it('rejects a vector of the wrong width', async () => {
    // The schema stores vector(768); a model emitting anything else cannot be
    // stored and must not be compared.
    const { doFetch } = stubFetch({ ok: bodyOf([[0.1, 0.2, 0.3]]) });

    await expect(
      new OllamaEmbeddingClient(CONFIG, doFetch).embed(['x']),
    ).rejects.toBeInstanceOf(EmbeddingUnavailableError);
  });

  it('rejects a vector carrying a non-finite or non-numeric element', async () => {
    // `JSON.stringify(NaN)` is `null`, which would otherwise reach pgvector.
    const withNull = vector();
    withNull[10] = null as unknown as number;
    const { doFetch } = stubFetch({ ok: bodyOf([withNull]) });

    await expect(
      new OllamaEmbeddingClient(CONFIG, doFetch).embed(['x']),
    ).rejects.toBeInstanceOf(EmbeddingUnavailableError);
  });

  it('rejects a reply with no embeddings array', async () => {
    const { doFetch } = stubFetch({ ok: JSON.stringify({ model: 'x' }) });

    await expect(
      new OllamaEmbeddingClient(CONFIG, doFetch).embed(['x']),
    ).rejects.toBeInstanceOf(EmbeddingUnavailableError);
  });
});
