import { randomBytes } from 'node:crypto';
import type { AuthConfig } from '../config.js';
import { DecryptionError } from '../types.js';
import { DefaultEnvelopeEncryption } from './envelope-encryption.js';

const KEY_V1 = randomBytes(32);
const KEY_V2 = randomBytes(32);

/** An encryption config whose active version is 1, with v1 the only key. */
function singleKeyConfig(): AuthConfig['encryption'] {
  return { activeKeyVersion: 1, keyring: new Map([[1, KEY_V1]]) };
}

const SECRET = 'sk-provider-secret-value-123';

/**
 * Corrupt one byte of a buffer in place by flipping all of its bits.
 *
 * Goes through `readUInt8`/`writeUInt8` rather than `buffer[index] ^= 0xff`:
 * under `noUncheckedIndexedAccess` an indexed read is `number | undefined`, so
 * the compound assignment does not type-check.
 */
function flipByte(buffer: Buffer, index: number): void {
  buffer.writeUInt8(buffer.readUInt8(index) ^ 0xff, index);
}

describe('DefaultEnvelopeEncryption', () => {
  it('round-trips a secret through encrypt then decrypt', () => {
    const env = new DefaultEnvelopeEncryption(singleKeyConfig());
    const { ciphertext, keyVersion } = env.encrypt(SECRET);

    expect(keyVersion).toBe(1);
    expect(env.decrypt(ciphertext, keyVersion)).toBe(SECRET);
  });

  it('round-trips unicode and empty plaintext', () => {
    const env = new DefaultEnvelopeEncryption(singleKeyConfig());
    for (const value of ['', '🔐 clé-secrète']) {
      const { ciphertext, keyVersion } = env.encrypt(value);
      expect(env.decrypt(ciphertext, keyVersion)).toBe(value);
    }
  });

  it('never stores the plaintext in the ciphertext envelope', () => {
    const env = new DefaultEnvelopeEncryption(singleKeyConfig());
    const { ciphertext } = env.encrypt(SECRET);
    expect(ciphertext.toString('utf8')).not.toContain(SECRET);
    expect(ciphertext.toString('latin1')).not.toContain(SECRET);
  });

  it('uses a fresh nonce so identical plaintext yields distinct ciphertext', () => {
    const env = new DefaultEnvelopeEncryption(singleKeyConfig());
    const a = env.encrypt(SECRET);
    const b = env.encrypt(SECRET);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
    // ...yet both decrypt back to the same secret.
    expect(env.decrypt(a.ciphertext, a.keyVersion)).toBe(SECRET);
    expect(env.decrypt(b.ciphertext, b.keyVersion)).toBe(SECRET);
  });

  it('fails to decrypt a tampered ciphertext body', () => {
    const env = new DefaultEnvelopeEncryption(singleKeyConfig());
    const { ciphertext, keyVersion } = env.encrypt(SECRET);
    const tampered = Buffer.from(ciphertext);
    flipByte(tampered, tampered.length - 1); // a byte of the sealed body

    expect(() => env.decrypt(tampered, keyVersion)).toThrow(DecryptionError);
  });

  it('fails to decrypt when the auth tag is altered', () => {
    const env = new DefaultEnvelopeEncryption(singleKeyConfig());
    const { ciphertext, keyVersion } = env.encrypt(SECRET);
    const tampered = Buffer.from(ciphertext);
    flipByte(tampered, 12); // first byte of the 16-byte auth tag

    expect(() => env.decrypt(tampered, keyVersion)).toThrow(DecryptionError);
  });

  it('rejects a ciphertext too short to hold a nonce and tag', () => {
    const env = new DefaultEnvelopeEncryption(singleKeyConfig());
    expect(() => env.decrypt(randomBytes(10), 1)).toThrow(DecryptionError);
  });

  it('raises a secret-free DecryptionError for an unknown key version', () => {
    const env = new DefaultEnvelopeEncryption(singleKeyConfig());
    const { ciphertext } = env.encrypt(SECRET);

    try {
      env.decrypt(ciphertext, 99);
      expect.fail('expected decrypt to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DecryptionError);
      const decErr = err as DecryptionError;
      expect(decErr.keyVersion).toBe(99);
      expect(decErr.message).not.toContain(SECRET);
      expect(decErr.message).not.toContain(ciphertext.toString('base64'));
      expect(decErr.message).not.toContain(KEY_V1.toString('base64'));
    }
  });

  it('encrypts under the active version and decrypts across a rotated keyring', () => {
    // Active version 2, but both keys are present for decryption.
    const rotated: AuthConfig['encryption'] = {
      activeKeyVersion: 2,
      keyring: new Map([
        [1, KEY_V1],
        [2, KEY_V2],
      ]),
    };
    const env = new DefaultEnvelopeEncryption(rotated);

    const fresh = env.encrypt(SECRET);
    expect(fresh.keyVersion).toBe(2); // new writes use the active version
    expect(env.decrypt(fresh.ciphertext, fresh.keyVersion)).toBe(SECRET);

    // A secret sealed earlier under v1 still opens after rotation.
    const legacy = new DefaultEnvelopeEncryption(singleKeyConfig()).encrypt(
      SECRET,
    );
    expect(env.decrypt(legacy.ciphertext, legacy.keyVersion)).toBe(SECRET);
  });

  it('fails when a ciphertext is decrypted under the wrong existing key', () => {
    const rotated: AuthConfig['encryption'] = {
      activeKeyVersion: 1,
      keyring: new Map([
        [1, KEY_V1],
        [2, KEY_V2],
      ]),
    };
    const env = new DefaultEnvelopeEncryption(rotated);
    const { ciphertext } = env.encrypt(SECRET); // sealed under v1

    // Claiming version 2 selects the wrong key → auth tag fails.
    expect(() => env.decrypt(ciphertext, 2)).toThrow(DecryptionError);
  });
});
