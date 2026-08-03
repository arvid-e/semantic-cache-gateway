import { inspect } from 'node:util';

/**
 * The identifiers and result shapes downstream specs consume:
 * `gateway-provider-routing`, `resilience-failover`, `rate-limiting`, and
 * `dual-layer-caching` all import from here, so treat this as a stable seam.
 */

/**
 * Single source of truth for the provider identifier. Mirrors the `provider`
 * CHECK constraint in this module's migration — adding or removing one is a
 * cross-spec change.
 */
export const PROVIDER_NAMES = ['openai', 'anthropic', 'ollama'] as const;

export type ProviderName = (typeof PROVIDER_NAMES)[number];

/** Used at boundaries — the admin API and stored rows — to reject an unknown
 * provider before it reaches the credential layer. */
export function isProviderName(value: string): value is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(value);
}

/** The isolation boundary that owns gateway keys and provider credentials. */
export interface Tenant {
  readonly id: string;
  readonly name: string;
  /** Lifecycle flag; `'active'` at creation. */
  readonly status: string;
  readonly createdAt: Date;
}

/** Only the keyed hash and a non-secret prefix are stored, never the plaintext. */
export interface GatewayApiKey {
  readonly id: string;
  readonly tenantId: string;
  /** HMAC-SHA256(pepper, key). */
  readonly keyHash: Buffer;
  /** Non-secret identifier shown in admin listings. */
  readonly keyPrefix: string;
  readonly createdAt: Date;
  /** `null` while active; set on revocation. */
  readonly revokedAt: Date | null;
}

/** No plaintext secret field exists: the secret is AES-256-GCM ciphertext with
 * the keyring version that encrypted it. */
export interface ProviderCredential {
  readonly id: string;
  readonly tenantId: string;
  readonly provider: ProviderName;
  /** `iv‖authTag‖ciphertext` (AES-256-GCM). */
  readonly ciphertext: Buffer;
  readonly keyVersion: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const REDACTED = '[REDACTED]';
type Redacted = typeof REDACTED;

/**
 * A provider secret that is safe by default and reveals its value only through
 * an explicit {@link ProviderSecret.reveal} call.
 *
 * Every implicit serialization path — `JSON.stringify`, string coercion,
 * `console.log`/`util.inspect` — yields `'[REDACTED]'`, so a resolved credential
 * cannot leak into logs, errors, or telemetry by accident. The raw value lives
 * in a private field, so it is not enumerable and never appears in a
 * structured-clone or spread either.
 */
export class ProviderSecret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The only path that exposes the plaintext; keep call sites minimal. */
  reveal(): string {
    return this.#value;
  }

  toJSON(): Redacted {
    return REDACTED;
  }

  toString(): Redacted {
    return REDACTED;
  }

  /** `console.log`/`util.inspect` ignore `toString`, hence this hook. */
  [inspect.custom](): Redacted {
    return REDACTED;
  }
}

/**
 * A tagged union rather than exceptions, so the caller handles each case
 * explicitly: routing maps `missing` to a client error and `decryption_failed`
 * to a safe 5xx.
 */
export type CredentialResolution =
  | {
      readonly kind: 'resolved';
      readonly secret: ProviderSecret;
      /** Whether the secret came from the request or from decrypted storage. */
      readonly source: 'per_request' | 'stored';
    }
  | { readonly kind: 'missing' }
  | { readonly kind: 'decryption_failed' };

/**
 * A wrong keyring version, a tampered ciphertext, or a failed auth tag. Carries
 * no ciphertext or key material — only the non-secret `keyVersion`. Thrown by
 * the envelope-encryption util; the resolver catches it and returns a
 * `decryption_failed` {@link CredentialResolution}.
 */
export class DecryptionError extends Error {
  readonly keyVersion: number | undefined;

  constructor(keyVersion?: number, options?: ErrorOptions) {
    super('Failed to decrypt provider credential', options);
    this.name = 'DecryptionError';
    this.keyVersion = keyVersion;
  }
}

/**
 * No credential for a `(tenant, provider)` pair — neither a per-request key nor
 * a stored one. The provider name is not secret, so it is safe to include in the
 * caller's error response.
 */
export class MissingCredentialError extends Error {
  readonly provider: ProviderName;

  constructor(provider: ProviderName) {
    super(`No credential available for provider "${provider}"`);
    this.name = 'MissingCredentialError';
    this.provider = provider;
  }
}
