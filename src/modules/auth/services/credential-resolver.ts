import type { CredentialService } from './credential-service.js';
import {
  DecryptionError,
  ProviderSecret,
  type CredentialResolution,
  type ProviderName,
} from '../types.js';

/** Inputs to a single credential resolution for an authenticated request. */
export interface ResolveCredentialInput {
  /** The authenticated tenant the request belongs to. */
  readonly tenantId: string;
  /** The provider the request is routed to. */
  readonly provider: ProviderName;
  /** A per-request (BYOK) provider key, if the caller supplied one. */
  readonly perRequestKey?: string;
}

/**
 * Resolve the provider key to use for a request (Req 4.1–4.4).
 *
 * This is the seam `gateway-provider-routing` consumes: it hands over a
 * `(tenant, provider)` and an optional per-request key, and gets back a typed
 * {@link CredentialResolution} it maps to an outbound call, a missing-credential
 * error, or a safe failure.
 */
export interface CredentialResolver {
  resolveCredential(
    input: ResolveCredentialInput,
  ): Promise<CredentialResolution>;
}

/** {@link CredentialResolver} over the credential service. */
export class DefaultCredentialResolver implements CredentialResolver {
  constructor(private readonly credentials: CredentialService) {}

  async resolveCredential({
    tenantId,
    provider,
    perRequestKey,
  }: ResolveCredentialInput): Promise<CredentialResolution> {
    // BYOK: a supplied per-request key is used as-is and never persisted
    // (Req 4.1). An empty value is treated as "not supplied".
    if (perRequestKey !== undefined && perRequestKey.length > 0) {
      return {
        kind: 'resolved',
        secret: new ProviderSecret(perRequestKey),
        source: 'per_request',
      };
    }

    // Otherwise fall back to the tenant's stored, encrypted credential
    // (Req 4.2), decrypted transiently by the service.
    let secret: ProviderSecret | null;
    try {
      secret = await this.credentials.getDecrypted(tenantId, provider);
    } catch (err) {
      // A decrypt failure is a typed, secret-free outcome the caller maps to
      // a safe error (Req 3.5, 4.4). Anything else is a real fault — rethrow.
      if (err instanceof DecryptionError) return { kind: 'decryption_failed' };
      throw err;
    }

    // Neither per-request nor stored: a typed miss the caller turns into a
    // missing-credential error (Req 4.3).
    if (secret === null) return { kind: 'missing' };

    return { kind: 'resolved', secret, source: 'stored' };
  }
}
