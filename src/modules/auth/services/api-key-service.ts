import type { KeyHashUtil } from '../crypto/key-hash.js';
import type { ApiKeyRepository } from '../repositories/api-key-repository.js';

export interface IssuedApiKey {
  /** The persisted key row's id (for later revocation). */
  readonly id: string;
  /** The full key, returned to the caller exactly once. */
  readonly plaintext: string;
  readonly prefix: string;
}

export type AuthenticationResult =
  { readonly tenantId: string } | { readonly tenantId: null };

export interface ApiKeyService {
  /** Storage keeps only the keyed hash and the non-secret prefix. */
  issueKey(tenantId: string): Promise<IssuedApiKey>;
  /**
   * Resolve a presented key to its owning tenant, or `null` when unknown or
   * revoked. Authentication is a keyed-hash lookup, so a raw provider key (or
   * any non-gateway string) simply fails to match.
   */
  authenticate(presentedKey: string): Promise<AuthenticationResult>;
  /**
   * Scoped to the owning tenant. `false` when none matched or it was already
   * revoked — the admin route maps that to 404.
   */
  revoke(tenantId: string, keyId: string): Promise<boolean>;
}

export class DefaultApiKeyService implements ApiKeyService {
  constructor(
    private readonly keyHash: KeyHashUtil,
    private readonly apiKeys: ApiKeyRepository,
  ) {}

  async issueKey(tenantId: string): Promise<IssuedApiKey> {
    const generated = this.keyHash.generateGatewayKey();
    const stored = await this.apiKeys.insert({
      tenantId,
      keyHash: generated.hash,
      keyPrefix: generated.prefix,
    });
    return {
      id: stored.id,
      plaintext: generated.plaintext,
      prefix: generated.prefix,
    };
  }

  async authenticate(presentedKey: string): Promise<AuthenticationResult> {
    const found = await this.apiKeys.findByHash(
      this.keyHash.hash(presentedKey),
    );
    // Not authenticated unless a key matched and is still active: a `null`
    // lookup yields `undefined` here, and a revoked key a non-null date.
    if (found?.revokedAt !== null) {
      return { tenantId: null };
    }
    return { tenantId: found.tenantId };
  }

  revoke(tenantId: string, keyId: string): Promise<boolean> {
    return this.apiKeys.revoke({ tenantId, id: keyId });
  }
}
