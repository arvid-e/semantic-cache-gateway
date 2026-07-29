import { PROVIDER_NAMES, type ProviderName } from '#src/modules/auth/types.js';
import type { GatewayConfig } from '../config.js';
import {
  createProviderRegistry,
  UnsupportedProviderError,
} from './provider-registry.js';

const CONFIG: GatewayConfig = {
  requestTimeoutMs: 30_000,
  defaultMaxTokens: 1024,
  providers: {
    openai: { baseUrl: 'https://api.openai.com/v1' },
    anthropic: { baseUrl: 'https://api.anthropic.com', version: '2023-06-01' },
    ollama: { baseUrl: 'http://localhost:11434' },
  },
};

describe('provider registry', () => {
  it('resolves each supported provider to the adapter that owns it', () => {
    const registry = createProviderRegistry(CONFIG);

    for (const provider of PROVIDER_NAMES) {
      expect(registry.select(provider).name).toBe(provider);
    }
  });

  it('covers exactly the three supported providers', () => {
    const registry = createProviderRegistry(CONFIG);

    const resolved = PROVIDER_NAMES.map((provider) => registry.select(provider).name);

    expect(resolved).toEqual(['openai', 'anthropic', 'ollama']);
    expect(PROVIDER_NAMES).toHaveLength(3);
  });

  it('returns the same adapter instance on every selection', () => {
    const registry = createProviderRegistry(CONFIG);

    // Adapters are built once at registration, so a per-request selection costs
    // nothing and no adapter state can differ between two calls.
    expect(registry.select('openai')).toBe(registry.select('openai'));
  });

  it('rejects an unsupported provider with an error naming it', () => {
    const registry = createProviderRegistry(CONFIG);

    // Only reachable via a cast — which is exactly the boundary slip the runtime
    // guard exists for, since the compiler alone would not catch it.
    const select = (): unknown =>
      registry.select('gemini' as unknown as ProviderName);

    expect(select).toThrow(UnsupportedProviderError);
    expect(select).toThrow(/gemini/);
  });

  it('carries the offending provider on the error', () => {
    const registry = createProviderRegistry(CONFIG);

    const error = (() => {
      try {
        registry.select('gemini' as unknown as ProviderName);
        return undefined;
      } catch (caught: unknown) {
        return caught as UnsupportedProviderError;
      }
    })();

    expect(error?.name).toBe('UnsupportedProviderError');
    expect(error?.provider).toBe('gemini');
  });

  it('rejects a prototype key that is not a provider', () => {
    const registry = createProviderRegistry(CONFIG);

    // A plain-object lookup would resolve `constructor` or `toString` to
    // something truthy; the registry must treat them as unsupported.
    for (const key of ['constructor', 'toString', '__proto__']) {
      expect(() => registry.select(key as unknown as ProviderName)).toThrow(
        UnsupportedProviderError,
      );
    }
  });

  it('exposes no way to register a fourth provider', () => {
    const registry = createProviderRegistry(CONFIG);

    expect(Object.keys(registry)).toEqual(['select']);
    expect(Object.isFrozen(registry)).toBe(true);
  });
});
