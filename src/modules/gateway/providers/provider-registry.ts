import type { ProviderName } from '#src/modules/auth/types.js';
import type { GatewayConfig } from '../config.js';
import type { ProviderAdapter } from '../types.js';
import { createAnthropicAdapter } from './anthropic-adapter.js';
import { createOllamaAdapter } from './ollama-adapter.js';
import { createOpenAiAdapter } from './openai-adapter.js';

/**
 * The provider registry for the `gateway-provider-routing` module.
 *
 * One place that knows which adapter serves which provider: it builds the three
 * adapters from the gateway config at registration and resolves a
 * {@link ProviderName} to one of them per request (Req 2.1). Nothing else in the
 * module names an adapter directly, so the completion service selects a provider
 * without depending on how any of them is constructed.
 *
 * "Exactly three, and no others" (Req 2.3) is enforced twice over. At compile
 * time the adapter table is a complete {@link Record} over `ProviderName`, so a
 * missing provider fails to type-check and an extra one is an excess property.
 * At runtime the registry is frozen and exposes only {@link
 * ProviderRegistry.select} — there is no `register` to call — and an unknown
 * name raises {@link UnsupportedProviderError} rather than resolving to anything
 * (Req 2.2).
 */

/**
 * A provider that has no adapter. Distinct from `ProviderError`, which describes
 * a *call* that failed: nothing was called here, and the route maps this onto a
 * client error rather than an upstream one (Req 2.2).
 *
 * The offending name is carried and is safe to surface — it came from the
 * client's own request and holds no credential.
 */
export class UnsupportedProviderError extends Error {
  readonly provider: string;

  constructor(provider: string) {
    super(`Unsupported provider: ${provider}`);
    this.name = 'UnsupportedProviderError';
    this.provider = provider;
  }
}

/** Resolves a provider name to the adapter that serves it. */
export interface ProviderRegistry {
  /** @throws {UnsupportedProviderError} when no adapter serves `provider`. */
  select(provider: ProviderName): ProviderAdapter;
}

/**
 * Build the registry, constructing every adapter from the gateway config.
 *
 * Called once during gateway-plugin registration, not per request: the adapters
 * are stateless and hold only deployment config — the tenant credential and the
 * per-call options arrive on each {@link ProviderAdapter.complete} call instead.
 *
 * @param config - Validated gateway config supplying each provider's settings.
 */
export function createProviderRegistry(config: GatewayConfig): ProviderRegistry {
  // A complete record over ProviderName: this literal is what makes "exactly
  // three" a compile-time property. Adding a fourth provider to the union in
  // auth breaks this line until an adapter for it exists.
  const adapters: Readonly<Record<ProviderName, ProviderAdapter>> = {
    openai: createOpenAiAdapter(config.providers.openai),
    anthropic: createAnthropicAdapter(config.providers.anthropic),
    ollama: createOllamaAdapter(config.providers.ollama),
  };

  // Looked up through a Map rather than the record itself so an unknown name
  // genuinely misses. A plain-object lookup would resolve inherited keys —
  // `constructor`, `toString` — to something truthy, and the compiler cannot
  // help here because a bad name can only arrive through a cast in the first
  // place.
  const byName = new Map<string, ProviderAdapter>(Object.entries(adapters));

  return Object.freeze({
    select(provider: ProviderName): ProviderAdapter {
      const adapter = byName.get(provider);
      if (adapter === undefined) throw new UnsupportedProviderError(provider);
      return adapter;
    },
  });
}
