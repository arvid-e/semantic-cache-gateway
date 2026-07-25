import type { EnvelopeEncryption } from '../crypto/envelope-encryption.js';
import type { CredentialRepository } from '../repositories/credential-repository.js';
import { ProviderSecret, type ProviderName } from '../types.js';

/**
 * Manage a tenant's provider credentials, encrypted at rest (Req 3.1–3.4, 5.3).
 *
 * Secrets are sealed before they ever reach storage and decrypted only
 * transiently, in memory, when a caller needs them — the plaintext is never
 * persisted. Each credential is scoped to a `(tenant, provider)` pair, so a
 * tenant can hold one credential per provider and several providers at once
 * (enabling failover). Retrieval hands back a {@link ProviderSecret}, so a
 * decrypted value cannot leak through logs or errors.
 */
export interface CredentialService {
  /**
   * Attach a provider credential, or rotate the existing one in place: encrypt
   * the secret and upsert on `(tenant, provider)` (Req 3.1, 3.2).
   */
  attachOrRotate(
    tenantId: string,
    provider: ProviderName,
    secret: string,
  ): Promise<void>;
  /** Remove a tenant's credential for a provider (Req 5.3). */
  remove(tenantId: string, provider: ProviderName): Promise<void>;
  /**
   * Decrypt a tenant's stored credential in memory, or `null` if none exists.
   * Propagates {@link DecryptionError} on decrypt failure; the resolver maps
   * that to a typed result (Req 3.4, 3.5).
   */
  getDecrypted(
    tenantId: string,
    provider: ProviderName,
  ): Promise<ProviderSecret | null>;
}

/**
 * Build a {@link CredentialService} over the envelope-encryption util and the
 * credential repository.
 */
export function createCredentialService(
  encryption: EnvelopeEncryption,
  credentials: CredentialRepository,
): CredentialService {
  return {
    async attachOrRotate(
      tenantId: string,
      provider: ProviderName,
      secret: string,
    ): Promise<void> {
      const { ciphertext, keyVersion } = encryption.encrypt(secret);
      await credentials.upsert({ tenantId, provider, ciphertext, keyVersion });
    },

    async remove(tenantId: string, provider: ProviderName): Promise<void> {
      await credentials.delete({ tenantId, provider });
    },

    async getDecrypted(
      tenantId: string,
      provider: ProviderName,
    ): Promise<ProviderSecret | null> {
      const stored = await credentials.find({ tenantId, provider });
      if (stored === null) return null;
      // Decrypts transiently; may throw DecryptionError (handled upstream).
      const plaintext = encryption.decrypt(
        stored.ciphertext,
        stored.keyVersion,
      );
      return new ProviderSecret(plaintext);
    },
  };
}
