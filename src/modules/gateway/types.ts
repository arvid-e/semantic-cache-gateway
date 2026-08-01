import type { ProviderName, ProviderSecret } from '#src/modules/auth/types.js';

/**
 * The client contract and the provider seam. Provider-specific request or
 * response shapes never appear here — they stay inside the adapter that owns
 * them. `resilience-failover` wraps {@link ProviderAdapter.complete} and
 * `dual-layer-caching` reads the conversation carried by
 * {@link ChatCompletionRequest}, so treat these as a stable seam.
 */

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
}

/**
 * Carries the *full* conversation, not just the latest user turn: adapters need
 * the history to call their provider, and `dual-layer-caching` later reads it
 * for topic-shift detection and context-chain verification. The generation
 * params are the ones all three providers share; anything provider-specific is
 * deliberately absent.
 */
export interface ChatCompletionRequest {
  readonly provider: ProviderName;
  /** Model as requested by the client; the response reflects what resolved. */
  readonly model: string;
  readonly messages: ChatMessage[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly topP?: number;
  readonly stop?: string[];
}

/**
 * Each adapter maps its provider's wire value onto this list and falls back to
 * `'other'` for anything unrecognized, so an upstream adding a new reason can
 * never widen the client contract.
 */
export const FINISH_REASONS = [
  'stop',
  'length',
  'content_filter',
  'tool_use',
  'other',
] as const;

export type FinishReason = (typeof FINISH_REASONS)[number];

/**
 * Deliberately named apart from the foundation's `TokenUsage`
 * (`src/platform/context/types.ts`), which is the same idea with different field
 * names; `completion-service.ts` maps between the two rather than treating them
 * as interchangeable.
 */
export interface NormalizedUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

/**
 * The single response schema clients see, whichever provider served the request.
 * The raw upstream payload is consumed inside the adapter and never surfaces, so
 * integrations do not change per provider.
 */
export interface NormalizedResponse {
  /** Identifier for this completion; the adapter supplies a stable value. */
  readonly id: string;
  readonly provider: ProviderName;
  /** The model that actually served the request. */
  readonly model: string;
  readonly message: { readonly role: 'assistant'; readonly content: string };
  readonly usage: NormalizedUsage;
  readonly finishReason: FinishReason;
}

/**
 * Passed in rather than read from config inside an adapter, so the adapters stay
 * pure translators and `resilience-failover` can vary them per attempt.
 */
export interface ProviderCallOptions {
  /** Upper bound on a single provider call; expiry becomes a `timeout` error. */
  readonly timeoutMs: number;
  /** Used where a provider requires a max-tokens value the client omitted. */
  readonly defaultMaxTokens: number;
}

/**
 * One adapter per provider, each owning *both* directions: translating
 * {@link ChatCompletionRequest} into its provider's request shape and
 * normalizing the reply back. Returning nothing but a
 * {@link NormalizedResponse} is what keeps provider-specific shapes from leaking
 * past this boundary, and it returns one complete response — v1 is
 * non-streaming.
 *
 * `reveal()` on the {@link ProviderSecret} is called only at the provider's HTTP
 * boundary; the revealed value is never logged, returned, or attached to an
 * error.
 */
export interface ProviderAdapter {
  readonly name: ProviderName;
  complete(
    request: ChatCompletionRequest,
    credential: ProviderSecret,
    opts: ProviderCallOptions,
  ): Promise<NormalizedResponse>;
}

/**
 * `upstream_error` is a rejection the provider returned, `timeout` is
 * {@link ProviderCallOptions.timeoutMs} elapsing, and `invalid_response` is a
 * reply that could not be normalized.
 */
export type ProviderErrorKind =
  'upstream_error' | 'timeout' | 'invalid_response';

export interface ProviderErrorDetails {
  readonly provider: ProviderName;
  readonly kind: ProviderErrorKind;
  /** Upstream HTTP status, when the failure carried one. */
  readonly status?: number;
  /**
   * Adapters must pass a non-secret cause. A provider SDK's own error object can
   * carry the request headers — and therefore the tenant's key — and although
   * `cause` is non-enumerable (so it stays out of `JSON.stringify`), an error
   * serializer that walks the cause chain would surface it.
   */
  readonly cause?: unknown;
}

/**
 * The declared surface is deliberately narrow — provider, failure kind, and an
 * optional upstream status — so there is no field a credential could be written
 * into. The provider name and status are not secret.
 */
export class ProviderError extends Error {
  readonly provider: ProviderName;
  readonly kind: ProviderErrorKind;
  /** `undefined` for failures with no HTTP status, such as a timeout. */
  readonly status: number | undefined;

  constructor(message: string, details: ProviderErrorDetails) {
    super(
      message,
      details.cause === undefined ? undefined : { cause: details.cause },
    );
    this.name = 'ProviderError';
    this.provider = details.provider;
    this.kind = details.kind;
    this.status = details.status;
  }
}
