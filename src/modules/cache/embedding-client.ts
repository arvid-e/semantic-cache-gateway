/**
 * Local embeddings for the semantic layer, via the in-stack Ollama `/api/embed`.
 *
 * The defining constraint is Req 3.4 / 6.3: the cache path calls no external
 * keyed service. That is why this speaks to the foundation's `OLLAMA_URL`
 * directly and sends *no* `authorization` header — unlike `OllamaAdapter`,
 * which reveals a tenant credential because it may front Ollama Cloud. Nothing
 * on this path may cost a tenant their key or their money.
 *
 * Every failure surfaces as {@link EmbeddingUnavailableError}, which the
 * orchestrator reads as "go live" (Req 6.6). The layer never guesses a vector.
 */

const EMBED_PATH = '/api/embed';

/**
 * `semantic_cache_entries.prompt_embedding` is `vector(768)`, so a model that
 * emits anything else cannot be stored and must not be compared. Checking here
 * turns a misconfigured `CACHE_EMBEDDING_MODEL` into one clear error at the
 * boundary rather than a Postgres type failure several layers later.
 */
export const EMBEDDING_DIMENSIONS = 768;

/**
 * Local generation is fast; a hang is a broken embedder, not a slow one. The
 * budget is small on purpose — the orchestrator's fallback is a live provider
 * call, so waiting longer than this costs more than it can ever save.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

export interface EmbeddingClientConfig {
  /** Reused from the foundation's `OLLAMA_URL`; may carry a path prefix. */
  readonly baseUrl: string;
  /** `CACHE_EMBEDDING_MODEL`, which must emit {@link EMBEDDING_DIMENSIONS}. */
  readonly model: string;
  readonly timeoutMs?: number;
}

/** Narrowed from `RequestInit` to the fields used, so a stub can assert on them. */
export interface EmbeddingHttpRequest {
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: AbortSignal;
}

export type EmbeddingFetch = (
  url: string,
  init: EmbeddingHttpRequest,
) => Promise<Response>;

const defaultFetch: EmbeddingFetch = (url, init) => fetch(url, init);

/**
 * The single signal the orchestrator branches on. One type for every cause —
 * unreachable, timed out, non-2xx, unparseable, wrong shape, wrong width —
 * because the caller's response to all of them is identical: call the provider.
 * Distinguishing them would invite a branch that tries to salvage a request the
 * cache has already failed to serve.
 */
export class EmbeddingUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'EmbeddingUnavailableError';
  }
}

export interface EmbeddingClient {
  /**
   * Embed a batch in one round trip, returned in input order.
   *
   * @throws {EmbeddingUnavailableError} on any failure to produce the full
   * batch at the expected width.
   */
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Holds only the resolved endpoint, model, and transport, so one instance
 * serves every tenant — there is nothing tenant-specific on this path.
 */
export class OllamaEmbeddingClient implements EmbeddingClient {
  readonly #url: string;
  readonly #model: string;
  readonly #timeoutMs: number;
  readonly #doFetch: EmbeddingFetch;

  constructor(
    config: EmbeddingClientConfig,
    doFetch: EmbeddingFetch = defaultFetch,
  ) {
    this.#url = embedUrl(config.baseUrl);
    this.#model = config.model;
    this.#timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#doFetch = doFetch;
  }

  async embed(texts: string[]): Promise<number[][]> {
    // The orchestrator batches the latest user message with the last AI
    // response, and a first turn has no last AI response. No round trip for a
    // question whose answer is already known.
    if (texts.length === 0) return [];

    const payload = await this.#post(texts);
    return toEmbeddings(payload, texts.length);
  }

  /**
   * Call under a timeout and return the parsed body. The `AbortController` is
   * cleared only once the body has been read, so a slow body counts against the
   * same budget as a slow head.
   */
  async #post(texts: string[]): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);

    try {
      const response = await this.#doFetch(this.#url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // `/api/embed` (not the older `/api/embeddings`) is the batch endpoint:
        // `input` takes an array and `embeddings` comes back parallel to it.
        body: JSON.stringify({ model: this.#model, input: texts }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new EmbeddingUnavailableError(
          `Ollama embed request failed with status ${String(response.status)}`,
        );
      }

      try {
        return await response.json();
      } catch (cause) {
        throw new EmbeddingUnavailableError(
          'Ollama embed returned a body that is not JSON',
          { cause },
        );
      }
    } catch (error) {
      if (error instanceof EmbeddingUnavailableError) throw error;
      // The timer is the only thing that aborts this controller, so an aborted
      // signal means the call outlived its budget — read from the controller
      // rather than the rejection, whose `name` has varied across Node releases.
      if (controller.signal.aborted) {
        throw new EmbeddingUnavailableError('Ollama embed timed out', {
          cause: error,
        });
      }
      throw new EmbeddingUnavailableError('Ollama embed is unreachable', {
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Concatenation rather than `new URL(EMBED_PATH, baseUrl)`: the latter resolves
 * from the *root* and would silently drop a path prefix, so a base URL pointing
 * at a reverse proxy (`https://proxy/ollama`) would call the proxy's own root.
 */
function embedUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${EMBED_PATH}`;
}

/**
 * Ollama publishes no types and the body is whatever the configured URL
 * returned, so the reply is validated rather than trusted. A short batch is a
 * failure, not a partial success: the caller pairs the results positionally,
 * and a missing element would silently shift every vector onto the wrong text.
 */
function toEmbeddings(payload: unknown, expected: number): number[][] {
  if (typeof payload !== 'object' || payload === null) {
    throw new EmbeddingUnavailableError('Ollama embed returned no object');
  }

  const embeddings: unknown = (payload as { embeddings?: unknown }).embeddings;
  if (!Array.isArray(embeddings)) {
    throw new EmbeddingUnavailableError(
      'Ollama embed returned no embeddings array',
    );
  }

  const vectors = embeddings as unknown[];
  if (vectors.length !== expected) {
    throw new EmbeddingUnavailableError(
      `Ollama embed returned ${String(vectors.length)} embeddings for ${String(expected)} inputs`,
    );
  }

  return vectors.map((vector) => {
    if (!isFiniteVector(vector)) {
      throw new EmbeddingUnavailableError(
        'Ollama embed returned a vector that is not finite numbers',
      );
    }
    if (vector.length !== EMBEDDING_DIMENSIONS) {
      throw new EmbeddingUnavailableError(
        `Ollama embed returned ${String(vector.length)} dimensions; the schema stores ${String(EMBEDDING_DIMENSIONS)}`,
      );
    }
    return vector;
  });
}

/**
 * `Number.isFinite` and not just `typeof`: `JSON.parse` yields `null` where the
 * embedder wrote `NaN` or `Infinity`, and pgvector rejects both — better to
 * fall back to live than to fail on insert with the response already in hand.
 */
function isFiniteVector(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    (value as unknown[]).every(
      (n) => typeof n === 'number' && Number.isFinite(n),
    )
  );
}
