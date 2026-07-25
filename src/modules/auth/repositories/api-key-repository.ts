import type { Pool } from 'pg';
import type { GatewayApiKey } from '../types.js';

/** See {@link createApiKeyRepository}; accepts a `Pool` or a `PoolClient`. */
type Queryable = Pick<Pool, 'query'>;

/** A `gateway_api_keys` row as returned by Postgres. */
interface ApiKeyRow {
  id: string;
  tenant_id: string;
  key_hash: Buffer;
  key_prefix: string;
  created_at: Date;
  revoked_at: Date | null;
}

function toApiKey(row: ApiKeyRow): GatewayApiKey {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    keyHash: row.key_hash,
    keyPrefix: row.key_prefix,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

/** Parameters to persist a freshly issued gateway key (never the plaintext). */
export interface InsertApiKeyParams {
  readonly tenantId: string;
  readonly keyHash: Buffer;
  readonly keyPrefix: string;
}

/** Persistence for gateway API keys, stored only as keyed hashes (Req 2.4). */
export interface ApiKeyRepository {
  /** Store a new key's hash and prefix; returns the persisted row. */
  insert(params: InsertApiKeyParams): Promise<GatewayApiKey>;
  /**
   * Look a key up by its (unique) hash — the authentication entry point that
   * resolves a presented key to its owning tenant. Unscoped by design: this is
   * how the tenant is *discovered*. Returns the row including `revokedAt` so the
   * caller can reject a revoked key; `null` when no key matches.
   */
  findByHash(keyHash: Buffer): Promise<GatewayApiKey | null>;
  /**
   * Revoke a key, scoped to its owning tenant so one tenant cannot revoke
   * another's key. Returns `true` if a still-active key was revoked, `false`
   * if none matched or it was already revoked.
   */
  revoke(params: { tenantId: string; id: string }): Promise<boolean>;
}

/** Build an {@link ApiKeyRepository} over the given query executor. */
export function createApiKeyRepository(db: Queryable): ApiKeyRepository {
  return {
    async insert(params: InsertApiKeyParams): Promise<GatewayApiKey> {
      const { rows } = await db.query<ApiKeyRow>(
        `INSERT INTO gateway_api_keys (tenant_id, key_hash, key_prefix)
         VALUES ($1, $2, $3)
         RETURNING id, tenant_id, key_hash, key_prefix, created_at, revoked_at`,
        [params.tenantId, params.keyHash, params.keyPrefix],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new Error('INSERT gateway_api_keys RETURNING produced no row');
      }
      return toApiKey(row);
    },

    async findByHash(keyHash: Buffer): Promise<GatewayApiKey | null> {
      const { rows } = await db.query<ApiKeyRow>(
        `SELECT id, tenant_id, key_hash, key_prefix, created_at, revoked_at
         FROM gateway_api_keys
         WHERE key_hash = $1`,
        [keyHash],
      );
      const row = rows[0];
      return row === undefined ? null : toApiKey(row);
    },

    async revoke(params: { tenantId: string; id: string }): Promise<boolean> {
      const { rowCount } = await db.query(
        `UPDATE gateway_api_keys
         SET revoked_at = now()
         WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL`,
        [params.id, params.tenantId],
      );
      return (rowCount ?? 0) > 0;
    },
  };
}
