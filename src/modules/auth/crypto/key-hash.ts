import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Gateway API-key generation and keyed hashing (Req 2.4, 6.4).
 *
 * Gateway keys are stored only as a non-reversible keyed hash — never in
 * plaintext — so a database leak does not expose usable credentials. Hashing is
 * an HMAC under the configured pepper, which is deterministic (identical key +
 * pepper → identical hash) so authentication is a single indexed lookup on
 * `key_hash`, yet unforgeable without the pepper. Candidate comparison is
 * constant-time to avoid leaking hash bytes through timing.
 *
 * These keys are deliberately distinct from customer provider keys (Req 2.5):
 * the `scg_` scheme identifies a gateway key on sight, and this util never
 * touches provider secrets.
 */

/** Scheme prefix marking a value as a gateway key (vs. a provider key). */
const KEY_SCHEME = 'scg_';

/** Random bytes behind each key — 256 bits of entropy, base64url-encoded. */
const KEY_ENTROPY_BYTES = 32;

/**
 * Characters of the encoded body kept in the non-secret `key_prefix`. Eight
 * base64url chars (~48 bits) is enough to identify a key in an admin listing
 * while leaving the full 256-bit key uncompromised.
 */
const PREFIX_BODY_LENGTH = 8;

/** A freshly generated gateway key and its derived, storable parts. */
export interface GeneratedGatewayKey {
  /** The full key, surfaced to the caller exactly once at issuance (Req 6.4). */
  readonly plaintext: string;
  /** Non-secret identifier (`scg_` + first chars) stored for display. */
  readonly prefix: string;
  /** HMAC-SHA256(pepper, plaintext) — the only form persisted (Req 2.4). */
  readonly hash: Buffer;
}

/** Generate, hash, and compare gateway API keys under a fixed pepper. */
export interface KeyHashUtil {
  /** Mint a new gateway key; the plaintext exists only in the return value. */
  generateGatewayKey(): GeneratedGatewayKey;
  /** Keyed hash of a presented key, for storage or indexed lookup. */
  hash(key: string): Buffer;
  /** Constant-time check that `key` hashes to `storedHash`. */
  matches(key: string, storedHash: Buffer): boolean;
}

/**
 * Build a {@link KeyHashUtil} bound to the gateway-key pepper from the auth
 * config. The pepper never leaves this closure.
 *
 * @param pepper - HMAC key from `AuthConfig.gatewayKeyPepper`.
 */
export function createKeyHashUtil(pepper: Buffer): KeyHashUtil {
  function hash(key: string): Buffer {
    return createHmac('sha256', pepper).update(key).digest();
  }

  return {
    generateGatewayKey(): GeneratedGatewayKey {
      const body = randomBytes(KEY_ENTROPY_BYTES).toString('base64url');
      const plaintext = `${KEY_SCHEME}${body}`;
      return {
        plaintext,
        prefix: `${KEY_SCHEME}${body.slice(0, PREFIX_BODY_LENGTH)}`,
        hash: hash(plaintext),
      };
    },

    hash,

    matches(key: string, storedHash: Buffer): boolean {
      const candidate = hash(key);
      // `timingSafeEqual` throws on a length mismatch, so guard it. Our hashes
      // are always 32 bytes; a differing length means a definite non-match and
      // is rejected without a comparison (the length itself is not secret).
      if (candidate.length !== storedHash.length) return false;
      return timingSafeEqual(candidate, storedHash);
    },
  };
}
