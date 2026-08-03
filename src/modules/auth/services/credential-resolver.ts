import type { CredentialService } from './credential-service.js';
import {
  DecryptionError,
  ProviderSecret,
  type CredentialResolution,
  type ProviderName,
} from '../types.js';

export interface ResolveCredentialInput {
  readonly tenantId: string;
  readonly provider: ProviderName;
  /** A per-request (BYOK) provider key, if the caller supplied one. */
  readonly perRequestKey?: string;
}

/**
 * The seam `gateway-provider-routing` consumes: it hands over a
 * `(tenant, provider)` and an optional per-request key, and gets back a typed
 * {@link CredentialResolution} it maps to an outbound call, a
 * missing-credential error, or a safe failure.
 */
export interface CredentialResolver {
  resolveCredential(
    input: ResolveCredentialInput,
  ): Promise<CredentialResolution>;
}

export class DefaultCredentialResolver implements CredentialResolver {
  constructor(private readonly credentials: CredentialService) {}

  async resolveCredential({
    tenantId,
    provider,
    perRequestKey,
  }: ResolveCredentialInput): Promise<CredentialResolution> {
    // BYOK: a supplied per-request key is used as-is and never persisted. An
    // empty value is treated as "not supplied".
    if (perRequestKey !== undefined && perRequestKey.length > 0) {
      return {
        kind: 'resolved',
        secret: new ProviderSecret(perRequestKey),
        source: 'per_request',
      };
    }

    let secret: ProviderSecret | null;
    try {
      secret = await this.credentials.getDecrypted(tenantId, provider);
    } catch (err) {
      // A decrypt failure is a typed, secret-free outcome the caller maps to a
      // safe error. Anything else is a real fault — rethrow.
      if (err instanceof DecryptionError) return { kind: 'decryption_failed' };
      throw err;
    }

    if (secret === null) return { kind: 'missing' };

    return { kind: 'resolved', secret, source: 'stored' };
  }
}
