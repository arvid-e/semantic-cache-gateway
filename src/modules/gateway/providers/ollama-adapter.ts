import { randomUUID } from 'node:crypto';
import type { ProviderSecret } from '#src/modules/auth/types.js';
import {
  ProviderError,
  type ChatCompletionRequest,
  type NormalizedResponse,
  type ProviderAdapter,
  type ProviderCallOptions,
} from '../types.js';
import { mapOllamaDoneReason, mapOllamaUsage } from './mapping.js';

/**
 * Ollama adapter for the shared {@link ProviderAdapter} seam.
 *
 * Translates the provider-agnostic {@link ChatCompletionRequest} into an Ollama
 * `/api/chat` call and normalizes the reply back into the unified
 * {@link NormalizedResponse}. All Ollama-specific request and response shapes are
 * confined to this file — nothing provider-specific crosses the adapter boundary
 * (Req 3.4, 4.1, 4.2).
 *
 * Unlike the other two providers Ollama ships no SDK, so this adapter speaks
 * HTTP directly through Node's `fetch`. That means three things the SDKs
 * otherwise handle are owned here: the per-call timeout (an `AbortController`
 * the adapter arms and disarms), the retry policy (there is none — retries
 * belong to resilience-failover, Req 3.5), and validating that the body coming
 * back is actually an Ollama reply.
 *
 * The tenant's BYOK key is revealed only here, at the HTTP boundary (Req 3.2).
 * It is never logged, returned, or attached to a {@link ProviderError}
 * (Req 4.3) — and because an Ollama error body is arbitrary text from whatever
 * is fronting the server, that body is deliberately never read into an error.
 */

/** Ollama's chat endpoint, appended to the configured base URL. */
const CHAT_PATH = '/api/chat';

/** Deployment-side config the adapter captures (the per-call opts carry the rest). */
export interface OllamaAdapterConfig {
  /** Reused from the foundation's `OLLAMA_URL`; may carry a path prefix. */
  readonly baseUrl: string;
}

/**
 * The one HTTP request the adapter makes. Narrowed from `RequestInit` to exactly
 * the fields used, so a test stub can assert on what was sent without modelling
 * the whole `fetch` surface.
 */
export interface OllamaHttpRequest {
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: AbortSignal;
}

/** The HTTP call; injectable so tests can stub the upstream without a server. */
export type OllamaFetch = (
  url: string,
  init: OllamaHttpRequest,
) => Promise<Response>;

/** Real transport: Node's global `fetch`. */
const defaultFetch: OllamaFetch = (url, init) => fetch(url, init);

/** Ollama's generation params; all live under `options`, not on the body. */
interface OllamaOptions {
  temperature?: number;
  top_p?: number;
  /** Ollama's name for a max-tokens cap. */
  num_predict?: number;
  stop?: string[];
}

/** The `/api/chat` request body. */
interface OllamaChatRequest {
  readonly model: string;
  readonly messages: readonly { readonly role: string; readonly content: string }[];
  readonly stream: false;
  options?: OllamaOptions;
}

/**
 * The slice of the `/api/chat` reply this adapter reads, as it looks *after*
 * {@link isOllamaChatResponse} has vouched for it. Ollama publishes no types and
 * the body is whatever the configured URL returned, so every field the adapter
 * can work around stays `unknown` and is coerced at the point of use; only the
 * assistant message, which nothing can substitute for, is required outright.
 */
interface OllamaChatResponse {
  readonly model?: unknown;
  readonly message: { readonly content: string };
  readonly done_reason?: unknown;
  readonly prompt_eval_count?: unknown;
  readonly eval_count?: unknown;
}

/**
 * Build the Ollama chat adapter.
 *
 * @param config - Provider base URL (from the gateway config).
 * @param doFetch - HTTP transport; defaults to Node's global `fetch`.
 */
export function createOllamaAdapter(
  config: OllamaAdapterConfig,
  doFetch: OllamaFetch = defaultFetch,
): ProviderAdapter {
  const url = chatUrl(config.baseUrl);

  return {
    name: 'ollama',
    async complete(
      request: ChatCompletionRequest,
      credential: ProviderSecret,
      opts: ProviderCallOptions,
    ): Promise<NormalizedResponse> {
      const payload = await post(doFetch, url, request, credential, opts);
      return normalize(payload, request);
    },
  };
}

/**
 * Join the base URL and the chat path. Deliberately string concatenation rather
 * than `new URL(CHAT_PATH, baseUrl)`: the latter resolves from the *root* and
 * would silently drop a path prefix, so a base URL pointing at a reverse proxy
 * (`https://proxy/ollama`) would end up calling the proxy's own root.
 */
function chatUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${CHAT_PATH}`;
}

/**
 * Perform the call under a per-call timeout and return the parsed body.
 *
 * The timeout is an `AbortController` armed for {@link ProviderCallOptions
 * .timeoutMs} and cleared once the body has been read, so a slow response body
 * counts against the same budget as a slow response head.
 *
 * Nothing from the response body reaches the thrown error: an Ollama deployment
 * can sit behind a proxy whose error body echoes the credential (Req 4.3).
 */
async function post(
  doFetch: OllamaFetch,
  url: string,
  request: ChatCompletionRequest,
  credential: ProviderSecret,
  opts: ProviderCallOptions,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, opts.timeoutMs);

  try {
    const response = await doFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // The one place the tenant secret is revealed: the HTTP boundary. A
        // local Ollama ignores it; Ollama Cloud and fronting proxies require it.
        authorization: `Bearer ${credential.reveal()}`,
      },
      body: JSON.stringify(toOllamaRequest(request)),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new ProviderError('Ollama request failed', {
        provider: 'ollama',
        kind: 'upstream_error',
        status: response.status,
      });
    }

    try {
      return await response.json();
    } catch {
      throw new ProviderError('Ollama returned a body that is not JSON', {
        provider: 'ollama',
        kind: 'invalid_response',
      });
    }
  } catch (error) {
    // Already normalized above; only a transport-level failure needs mapping.
    if (error instanceof ProviderError) throw error;
    // The timer is the only thing that aborts this controller, so an aborted
    // signal means the call outlived its budget — read from the controller
    // rather than from the rejection, whose `name` has varied across Node
    // releases (`AbortError` vs `TimeoutError`).
    if (controller.signal.aborted) {
      throw new ProviderError('Ollama request timed out', {
        provider: 'ollama',
        kind: 'timeout',
        cause: redactedCause(error),
      });
    }
    throw new ProviderError('Ollama request failed', {
      provider: 'ollama',
      kind: 'upstream_error',
      cause: redactedCause(error),
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Translate the agnostic request into Ollama's `/api/chat` body. `stream: false`
 * pins the single-response contract (Req 3.5) — Ollama streams by default, so
 * this is the flag that makes it return one complete message rather than a
 * stream of chunks.
 *
 * The roles map one-to-one, `system` included: Ollama takes system turns inline
 * in `messages`, so nothing is lifted the way the Anthropic adapter must. The
 * generation params differ more: they live under `options` rather than on the
 * body, and a max-tokens cap is called `num_predict`. `options` is omitted
 * entirely when the client set none, leaving Ollama's model defaults intact.
 */
function toOllamaRequest(request: ChatCompletionRequest): OllamaChatRequest {
  const options: OllamaOptions = {};
  if (request.temperature !== undefined) options.temperature = request.temperature;
  if (request.topP !== undefined) options.top_p = request.topP;
  if (request.maxTokens !== undefined) options.num_predict = request.maxTokens;
  if (request.stop !== undefined) options.stop = request.stop;

  const body: OllamaChatRequest = {
    model: request.model,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    stream: false,
  };
  if (Object.keys(options).length > 0) body.options = options;
  return body;
}

/** Whether a parsed body carries the assistant message this adapter needs. */
function isOllamaChatResponse(payload: unknown): payload is OllamaChatResponse {
  if (typeof payload !== 'object' || payload === null) return false;
  const message: unknown = (payload as { message?: unknown }).message;
  return (
    typeof message === 'object' &&
    message !== null &&
    typeof (message as { content?: unknown }).content === 'string'
  );
}

/**
 * Normalize an Ollama reply into the unified response.
 *
 * Two fields have no direct source. Ollama returns no completion id, so the
 * adapter mints one — {@link NormalizedResponse.id} is the adapter's to supply,
 * and clients get an identifier for this completion whichever provider served
 * it. The resolved model is echoed verbatim by Ollama (Req 2.4), so the
 * requested model is an exact-value fallback for a proxy that omits it, not a
 * guess.
 */
function normalize(
  payload: unknown,
  request: ChatCompletionRequest,
): NormalizedResponse {
  if (!isOllamaChatResponse(payload)) {
    throw new ProviderError('Ollama returned no assistant message', {
      provider: 'ollama',
      kind: 'invalid_response',
    });
  }

  return {
    id: `ollama-${randomUUID()}`,
    provider: 'ollama',
    model: typeof payload.model === 'string' ? payload.model : request.model,
    message: { role: 'assistant', content: payload.message.content },
    usage: mapOllamaUsage({
      prompt_eval_count: asCount(payload.prompt_eval_count),
      eval_count: asCount(payload.eval_count),
    }),
    finishReason: mapOllamaDoneReason(asReason(payload.done_reason)),
  };
}

/** Keep a token count only when it really is one; anything else becomes `0`. */
function asCount(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

/** Keep a done reason only when it really is a string; anything else → `other`. */
function asReason(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * A diagnostic-only cause that keeps just the transport error's message. Node's
 * fetch failures describe the connection, not the request, so the message is
 * safe to retain; the error object is dropped anyway for the same reason the
 * other adapters drop theirs (Req 4.3).
 */
function redactedCause(error: unknown): Error {
  return new Error(error instanceof Error ? error.message : String(error));
}
