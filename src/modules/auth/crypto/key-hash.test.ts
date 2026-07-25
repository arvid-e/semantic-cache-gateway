import { randomBytes } from 'node:crypto';
import { DefaultKeyHashUtil } from './key-hash.js';

const PEPPER = randomBytes(32);
const util = new DefaultKeyHashUtil(PEPPER);

describe('DefaultKeyHashUtil', () => {
  it('hashes the same key and pepper to an identical value', () => {
    const a = util.hash('scg_example-key');
    const b = util.hash('scg_example-key');
    expect(a).toEqual(b);
    expect(a).toHaveLength(32); // HMAC-SHA256 output
  });

  it('produces a different hash under a different pepper', () => {
    const other = new DefaultKeyHashUtil(randomBytes(32));
    expect(util.hash('scg_example-key')).not.toEqual(
      other.hash('scg_example-key'),
    );
  });

  it('matches a key against its own hash and rejects a wrong key', () => {
    const stored = util.hash('scg_correct-key');
    expect(util.matches('scg_correct-key', stored)).toBe(true);
    expect(util.matches('scg_wrong-key', stored)).toBe(false);
  });

  it('rejects — without throwing — a stored hash of the wrong length', () => {
    // timingSafeEqual throws on a length mismatch; matches must guard it.
    expect(util.matches('scg_correct-key', randomBytes(16))).toBe(false);
  });

  it('generates an scg_-prefixed key whose prefix and hash are consistent', () => {
    const key = util.generateGatewayKey();

    expect(key.plaintext.startsWith('scg_')).toBe(true);
    expect(key.prefix.startsWith('scg_')).toBe(true);
    // The stored prefix is a genuine prefix of the plaintext.
    expect(key.plaintext.startsWith(key.prefix)).toBe(true);
    // The stored hash is exactly the keyed hash of the plaintext.
    expect(key.hash).toEqual(util.hash(key.plaintext));
    expect(util.matches(key.plaintext, key.hash)).toBe(true);
  });

  it('generates a distinct high-entropy key each call', () => {
    const first = util.generateGatewayKey();
    const second = util.generateGatewayKey();
    expect(first.plaintext).not.toBe(second.plaintext);
    // 256 bits of entropy → a long body beyond the 4-char scheme.
    expect(first.plaintext.length).toBeGreaterThan(40);
  });
});
