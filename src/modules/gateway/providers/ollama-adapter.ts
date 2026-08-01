import { randomUUID } from 'node:crypto';
import type { ProviderName, ProviderSecret } from '#src/modules/auth/types.js';
import {
  ProviderError,
  type ChatCompletionRequest,
  type NormalizedResponse,
  type ProviderAdapter,
  type ProviderCallOptions,
} from '../types.js';
import { mapOllamaDoneReason, mapOllamaUsage } from './mapping.js';

/**
 * Ollama ships no SDK, so this adapter speaks HTTP directly. Three things the
 * other two get from their SDKs are owned here: the per-call timeout, the retry
 * policy (there is none — retries belong to resilience-failover), and validating
 * that the body coming back is actually an Ollama reply.
 */

const CHAT_PATH = '/api/chat';

export interface OllamaAdapterConfig {
  /** Reused from the foundation's `OLLAMA_URL`; may carry a path prefix. */
  readonly baseUrl: string;
}

/** Narrowed from `RequestInit` to the fields used, so a stub can assert on them. */
export interface OllamaHttpRequest {
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: AbortSignal;
}

export type OllamaFetch = (
  url: string,
  init: OllamaHttpRequest,
) => Promise<Response>;

const defaultFetch: OllamaFetch = (url, init) => fetch(url, init);

/** Ollama's generation params; all live under `options`, not on the body. */
interface OllamaOptions {
  temperature?: number;
  top_p?: number;
  /** Ollama's name for a max-tokens cap. */
  num_predict?: number;
  stop?: string[];
}

interface OllamaChatRequest {
  readonly model: string;
  readonly messages: readonly {
    readonly role: string;
    readonly content: string;
  }[];
  readonly stream: false;
  options?: OllamaOptions;
}

/**
 * The reply as it looks *after* {@link isOllamaChatResponse} has vouched for it.
 * Ollama publishes no types and the body is whatever the configured URL
 * returned, so every field the adapter can work around stays `unknown` and is
 * coerced at the point of use; only the assistant message is required outright.
 */
interface OllamaChatResponse {
  readonly model?: unknown;
  readonly message: { readonly content: string };
  readonly done_reason?: unknown;
  readonly prompt_eval_count?: unknown;
  readonly eval_count?: unknown;
}

/**
 * Holds only the resolved endpoint and the transport — the tenant credential and
 * per-call options arrive per call, so one instance serves every tenant.
 */
export class OllamaAdapter implements ProviderAdapter {
  readonly name: ProviderName = 'ollama';

  readonly #url: string;
  readonly #doFetch: OllamaFetch;

  constructor(
    config: OllamaAdapterConfig,
    doFetch: OllamaFetch = defaultFetch,
  ) {
    this.#url = chatUrl(config.baseUrl);
    this.#doFetch = doFetch;
  }

  async complete(
    request: ChatCompletionRequest,
    credential: ProviderSecret,
    opts: ProviderCallOptions,
  ): Promise<NormalizedResponse> {
    const payload = await post(
      this.#doFetch,
      this.#url,
      request,
      credential,
      opts,
    );
    return normalize(payload, request);
  }
}

/**
 * Concatenation rather than `new URL(CHAT_PATH, baseUrl)`: the latter resolves
 * from the *root* and would silently drop a path prefix, so a base URL pointing
 * at a reverse proxy (`https://proxy/ollama`) would call the proxy's own root.
 */
function chatUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${CHAT_PATH}`;
}

/**
 * Call under a per-call timeout and return the parsed body. The `AbortController`
 * is cleared only once the body has been read, so a slow response body counts
 * against the same budget as a slow response head.
 *
 * Nothing from the response body reaches the thrown error: an Ollama deployment
 * can sit behind a proxy whose error body echoes the credential.
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
 * Ollama streams by default, so `stream: false` is what makes it return one
 * complete message. Roles map one-to-one, `system` included. `options` is
 * omitted entirely when the client set no params, leaving Ollama's model
 * defaults intact.
 */
function toOllamaRequest(request: ChatCompletionRequest): OllamaChatRequest {
  const options: OllamaOptions = {};
  if (request.temperature !== undefined)
    options.temperature = request.temperature;
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
 * Two fields have no direct source. Ollama returns no completion id, so the
 * adapter mints one — clients get an identifier for this completion whichever
 * provider served it. The model is echoed verbatim by Ollama, so the requested
 * model is an exact-value fallback for a proxy that omits it, not a guess.
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
 * Drops the error object for the same reason the other adapters do, keeping only
 * the message. Node's fetch failures describe the connection, not the request.
 */
function redactedCause(error: unknown): Error {
  return new Error(error instanceof Error ? error.message : String(error));
}
