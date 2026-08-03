import type { EnvelopeEncryption } from '../crypto/envelope-encryption.js';
import type { CredentialRepository } from '../repositories/credential-repository.js';
import { ProviderSecret, type ProviderName } from '../types.js';

/**
 * Secrets are sealed before they ever reach storage and decrypted only
 * transiently, in memory. Each credential is scoped to a `(tenant, provider)`
 * pair, so a tenant can hold one credential per provider and several providers
 * at once — which is what enables failover.
 */
export interface CredentialService {
  /** Encrypt and upsert on `(tenant, provider)`: attach, or rotate in place. */
  attachOrRotate(
    tenantId: string,
    provider: ProviderName,
    secret: string,
  ): Promise<void>;
  remove(tenantId: string, provider: ProviderName): Promise<void>;
  /**
   * `null` if none exists. Propagates {@link DecryptionError} on decrypt
   * failure; the resolver maps that to a typed result.
   */
  getDecrypted(
    tenantId: string,
    provider: ProviderName,
  ): Promise<ProviderSecret | null>;
}

export class DefaultCredentialService implements CredentialService {
  constructor(
    private readonly encryption: EnvelopeEncryption,
    private readonly credentials: CredentialRepository,
  ) {}

  async attachOrRotate(
    tenantId: string,
    provider: ProviderName,
    secret: string,
  ): Promise<void> {
    const { ciphertext, keyVersion } = this.encryption.encrypt(secret);
    await this.credentials.upsert({
      tenantId,
      provider,
      ciphertext,
      keyVersion,
    });
  }

  async remove(tenantId: string, provider: ProviderName): Promise<void> {
    await this.credentials.delete({ tenantId, provider });
  }

  async getDecrypted(
    tenantId: string,
    provider: ProviderName,
  ): Promise<ProviderSecret | null> {
    const stored = await this.credentials.find({ tenantId, provider });
    if (stored === null) return null;
    // Decrypts transiently; may throw DecryptionError (handled upstream).
    const plaintext = this.encryption.decrypt(
      stored.ciphertext,
      stored.keyVersion,
    );
    return new ProviderSecret(plaintext);
  }
}
