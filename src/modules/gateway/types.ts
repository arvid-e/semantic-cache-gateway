import type { ProviderName, ProviderSecret } from '#src/modules/auth/types.js';

/**
 * Shared type contracts for the `gateway-provider-routing` module.
 *
 * This file is the client contract and the provider seam in one place: the
 * provider-agnostic request the endpoint accepts, the normalized response every
 * provider is flattened into, and the {@link ProviderAdapter} interface each
 * provider hides behind. Provider-specific request or response shapes never
 * appear here — they stay inside the adapter that owns them (Req 3.1, 4.2).
 *
 * Downstream specs consume these: `resilience-failover` wraps
 * {@link ProviderAdapter.complete}, and `dual-layer-caching` reads the
 * conversation carried by {@link ChatCompletionRequest}. Changing any of them is
 * a documented revalidation trigger for those specs, so treat this as a stable
 * seam.
 *
 * The supported provider set is not redefined here: {@link ProviderName} comes
 * from `auth-tenancy-credentials`, which owns the three-provider list and scopes
 * credentials by it (Req 2.3).
 */

/** Who authored a turn in the conversation. */
export type ChatRole = 'system' | 'user' | 'assistant';

/** One turn of the conversation in the provider-agnostic shape. */
export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
}

/**
 * The provider-agnostic completion request, as accepted by
 * `POST /v1/chat/completions` after validation.
 *
 * It carries the *full* conversation, not just the latest user turn (Req 1.4):
 * adapters need the history to call their provider, and `dual-layer-caching`
 * later reads it for topic-shift detection and context-chain verification. The
 * generation parameters are the ones all three providers share; anything
 * provider-specific is deliberately absent.
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
 * Why a provider stopped generating, as one closed union. Each adapter maps its
 * provider's wire value onto this list and falls back to `'other'` for anything
 * unrecognized, so an upstream adding a new reason can never widen the client
 * contract (Req 4.1, 4.4). Ordered so the fallback reads last.
 */
export const FINISH_REASONS = [
  'stop',
  'length',
  'content_filter',
  'tool_use',
  'other',
] as const;

/** Normalized stop reason. Union derived from {@link FINISH_REASONS}. */
export type FinishReason = (typeof FINISH_REASONS)[number];

/**
 * Normalized token counts. Providers that report no total get one computed.
 *
 * Deliberately named apart from the foundation's `TokenUsage`
 * (`src/platform/context/types.ts`), which is the same idea with different field
 * names (`prompt`/`completion`/`total`); the orchestration task maps between the
 * two rather than treating them as interchangeable.
 */
export interface NormalizedUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

/**
 * The single response schema clients see, whichever provider served the request
 * (Req 4.1, 4.4). Every field is provider-neutral: the raw upstream payload is
 * consumed inside the adapter and never surfaces, so integrations do not change
 * per provider (Req 4.2).
 */
export interface NormalizedResponse {
  /** Identifier for this completion; the adapter supplies a stable value. */
  readonly id: string;
  readonly provider: ProviderName;
  /** The model that actually served the request (Req 2.4). */
  readonly model: string;
  readonly message: { readonly role: 'assistant'; readonly content: string };
  readonly usage: NormalizedUsage;
  readonly finishReason: FinishReason;
}

/**
 * Per-call knobs the gateway config supplies to every adapter. Passed in rather
 * than read from config inside an adapter so the adapters stay pure translators
 * and `resilience-failover` can vary them per attempt.
 */
export interface ProviderCallOptions {
  /** Upper bound on a single provider call; expiry becomes a `timeout` error. */
  readonly timeoutMs: number;
  /** Used where a provider requires a max-tokens value the client omitted. */
  readonly defaultMaxTokens: number;
}

/**
 * The shared seam every provider call goes through (Req 3.1). One adapter per
 * provider; each owns *both* directions — translating
 * {@link ChatCompletionRequest} into its provider's request shape and
 * normalizing the reply back into {@link NormalizedResponse}.
 *
 * `complete` resolves to nothing but a {@link NormalizedResponse}, which is what
 * keeps provider-specific shapes from leaking past this boundary (Req 4.2), and
 * it returns one complete response — v1 is non-streaming (Req 3.5). The tenant's
 * key arrives wrapped in {@link ProviderSecret}; `reveal()` is called only at
 * the provider's HTTP boundary and the revealed value is never logged, returned,
 * or attached to an error (Req 3.2).
 *
 * `resilience-failover` wraps calls to this method — keep the signature stable.
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
 * How a provider call failed. `upstream_error` is a rejection the provider
 * returned, `timeout` is {@link ProviderCallOptions.timeoutMs} elapsing, and
 * `invalid_response` is a reply that could not be normalized.
 */
export type ProviderErrorKind =
  'upstream_error' | 'timeout' | 'invalid_response';

/** Non-secret detail describing a failed provider call. */
export interface ProviderErrorDetails {
  readonly provider: ProviderName;
  readonly kind: ProviderErrorKind;
  /** Upstream HTTP status, when the failure carried one. */
  readonly status?: number;
  /**
   * Underlying failure, kept for diagnostics via the standard `cause` chain.
   *
   * Adapters must pass a non-secret cause. A provider SDK's own error object can
   * carry the request headers — and therefore the tenant's key — and although
   * `cause` is non-enumerable (so it stays out of `JSON.stringify`), an error
   * serializer that walks the cause chain would surface it (Req 4.3).
   */
  readonly cause?: unknown;
}

/**
 * A failed provider call, normalized for the route to map onto a client error.
 *
 * Its declared surface is deliberately narrow — provider, failure kind, and an
 * optional upstream status — so there is no field a credential could be written
 * into and none can reach the client (Req 4.3). The provider name and status are
 * not secret. Anything provider-specific stays behind {@link ProviderAdapter}.
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
