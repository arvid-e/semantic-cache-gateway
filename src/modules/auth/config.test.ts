import { randomBytes } from 'node:crypto';
import { AuthConfigError, loadAuthConfig } from './config.js';

/** A fresh base64-encoded 32-byte value, usable as an AES key or a pepper. */
function secret32(): string {
  return randomBytes(32).toString('base64');
}

const KEY_V1 = secret32();
const PEPPER = secret32();
const ADMIN_TOKEN = 'admin-token-1234567890';

/** Minimal environment with every required auth setting present and valid. */
function validEnv(): NodeJS.ProcessEnv {
  return {
    AUTH_ENCRYPTION_KEYS: `1:${KEY_V1}`,
    AUTH_ACTIVE_KEY_VERSION: '1',
    AUTH_GATEWAY_KEY_PEPPER: PEPPER,
    AUTH_ADMIN_TOKEN: ADMIN_TOKEN,
  };
}

describe('loadAuthConfig', () => {
  it('parses a valid environment into a typed, read-only config', () => {
    const config = loadAuthConfig(validEnv());

    expect(config.encryption.activeKeyVersion).toBe(1);
    expect(config.encryption.keyring.get(1)).toEqual(
      Buffer.from(KEY_V1, 'base64'),
    );
    expect(config.encryption.keyring.get(1)).toHaveLength(32);
    expect(config.gatewayKeyPepper).toEqual(Buffer.from(PEPPER, 'base64'));
    expect(config.adminToken).toBe(ADMIN_TOKEN);

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.encryption)).toBe(true);
  });

  it('supports a multi-version keyring with a non-latest active version', () => {
    const keyV2 = secret32();
    const env = validEnv();
    env.AUTH_ENCRYPTION_KEYS = `1:${KEY_V1},2:${keyV2}`;
    env.AUTH_ACTIVE_KEY_VERSION = '1';

    const config = loadAuthConfig(env);

    // Both keys are available for decryption; version 1 is active for new writes.
    expect(config.encryption.activeKeyVersion).toBe(1);
    expect(config.encryption.keyring.size).toBe(2);
    expect(config.encryption.keyring.get(2)).toEqual(
      Buffer.from(keyV2, 'base64'),
    );
  });

  it('throws an error naming a missing required setting', () => {
    const env = validEnv();
    delete env.AUTH_ADMIN_TOKEN;

    expect(() => loadAuthConfig(env)).toThrow(AuthConfigError);
    expect(() => loadAuthConfig(env)).toThrow(/AUTH_ADMIN_TOKEN/);
  });

  it('rejects an active version that has no key in the keyring', () => {
    const env = validEnv();
    env.AUTH_ACTIVE_KEY_VERSION = '9';

    expect(() => loadAuthConfig(env)).toThrow(/AUTH_ACTIVE_KEY_VERSION/);
  });

  it('rejects an encryption key that does not decode to 32 bytes', () => {
    const env = validEnv();
    env.AUTH_ENCRYPTION_KEYS = `1:${randomBytes(16).toString('base64')}`;

    expect(() => loadAuthConfig(env)).toThrow(/AUTH_ENCRYPTION_KEYS/);
  });

  it('rejects a pepper below the minimum entropy', () => {
    const env = validEnv();
    env.AUTH_GATEWAY_KEY_PEPPER = randomBytes(16).toString('base64');

    expect(() => loadAuthConfig(env)).toThrow(/AUTH_GATEWAY_KEY_PEPPER/);
  });

  it('never prints a secret value when a setting is invalid', () => {
    const badKey = randomBytes(16).toString('base64'); // wrong length → invalid
    const env = validEnv();
    env.AUTH_ENCRYPTION_KEYS = `1:${badKey}`;
    env.AUTH_GATEWAY_KEY_PEPPER = PEPPER;

    try {
      loadAuthConfig(env);
      expect.fail('expected loadAuthConfig to throw');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('AUTH_ENCRYPTION_KEYS'); // names the setting
      expect(message).not.toContain(badKey); // but never the key material
      expect(message).not.toContain(PEPPER); // nor any other secret
      expect(message).not.toContain(ADMIN_TOKEN);
    }
  });

  it('rejects a malformed keyring entry without a version separator', () => {
    const env = validEnv();
    env.AUTH_ENCRYPTION_KEYS = KEY_V1; // no "<version>:" prefix

    try {
      loadAuthConfig(env);
      expect.fail('expected loadAuthConfig to throw');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('AUTH_ENCRYPTION_KEYS');
      expect(message).not.toContain(KEY_V1);
    }
  });
});
