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
 * Completion orchestration for the `gateway-provider-routing` module.
 *
 * This is the seam the whole module folds into: one call that turns a validated,
 * provider-agnostic request into a {@link NormalizedResponse}. It owns the
 * *order* of the steps and nothing else — selection lives in the registry,
 * translation and normalization live in the adapters, credential resolution
 * lives in `auth-tenancy-credentials`, and the context fields are written by
 * `context.ts`.
 *
 * The order is deliberate (Req 2.1, 3.2, 3.3, 5.1):
 *
 * 1. **Select the adapter.** Pure and cheap, so an unsupported provider is
 *    rejected before a datastore is touched.
 * 2. **Resolve the credential.** A per-request (BYOK) key if the caller sent
 *    one, otherwise the tenant's stored credential. A `missing` resolution
 *    becomes a {@link MissingCredentialError} and the provider is never called
 *    (Req 3.3); a `decryption_failed` one becomes a
 *    {@link CredentialResolutionError} the route maps to a safe 5xx.
 * 3. **Populate the pre-call context.** Provider, model, params, and the
 *    conversation, written before the call so a stage that only runs on failure
 *    still sees what was attempted (Req 5.2).
 * 4. **Invoke exactly one adapter**, then record what the answer cost: the
 *    provider-reported model (Req 2.4), the token usage, and the latency.
 *
 * The gateway holds no provider account of its own: the only key that reaches an
 * adapter is the tenant's, wrapped in `ProviderSecret` and revealed by the
 * adapter at its HTTP boundary (Req 3.2). Nothing here reveals it, writes it to
 * the context, or logs it.
 *
 * This service performs no caching, topic-shift, or context-verification logic
 * (Req 5.3) and no retry or failover — `dual-layer-caching` wraps this object
 * and `resilience-failover` wraps the adapter call, both against the
 * {@link CompletionService} contract, so keep the signature stable.
 */

/**
 * The stored credential exists but could not be made usable — the resolver
 * reported `decryption_failed` (a wrong keyring version, a tampered ciphertext).
 *
 * Distinct from {@link MissingCredentialError}: a missing credential is the
 * tenant's to fix and is a client error, whereas this is a gateway-side fault
 * that the route maps to a safe 5xx. Only the provider name is carried; the
 * ciphertext, the key version, and any key material stay behind the auth
 * module's own error (Req 4.3).
 */
export class CredentialResolutionError extends Error {
  readonly provider: ProviderName;

  constructor(provider: ProviderName) {
    super(`Could not resolve the stored credential for provider "${provider}"`);
    this.name = 'CredentialResolutionError';
    this.provider = provider;
  }
}

/** One completion, as handed over by the authenticated route. */
export interface CompletionInput {
  /** The authenticated tenant, resolved by auth's middleware. */
  readonly tenantId: string;
  /** The already-validated agnostic request. */
  readonly request: ChatCompletionRequest;
  /** A per-request (BYOK) provider key, when the caller supplied one. */
  readonly perRequestKey?: string;
  /** The request-scoped context this call populates. */
  readonly ctx: RequestContext;
}

/**
 * Orchestrates a single completion.
 *
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

/** Collaborators for {@link DefaultCompletionService}. */
export interface CompletionServiceDeps {
  /** Resolves a provider name to its adapter (built once at registration). */
  readonly registry: ProviderRegistry;
  /** Auth's BYOK resolver, decorated onto the app as `credentialResolver`. */
  readonly credentials: CredentialResolver;
  /** Supplies the per-call timeout and default max-tokens handed to adapters. */
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
 * {@link CompletionService} over the provider registry and auth's BYOK resolver:
 * the innermost of the three services that will implement this contract, the one
 * that actually calls a provider.
 *
 * Constructed once at plugin registration and shared by every request — it holds
 * only collaborators and deployment settings, never per-request state, so the
 * tenant, the credential, and the context all arrive as arguments.
 */
export class DefaultCompletionService implements CompletionService {
  readonly #registry: ProviderRegistry;
  readonly #credentials: CredentialResolver;
  readonly #now: () => number;

  /**
   * Derived from the config once: these are deployment settings, identical for
   * every request. The adapter still takes them per call, so
   * `resilience-failover` can vary them per attempt without reconstructing
   * anything.
   */
  readonly #callOptions: ProviderCallOptions;

  /**
   * @param deps - Registry, credential resolver, gateway config, and clock.
   * Taken as one object rather than positionally: four collaborators read badly
   * at the call site, and it keeps `now` optional without an argument gap.
   */
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
    // credential lookup (Req 2.1, 2.2).
    const adapter = this.#registry.select(request.provider);

    const secret = await resolveSecret(this.#credentials, {
      tenantId,
      provider: request.provider,
      perRequestKey,
    });

    // Before the call, so the attempt is visible downstream even if it fails
    // (Req 5.1, 5.2). The secret is not an argument here and cannot be written
    // into a context that telemetry reads (Req 3.2).
    populateCompletionContext(ctx, request);

    try {
      const response = await adapter.complete(
        request,
        secret,
        this.#callOptions,
      );

      // The model the provider reports having served, which need not be the one
      // asked for — an alias such as `gpt-4o-mini` resolves to a dated build
      // (Req 2.4).
      ctx.model = response.model;
      ctx.tokenUsage = toTokenUsage(response.usage);

      return response;
    } finally {
      // Written on success and on a failed call alike: a provider was attempted
      // either way, and a failure's duration is exactly what a timeout
      // investigation needs. Requests rejected before this point never reach
      // here, so their `latencyMs` keeps the default `null` that means "no
      // provider was called" (Req 5.4).
      ctx.latencyMs = Math.round(this.#now() - startedAt);
    }
  }
}

/**
 * Obtain the tenant's key for this request, turning the resolver's tagged
 * outcomes into the errors the route maps (Req 3.2, 3.3).
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
 * Map the adapter's {@link NormalizedUsage} onto the foundation's
 * {@link TokenUsage}.
 *
 * The two carry the same three counts under different names, deliberately kept
 * apart (see `types.ts`): the gateway's is the client-facing wire shape, the
 * foundation's is the context field telemetry reads. A fresh object is assigned
 * rather than the context's default one mutated, so nothing else holds a
 * reference to the counts.
 */
function toTokenUsage(usage: NormalizedUsage): TokenUsage {
  return {
    prompt: usage.promptTokens,
    completion: usage.completionTokens,
    total: usage.totalTokens,
  };
}
