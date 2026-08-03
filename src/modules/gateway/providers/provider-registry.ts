import type { ProviderName } from '#src/modules/auth/types.js';
import type { GatewayConfig } from '../config.js';
import type { ProviderAdapter } from '../types.js';
import { AnthropicAdapter } from './anthropic-adapter.js';
import { OllamaAdapter } from './ollama-adapter.js';
import { OpenAiAdapter } from './openai-adapter.js';

/**
 * A provider that has no adapter. Distinct from `ProviderError`, which describes
 * a *call* that failed: nothing was called here, so the route maps this onto a
 * client error rather than an upstream one. The offending name is safe to
 * surface — it came from the client's own request.
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
 * Instantiated once during gateway-plugin registration, not per request: the
 * adapters are stateless and hold only deployment config.
 */
export class DefaultProviderRegistry implements ProviderRegistry {
  /**
   * A Map rather than the record below, so an unknown name genuinely misses. A
   * plain-object lookup would resolve inherited keys — `constructor`,
   * `toString` — to something truthy, and the compiler cannot help here because
   * a bad name can only arrive through a cast in the first place.
   */
  readonly #byName: ReadonlyMap<string, ProviderAdapter>;

  constructor(config: GatewayConfig) {
    // A complete record over ProviderName: this literal is what makes "exactly
    // three providers" a compile-time property. Adding a fourth to the union in
    // auth breaks this line until an adapter for it exists.
    const adapters: Readonly<Record<ProviderName, ProviderAdapter>> = {
      openai: new OpenAiAdapter(config.providers.openai),
      anthropic: new AnthropicAdapter(config.providers.anthropic),
      ollama: new OllamaAdapter(config.providers.ollama),
    };

    this.#byName = new Map<string, ProviderAdapter>(Object.entries(adapters));

    // The runtime half of the same guarantee: no `register` to call, and nothing
    // can be bolted onto the instance afterwards.
    Object.freeze(this);
  }

  select(provider: ProviderName): ProviderAdapter {
    const adapter = this.#byName.get(provider);
    if (adapter === undefined) throw new UnsupportedProviderError(provider);
    return adapter;
  }
}
