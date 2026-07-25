import type { Pool } from 'pg';
import type { ProviderCredential, ProviderName } from '../types.js';

/** See {@link createCredentialRepository}; accepts a `Pool` or a `PoolClient`. */
type Queryable = Pick<Pool, 'query'>;

/** A `provider_credentials` row as returned by Postgres. */
interface CredentialRow {
  id: string;
  tenant_id: string;
  provider: string;
  ciphertext: Buffer;
  key_version: number;
  created_at: Date;
  updated_at: Date;
}

function toCredential(row: CredentialRow): ProviderCredential {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    // The `provider` CHECK constraint guarantees this is a ProviderName.
    provider: row.provider as ProviderName,
    ciphertext: row.ciphertext,
    keyVersion: row.key_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The encrypted material to store for one `(tenant, provider)` pairing. */
export interface UpsertCredentialParams {
  readonly tenantId: string;
  readonly provider: ProviderName;
  readonly ciphertext: Buffer;
  readonly keyVersion: number;
}

/** A `(tenant, provider)` address; every credential query is scoped this way. */
export interface CredentialKey {
  readonly tenantId: string;
  readonly provider: ProviderName;
}

/** Persistence for per-tenant, per-provider encrypted credentials (Req 3.x). */
export interface CredentialRepository {
  /**
   * Insert or replace the credential for a `(tenant, provider)` pair. The
   * `(tenant_id, provider)` unique constraint makes this an upsert: attaching
   * again rotates in place, and a tenant can still hold other providers.
   */
  upsert(params: UpsertCredentialParams): Promise<void>;
  /** Fetch a tenant's credential for one provider, scoped by tenant. */
  find(key: CredentialKey): Promise<ProviderCredential | null>;
  /** Delete a tenant's credential for one provider; `true` if a row was removed. */
  delete(key: CredentialKey): Promise<boolean>;
}

/** Build a {@link CredentialRepository} over the given query executor. */
export function createCredentialRepository(
  db: Queryable,
): CredentialRepository {
  return {
    async upsert(params: UpsertCredentialParams): Promise<void> {
      await db.query(
        `INSERT INTO provider_credentials
           (tenant_id, provider, ciphertext, key_version)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, provider) DO UPDATE
           SET ciphertext = EXCLUDED.ciphertext,
               key_version = EXCLUDED.key_version,
               updated_at = now()`,
        [
          params.tenantId,
          params.provider,
          params.ciphertext,
          params.keyVersion,
        ],
      );
    },

    async find(key: CredentialKey): Promise<ProviderCredential | null> {
      const { rows } = await db.query<CredentialRow>(
        `SELECT id, tenant_id, provider, ciphertext, key_version,
                created_at, updated_at
         FROM provider_credentials
         WHERE tenant_id = $1 AND provider = $2`,
        [key.tenantId, key.provider],
      );
      const row = rows[0];
      return row === undefined ? null : toCredential(row);
    },

    async delete(key: CredentialKey): Promise<boolean> {
      const { rowCount } = await db.query(
        `DELETE FROM provider_credentials
         WHERE tenant_id = $1 AND provider = $2`,
        [key.tenantId, key.provider],
      );
      return (rowCount ?? 0) > 0;
    },
  };
}
