import type { KeyHashUtil } from '../crypto/key-hash.js';
import type { ApiKeyRepository } from '../repositories/api-key-repository.js';

/** The one-time result of issuing a gateway key. */
export interface IssuedApiKey {
  /** The persisted key row's id (for later revocation). */
  readonly id: string;
  /** The full key, returned to the caller exactly once (Req 2.2, 6.4). */
  readonly plaintext: string;
  /** The non-secret prefix stored for display. */
  readonly prefix: string;
}

/** Outcome of authenticating a presented key: a tenant, or nobody. */
export type AuthenticationResult =
  { readonly tenantId: string } | { readonly tenantId: null };

/** Issue and authenticate gateway API keys (Req 2.1, 2.3, 2.4, 5.2, 6.4). */
export interface ApiKeyService {
  /**
   * Mint a gateway key for a tenant. The plaintext is returned here and only
   * here; storage keeps just the keyed hash and the non-secret prefix (Req 2.4).
   */
  issueKey(tenantId: string): Promise<IssuedApiKey>;
  /**
   * Resolve a presented key to its owning tenant, or to `null` when the key is
   * unknown or revoked. Authentication is a keyed-hash lookup, so a raw provider
   * key (or any non-gateway string) simply fails to match — gateway keys are
   * never treated as provider keys (Req 2.5).
   */
  authenticate(presentedKey: string): Promise<AuthenticationResult>;
  /**
   * Revoke a tenant's key by id. Scoped to the owning tenant; returns `true`
   * when an active key was revoked, `false` if none matched or it was already
   * revoked (the admin route maps `false` to 404).
   */
  revoke(tenantId: string, keyId: string): Promise<boolean>;
}

/** {@link ApiKeyService} over the key-hash util and the key repository. */
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
