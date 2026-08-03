import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Gateway keys are stored only as a non-reversible keyed hash, so a database
 * leak does not expose usable credentials. HMAC under the configured pepper is
 * deterministic (identical key + pepper → identical hash), so authentication is
 * a single indexed lookup on `key_hash`, yet unforgeable without the pepper.
 *
 * These keys are deliberately distinct from customer provider keys: the `scg_`
 * scheme identifies a gateway key on sight, and this util never touches provider
 * secrets.
 */

const KEY_SCHEME = 'scg_';

/** 256 bits of entropy, base64url-encoded. */
const KEY_ENTROPY_BYTES = 32;

/**
 * Eight base64url chars (~48 bits) is enough to identify a key in an admin
 * listing while leaving the full 256-bit key uncompromised.
 */
const PREFIX_BODY_LENGTH = 8;

export interface GeneratedGatewayKey {
  /** The full key, surfaced to the caller exactly once at issuance. */
  readonly plaintext: string;
  /** Non-secret identifier (`scg_` + first chars) stored for display. */
  readonly prefix: string;
  /** HMAC-SHA256(pepper, plaintext) — the only form persisted. */
  readonly hash: Buffer;
}

export interface KeyHashUtil {
  /** Mint a new gateway key; the plaintext exists only in the return value. */
  generateGatewayKey(): GeneratedGatewayKey;
  hash(key: string): Buffer;
  /** Constant-time check that `key` hashes to `storedHash`. */
  matches(key: string, storedHash: Buffer): boolean;
}

/** The pepper is held privately and never leaves the instance. */
export class DefaultKeyHashUtil implements KeyHashUtil {
  constructor(private readonly pepper: Buffer) {}

  generateGatewayKey(): GeneratedGatewayKey {
    const body = randomBytes(KEY_ENTROPY_BYTES).toString('base64url');
    const plaintext = `${KEY_SCHEME}${body}`;
    return {
      plaintext,
      prefix: `${KEY_SCHEME}${body.slice(0, PREFIX_BODY_LENGTH)}`,
      hash: this.hash(plaintext),
    };
  }

  hash(key: string): Buffer {
    return createHmac('sha256', this.pepper).update(key).digest();
  }

  matches(key: string, storedHash: Buffer): boolean {
    const candidate = this.hash(key);
    // `timingSafeEqual` throws on a length mismatch, so guard it. Our hashes
    // are always 32 bytes; a differing length means a definite non-match and
    // is rejected without a comparison (the length itself is not secret).
    if (candidate.length !== storedHash.length) return false;
    return timingSafeEqual(candidate, storedHash);
  }
}
