import {
  GatewayConfigError,
  loadGatewayConfig,
  type GatewayFoundationSettings,
} from './config.js';

const OLLAMA_URL = 'http://localhost:11434';

/** The slice of the foundation config this segment reuses (Ollama's base URL). */
function foundation(url: string = OLLAMA_URL): GatewayFoundationSettings {
  return { ollama: { url } };
}

/**
 * An environment with none of this segment's settings present. Every gateway
 * setting is optional, so this is the valid "defaults only" baseline.
 */
function emptyEnv(): NodeJS.ProcessEnv {
  return {};
}

/** The message of the error `load` throws; fails the test if it throws nothing. */
function messageFrom(load: () => unknown): string {
  try {
    load();
  } catch (err) {
    return (err as Error).message;
  }
  expect.fail('expected loadGatewayConfig to throw');
}

describe('loadGatewayConfig', () => {
  it('parses an environment into a typed, read-only config', () => {
    const config = loadGatewayConfig(foundation(), {
      PROVIDER_TIMEOUT_MS: '15000',
      PROVIDER_DEFAULT_MAX_TOKENS: '2048',
      OPENAI_BASE_URL: 'https://openai.example.test/v1',
      ANTHROPIC_BASE_URL: 'https://anthropic.example.test',
      ANTHROPIC_VERSION: '2024-10-22',
    });

    expect(config.requestTimeoutMs).toBe(15_000);
    expect(config.defaultMaxTokens).toBe(2048);
    expect(config.providers.openai.baseUrl).toBe(
      'https://openai.example.test/v1',
    );
    expect(config.providers.anthropic.baseUrl).toBe(
      'https://anthropic.example.test',
    );
    expect(config.providers.anthropic.version).toBe('2024-10-22');

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.providers)).toBe(true);
    expect(Object.isFrozen(config.providers.anthropic)).toBe(true);
  });

  it('reuses the foundation setting for the Ollama base URL', () => {
    const config = loadGatewayConfig(
      foundation('http://ollama.internal:11434'),
      emptyEnv(),
    );

    // The foundation owns OLLAMA_URL; this segment must not re-read or
    // re-validate it from the environment.
    expect(config.providers.ollama.baseUrl).toBe(
      'http://ollama.internal:11434',
    );
  });

  it('falls back to the public provider endpoints and a pinned API version', () => {
    const config = loadGatewayConfig(foundation(), emptyEnv());

    expect(config.providers.openai.baseUrl).toBe('https://api.openai.com/v1');
    expect(config.providers.anthropic.baseUrl).toBe(
      'https://api.anthropic.com',
    );
    expect(config.providers.anthropic.version).toBe('2023-06-01');
    expect(config.requestTimeoutMs).toBeGreaterThan(0);
    expect(config.defaultMaxTokens).toBeGreaterThan(0);
  });

  it('rejects a non-numeric request timeout, naming the setting', () => {
    const load = (): unknown =>
      loadGatewayConfig(foundation(), { PROVIDER_TIMEOUT_MS: 'thirty' });

    expect(load).toThrow(GatewayConfigError);
    expect(load).toThrow(/PROVIDER_TIMEOUT_MS/);
  });

  it('rejects a non-positive or fractional request timeout', () => {
    for (const value of ['0', '-1000', '1500.5']) {
      expect(() =>
        loadGatewayConfig(foundation(), { PROVIDER_TIMEOUT_MS: value }),
      ).toThrow(/PROVIDER_TIMEOUT_MS/);
    }
  });

  it('rejects a non-positive default max-tokens, naming the setting', () => {
    const load = (): unknown =>
      loadGatewayConfig(foundation(), { PROVIDER_DEFAULT_MAX_TOKENS: '0' });

    expect(load).toThrow(GatewayConfigError);
    expect(load).toThrow(/PROVIDER_DEFAULT_MAX_TOKENS/);
  });

  it('reports a malformed base URL by name only, with no echoed detail', () => {
    const message = messageFrom(() =>
      loadGatewayConfig(foundation(), {
        OPENAI_BASE_URL: 'not-a-url-sensitive-fragment',
      }),
    );

    expect(message).toContain('OPENAI_BASE_URL');
    // A base URL can carry credentials, so a sensitive setting is named without
    // the validator's detail — the channel through which an input could quote
    // back. Contrast the non-sensitive setting below, which does carry a reason.
    expect(message).not.toMatch(/OPENAI_BASE_URL \(/);
    expect(message).not.toContain('sensitive-fragment');
  });

  it('appends the reason for a non-sensitive setting', () => {
    const message = messageFrom(() =>
      loadGatewayConfig(foundation(), { PROVIDER_TIMEOUT_MS: 'thirty' }),
    );

    expect(message).toMatch(/PROVIDER_TIMEOUT_MS \(/);
  });

  it('rejects a base URL carrying embedded credentials, without echoing them', () => {
    // The gateway holds no provider account: credentials arrive per tenant (BYOK),
    // never baked into a deployment URL.
    const load = (): unknown =>
      loadGatewayConfig(foundation(), {
        ANTHROPIC_BASE_URL: 'https://user:hunter2@proxy.example.test',
      });

    expect(load).toThrow(GatewayConfigError);
    expect(load).toThrow(/ANTHROPIC_BASE_URL/);
    expect(load).not.toThrow(/hunter2/);
  });

  it('rejects an Anthropic version that is not a dated release', () => {
    const load = (): unknown =>
      loadGatewayConfig(foundation(), { ANTHROPIC_VERSION: 'latest' });

    expect(load).toThrow(GatewayConfigError);
    expect(load).toThrow(/ANTHROPIC_VERSION/);
  });

  it('rejects a blank reused Ollama URL, naming the foundation setting', () => {
    const load = (): unknown =>
      loadGatewayConfig({ ollama: { url: '' } }, emptyEnv());

    expect(load).toThrow(GatewayConfigError);
    expect(load).toThrow(/OLLAMA_URL/);
  });

  it('names every offending setting in one failure', () => {
    const load = (): unknown =>
      loadGatewayConfig(foundation(), {
        PROVIDER_TIMEOUT_MS: '-1',
        ANTHROPIC_VERSION: 'v1',
      });

    expect(load).toThrow(/PROVIDER_TIMEOUT_MS/);
    expect(load).toThrow(/ANTHROPIC_VERSION/);
  });

  it('throws a recognizable, named error type', () => {
    try {
      loadGatewayConfig(foundation(), { PROVIDER_TIMEOUT_MS: 'nope' });
      expect.fail('expected loadGatewayConfig to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(GatewayConfigError);
      expect((err as GatewayConfigError).name).toBe('GatewayConfigError');
    }
  });
});
