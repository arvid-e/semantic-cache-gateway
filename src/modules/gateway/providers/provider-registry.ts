import type { ProviderName } from '#src/modules/auth/types.js';
import type { GatewayConfig } from '../config.js';
import type { ProviderAdapter } from '../types.js';
import { AnthropicAdapter } from './anthropic-adapter.js';
import { OllamaAdapter } from './ollama-adapter.js';
import { OpenAiAdapter } from './openai-adapter.js';

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
 * At runtime the table is built in the constructor and kept in a private field,
 * and the class exposes only {@link ProviderRegistry.select} — there is no
 * `register` to call — so an unknown name raises
 * {@link UnsupportedProviderError} rather than resolving to anything (Req 2.2).
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
 * {@link ProviderRegistry} over the three adapters, each constructed from the
 * gateway config.
 *
 * Instantiated once during gateway-plugin registration, not per request: the
 * adapters are stateless and hold only deployment config — the tenant credential
 * and the per-call options arrive on each {@link ProviderAdapter.complete} call
 * instead.
 */
export class DefaultProviderRegistry implements ProviderRegistry {
  /**
   * Looked up through a Map rather than a record so an unknown name genuinely
   * misses. A plain-object lookup would resolve inherited keys — `constructor`,
   * `toString` — to something truthy, and the compiler cannot help here because
   * a bad name can only arrive through a cast in the first place.
   */
  readonly #byName: ReadonlyMap<string, ProviderAdapter>;

  /** @param config - Validated gateway config supplying each provider's settings. */
  constructor(config: GatewayConfig) {
    // A complete record over ProviderName: this literal is what makes "exactly
    // three" a compile-time property. Adding a fourth provider to the union in
    // auth breaks this line until an adapter for it exists.
    const adapters: Readonly<Record<ProviderName, ProviderAdapter>> = {
      openai: new OpenAiAdapter(config.providers.openai),
      anthropic: new AnthropicAdapter(config.providers.anthropic),
      ollama: new OllamaAdapter(config.providers.ollama),
    };

    this.#byName = new Map<string, ProviderAdapter>(Object.entries(adapters));

    // Nothing can be bolted onto the instance afterwards — no `register`
    // property, no swapped `select` (Req 2.3). The adapter table itself is a
    // private field, so it is out of reach either way.
    Object.freeze(this);
  }

  select(provider: ProviderName): ProviderAdapter {
    const adapter = this.#byName.get(provider);
    if (adapter === undefined) throw new UnsupportedProviderError(provider);
    return adapter;
  }
}
