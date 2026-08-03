import type {
  CredentialResolver,
  ResolveCredentialInput,
} from '#src/modules/auth/services/credential-resolver.js';
import {
  MissingCredentialError,
  type ProviderName,
  type ProviderSecret,
} from '#src/modules/auth/types.js';
import type {
  RequestContext,
  TokenUsage,
} from '#src/platform/context/types.js';
import type { GatewayConfig } from './config.js';
import { populateCompletionContext } from './context.js';
import type { ProviderRegistry } from './providers/provider-registry.js';
import type {
  ChatCompletionRequest,
  NormalizedResponse,
  NormalizedUsage,
  ProviderCallOptions,
} from './types.js';

/**
 * Turns a validated, provider-agnostic request into a
 * {@link NormalizedResponse}. It owns the *order* of the steps and nothing else:
 * selection lives in the registry, translation and normalization in the
 * adapters, credential resolution in `auth-tenancy-credentials`, and the context
 * fields are written by `context.ts`.
 *
 * No caching, topic-shift, or context-verification logic here, and no retry or
 * failover — `dual-layer-caching` wraps this object and `resilience-failover`
 * wraps the adapter call, both against the {@link CompletionService} contract,
 * so keep the signature stable.
 */

/**
 * The stored credential exists but could not be made usable — a wrong keyring
 * version, a tampered ciphertext. Distinct from {@link MissingCredentialError},
 * which is the tenant's to fix and is a client error; this is a gateway-side
 * fault the route maps to a safe 5xx. Only the provider name is carried.
 */
export class CredentialResolutionError extends Error {
  readonly provider: ProviderName;

  constructor(provider: ProviderName) {
    super(`Could not resolve the stored credential for provider "${provider}"`);
    this.name = 'CredentialResolutionError';
    this.provider = provider;
  }
}

export interface CompletionInput {
  readonly tenantId: string;
  readonly request: ChatCompletionRequest;
  /** A per-request (BYOK) provider key, when the caller supplied one. */
  readonly perRequestKey?: string;
  readonly ctx: RequestContext;
}

/**
 * Implemented here by the raw provider-calling service and, in later specs, by
 * the caching and failover services that wrap it — all three satisfy this one
 * contract so the route always calls the outermost.
 */
export interface CompletionService {
  /**
   * @throws {import('./providers/provider-registry.js').UnsupportedProviderError}
   * when no adapter serves the requested provider.
   * @throws {MissingCredentialError} when the tenant has no key for it.
   * @throws {CredentialResolutionError} when a stored key cannot be decrypted.
   * @throws {import('./types.js').ProviderError} when the provider call fails.
   */
  complete(input: CompletionInput): Promise<NormalizedResponse>;
}

export interface CompletionServiceDeps {
  readonly registry: ProviderRegistry;
  readonly credentials: CredentialResolver;
  readonly config: GatewayConfig;
  /**
   * Monotonic clock in milliseconds, for the recorded latency. Injectable so a
   * test can assert an exact duration; defaults to `performance.now`, which —
   * unlike `Date.now` — cannot run backwards when the system clock is adjusted
   * mid-call.
   */
  readonly now?: () => number;
}

/**
 * The innermost of the three services that will implement this contract — the
 * one that actually calls a provider. Constructed once at plugin registration
 * and shared by every request: it holds only collaborators and deployment
 * settings, never per-request state.
 */
export class DefaultCompletionService implements CompletionService {
  readonly #registry: ProviderRegistry;
  readonly #credentials: CredentialResolver;
  readonly #now: () => number;

  /**
   * Derived from config once: deployment settings, identical for every request.
   * The adapter still takes them per call so `resilience-failover` can vary them
   * per attempt without reconstructing anything.
   */
  readonly #callOptions: ProviderCallOptions;

  constructor({ registry, credentials, config, now }: CompletionServiceDeps) {
    this.#registry = registry;
    this.#credentials = credentials;
    this.#now = now ?? (() => performance.now());
    this.#callOptions = Object.freeze({
      timeoutMs: config.requestTimeoutMs,
      defaultMaxTokens: config.defaultMaxTokens,
    });
  }

  async complete({
    tenantId,
    request,
    perRequestKey,
    ctx,
  }: CompletionInput): Promise<NormalizedResponse> {
    const startedAt = this.#now();

    // Selection first: it is pure, so an unsupported provider costs no
    // credential lookup.
    const adapter = this.#registry.select(request.provider);

    const secret = await resolveSecret(this.#credentials, {
      tenantId,
      provider: request.provider,
      perRequestKey,
    });

    // Before the call, so the attempt is visible downstream even if it fails.
    // The secret is not an argument here and so cannot be written into a context
    // that telemetry reads.
    populateCompletionContext(ctx, request);

    try {
      const response = await adapter.complete(
        request,
        secret,
        this.#callOptions,
      );

      // The model the provider reports having served, which need not be the one
      // asked for — an alias such as `gpt-4o-mini` resolves to a dated build.
      ctx.model = response.model;
      ctx.tokenUsage = toTokenUsage(response.usage);

      return response;
    } finally {
      // Written on success and on a failed call alike: a provider was attempted
      // either way, and a failure's duration is exactly what a timeout
      // investigation needs. Requests rejected before this point never reach
      // here, so their `latencyMs` keeps the default `null` that means "no
      // provider was called".
      ctx.latencyMs = Math.round(this.#now() - startedAt);
    }
  }
}

/**
 * Turn the resolver's tagged outcomes into the errors the route maps.
 *
 * `perRequestKey` is spread in only when present: under
 * `exactOptionalPropertyTypes` an explicit `undefined` is not the same as an
 * absent optional property, and the resolver's "was a BYOK key supplied?" test
 * reads the property.
 */
async function resolveSecret(
  resolver: CredentialResolver,
  {
    tenantId,
    provider,
    perRequestKey,
  }: {
    tenantId: string;
    provider: ProviderName;
    perRequestKey: string | undefined;
  },
): Promise<ProviderSecret> {
  const input: ResolveCredentialInput = {
    tenantId,
    provider,
    ...(perRequestKey === undefined ? {} : { perRequestKey }),
  };

  const resolution = await resolver.resolveCredential(input);

  switch (resolution.kind) {
    case 'resolved':
      return resolution.secret;
    case 'missing':
      throw new MissingCredentialError(provider);
    case 'decryption_failed':
      throw new CredentialResolutionError(provider);
  }
}

/**
 * The two shapes carry the same three counts under different names, kept apart
 * deliberately (see `types.ts`). A fresh object is assigned rather than the
 * context's default one mutated, so nothing else holds a reference to the counts.
 */
function toTokenUsage(usage: NormalizedUsage): TokenUsage {
  return {
    prompt: usage.promptTokens,
    completion: usage.completionTokens,
    total: usage.totalTokens,
  };
}
