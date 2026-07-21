import { ConfigValidationError, loadConfig } from './load-config.js';

// Minimal environment with every required setting present and valid.
// Optional settings are intentionally omitted so tests can assert defaults.
function validEnv(): NodeJS.ProcessEnv {
  return {
    POSTGRES_URL: 'postgres://user:pw@localhost:5432/gateway',
    REDIS_URL: 'redis://localhost:6379',
    OLLAMA_URL: 'http://localhost:11434',
  };
}

describe('loadConfig', () => {
  it('throws an error naming a missing required setting', () => {
    const env = validEnv();
    delete env.POSTGRES_URL;

    expect(() => loadConfig(env)).toThrow(ConfigValidationError);
    expect(() => loadConfig(env)).toThrow(/POSTGRES_URL/);
  });

  it('reports an invalid sensitive setting without printing its value', () => {
    const env = validEnv();
    const secret = 'super-secret-connection-string';
    env.REDIS_URL = secret;

    try {
      loadConfig(env);
      expect.fail('expected loadConfig to throw');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('REDIS_URL'); // names the setting
      expect(message).not.toContain(secret); // but never its value
    }
  });

  it('applies documented defaults for optional settings', () => {
    const config = loadConfig(validEnv());

    expect(config.httpPort).toBe(3000);
    expect(config.logLevel).toBe('info');
    expect(config.postgres.poolMax).toBe(10);
    expect(config.nodeEnv).toBe('development');
  });

  it('returns a deeply frozen, read-only object', () => {
    const config = loadConfig(validEnv());

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.postgres)).toBe(true);
    expect(() => {
      // @ts-expect-error Config is read-only at the type level
      config.httpPort = 9999;
    }).toThrow(TypeError);
  });
});
