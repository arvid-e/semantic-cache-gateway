import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { AuthConfig } from '../config.js';
import { DecryptionError } from '../types.js';

/**
 * Envelope encryption for provider credentials at rest (Req 3.1, 3.4, 3.5, 6.2).
 *
 * Secrets are sealed with AES-256-GCM under a *versioned* keyring: each
 * encryption uses the active key and a fresh 12-byte nonce, and stores the
 * `key_version` alongside the ciphertext so decryption can select the exact key
 * that sealed it. This lets the active key rotate without re-encrypting existing
 * rows. GCM's authentication tag makes tampering detectable: a modified
 * ciphertext, nonce, or tag fails authentication and is rejected.
 *
 * Every failure path raises a {@link DecryptionError} whose message carries no
 * ciphertext or key material — only the non-secret `key_version` (Req 3.5, 6.2).
 */

/** AES-256-GCM: a 256-bit key with an authenticated 96-bit nonce. */
const ALGORITHM = 'aes-256-gcm';

/** GCM nonce length. 12 bytes is the standard, most efficient IV size. */
const IV_BYTES = 12;

/** GCM authentication tag length (128 bits). */
const AUTH_TAG_BYTES = 16;

/** A sealed secret and the keyring version whose key sealed it. */
export interface EncryptedSecret {
  /** `iv‖authTag‖ciphertext`, ready to persist as `bytea`. */
  readonly ciphertext: Buffer;
  /** `key_version` to persist alongside, for later key selection. */
  readonly keyVersion: number;
}

/** Seal and open provider secrets over a versioned AES-256-GCM keyring. */
export interface EnvelopeEncryption {
  /** Encrypt with the active key and a fresh nonce. */
  encrypt(plaintext: string): EncryptedSecret;
  /** Decrypt using the key for `keyVersion`; throws {@link DecryptionError}. */
  decrypt(ciphertext: Buffer, keyVersion: number): string;
}

/**
 * {@link EnvelopeEncryption} over the auth config's keyring. The active key is
 * resolved once in the constructor; the full keyring is retained so ciphertext
 * written under an older version still decrypts after rotation.
 */
export class DefaultEnvelopeEncryption implements EnvelopeEncryption {
  private readonly keyring: AuthConfig['encryption']['keyring'];
  private readonly activeKeyVersion: number;
  private readonly activeKey: Buffer;

  /**
   * @param encryption - `AuthConfig.encryption` (keyring + active version).
   * Config validation guarantees the active version maps to a 32-byte key.
   */
  constructor(encryption: AuthConfig['encryption']) {
    this.keyring = encryption.keyring;
    this.activeKeyVersion = encryption.activeKeyVersion;

    const activeKey = this.keyring.get(this.activeKeyVersion);
    // Config validation already enforces this; guard defensively so a misuse
    // surfaces as a plain invariant error, never a silent undefined-key crash.
    // The message names the version (non-secret), never key material.
    if (activeKey === undefined) {
      throw new Error(
        `No encryption key configured for active version ${String(this.activeKeyVersion)}`,
      );
    }
    this.activeKey = activeKey;
  }

  encrypt(plaintext: string): EncryptedSecret {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.activeKey, iv);
    const sealed = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return {
      ciphertext: Buffer.concat([iv, authTag, sealed]),
      keyVersion: this.activeKeyVersion,
    };
  }

  decrypt(ciphertext: Buffer, keyVersion: number): string {
    const key = this.keyring.get(keyVersion);
    if (key === undefined) throw new DecryptionError(keyVersion);

    // Reject anything too short to hold a nonce and tag before slicing.
    if (ciphertext.length < IV_BYTES + AUTH_TAG_BYTES) {
      throw new DecryptionError(keyVersion);
    }

    const iv = ciphertext.subarray(0, IV_BYTES);
    const authTag = ciphertext.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
    const sealed = ciphertext.subarray(IV_BYTES + AUTH_TAG_BYTES);

    try {
      const decipher = createDecipheriv(ALGORITHM, key, iv);
      decipher.setAuthTag(authTag);
      // `final()` throws if the tag does not authenticate (tampering or a
      // wrong key). The cause is a generic crypto error with no secret in it.
      return Buffer.concat([
        decipher.update(sealed),
        decipher.final(),
      ]).toString('utf8');
    } catch (cause) {
      throw new DecryptionError(keyVersion, { cause });
    }
  }
}
