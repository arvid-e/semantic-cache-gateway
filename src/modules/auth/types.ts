import { inspect } from 'node:util';

/**
 * Shared type contracts for the `auth-tenancy-credentials` module.
 *
 * This file is the canonical home of the identifiers and result shapes that
 * downstream specs consume: `gateway-provider-routing`, `resilience-failover`,
 * `rate-limiting`, and `dual-layer-caching` import {@link ProviderName}, the
 * {@link CredentialResolution} result, and the {@link ProviderSecret} wrapper
 * from here. Changing any of them is a documented revalidation trigger for those
 * specs, so treat this module as a stable seam.
 */

/**
 * The providers the gateway brokers credentials for. This is the single source
 * of truth for the identifier: {@link ProviderName} is derived from it, and it
 * mirrors the `provider` CHECK constraint in this spec's migration. Adding or
 * removing a provider here is a cross-spec change (update the migration's CHECK
 * and re-check every downstream consumer).
 */
export const PROVIDER_NAMES = ['openai', 'anthropic', 'ollama'] as const;

/**
 * Canonical provider identifier used to scope credentials (`(tenant, provider)`)
 * and to select an adapter downstream. Union derived from {@link PROVIDER_NAMES}.
 */
export type ProviderName = (typeof PROVIDER_NAMES)[number];

/**
 * Narrow an arbitrary string to a {@link ProviderName}. Used at boundaries — the
 * admin API and stored rows — to reject an unknown provider before it reaches
 * the credential layer.
 */
export function isProviderName(value: string): value is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(value);
}

/**
 * A tenant: the isolation boundary that owns gateway keys and provider
 * credentials. Mirrors a `tenants` row (camelCased).
 */
export interface Tenant {
  readonly id: string;
  readonly name: string;
  /** Lifecycle flag; `'active'` at creation. */
  readonly status: string;
  readonly createdAt: Date;
}

/**
 * A gateway API key as persisted: only its keyed hash and a non-secret prefix
 * are stored, never the plaintext key. Mirrors a `gateway_api_keys` row.
 */
export interface GatewayApiKey {
  readonly id: string;
  readonly tenantId: string;
  /** HMAC-SHA256(pepper, key); the plaintext is never persisted (Req 2.4). */
  readonly keyHash: Buffer;
  /** Non-secret identifier shown in admin listings. */
  readonly keyPrefix: string;
  readonly createdAt: Date;
  /** `null` while active; set on revocation. */
  readonly revokedAt: Date | null;
}

/**
 * A provider credential as persisted: the secret is AES-256-GCM ciphertext, with
 * the keyring version that encrypted it. Mirrors a `provider_credentials` row.
 * No plaintext secret field exists (Req 3.1).
 */
export interface ProviderCredential {
  readonly id: string;
  readonly tenantId: string;
  readonly provider: ProviderName;
  /** `iv‖authTag‖ciphertext` (AES-256-GCM). */
  readonly ciphertext: Buffer;
  /** `key_version` selecting the keyring entry used to encrypt `ciphertext`. */
  readonly keyVersion: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** The string every safe-serialization path emits in place of a secret. */
const REDACTED = '[REDACTED]';
type Redacted = typeof REDACTED;

/**
 * A provider secret that is safe by default and reveals its value only through
 * an explicit {@link ProviderSecret.reveal} call.
 *
 * Every implicit serialization path — `JSON.stringify` (via `toJSON`), string
 * coercion (via `toString`), and `console.log`/`util.inspect` (via the custom
 * inspect hook) — yields `'[REDACTED]'`, so a resolved credential cannot leak
 * into logs, errors, or telemetry by accident (Req 4.4, 6.3). The raw value is
 * held in a private field, so it is not enumerable and never appears in a
 * structured-clone or spread either. Callers touch the plaintext only at the
 * provider HTTP boundary, and that call site is deliberately conspicuous.
 */
export class ProviderSecret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  /** The raw secret. The only path that exposes it; keep call sites minimal. */
  reveal(): string {
    return this.#value;
  }

  /** Redacts under `JSON.stringify`. */
  toJSON(): Redacted {
    return REDACTED;
  }

  /** Redacts under string coercion and template literals. */
  toString(): Redacted {
    return REDACTED;
  }

  /** Redacts under `console.log`/`util.inspect`, which ignore `toString`. */
  [inspect.custom](): Redacted {
    return REDACTED;
  }
}

/**
 * Outcome of resolving a provider credential for a request (BYOK). A tagged
 * union rather than exceptions so the caller handles each case explicitly:
 * routing maps `missing` to a missing-credential error and `decryption_failed`
 * to a safe 5xx (Req 4.2, 4.3). A resolved secret is always wrapped in
 * {@link ProviderSecret} (Req 4.4).
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
 * Thrown when a stored credential cannot be decrypted — a wrong keyring version,
 * a tampered ciphertext, or a failed auth tag. The message carries no ciphertext
 * or key material; only the non-secret `keyVersion` is retained for diagnostics
 * (Req 3.5, 6.2). The envelope-encryption util throws it; the resolver catches
 * it and returns a `decryption_failed` {@link CredentialResolution}.
 */
export class DecryptionError extends Error {
  /** Non-secret `key_version` the failing ciphertext referenced, if known. */
  readonly keyVersion: number | undefined;

  constructor(keyVersion?: number, options?: ErrorOptions) {
    super('Failed to decrypt provider credential', options);
    this.name = 'DecryptionError';
    this.keyVersion = keyVersion;
  }
}

/**
 * Signals that no credential is available for a `(tenant, provider)` pair —
 * neither a per-request key nor a stored one (Req 4.3). The provider name is not
 * secret, so it is safe to include for the caller's error response.
 */
export class MissingCredentialError extends Error {
  readonly provider: ProviderName;

  constructor(provider: ProviderName) {
    super(`No credential available for provider "${provider}"`);
    this.name = 'MissingCredentialError';
    this.provider = provider;
  }
}
