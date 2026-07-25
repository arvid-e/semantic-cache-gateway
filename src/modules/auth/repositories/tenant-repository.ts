import type { Pool } from 'pg';
import type { Tenant } from '../types.js';

/**
 * Minimal query surface a repository needs: satisfied by both `app.pg` (the
 * shared `Pool`) and a `PoolClient` inside a transaction, so callers can pass
 * whichever they hold.
 */
type Queryable = Pick<Pool, 'query'>;

/** A `tenants` row as returned by Postgres (snake_case, native types). */
interface TenantRow {
  id: string;
  name: string;
  status: string;
  created_at: Date;
}

function toTenant(row: TenantRow): Tenant {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    createdAt: row.created_at,
  };
}

/** Persistence for tenants — the isolation root every other row hangs off. */
export interface TenantRepository {
  /** Create a tenant, letting Postgres mint its `gen_random_uuid()` id. */
  insert(name: string): Promise<Tenant>;
  /** Fetch a tenant by id, or `null` if none exists. */
  findById(id: string): Promise<Tenant | null>;
}

/** Build a {@link TenantRepository} over the given query executor. */
export function createTenantRepository(db: Queryable): TenantRepository {
  return {
    async insert(name: string): Promise<Tenant> {
      const { rows } = await db.query<TenantRow>(
        `INSERT INTO tenants (name)
         VALUES ($1)
         RETURNING id, name, status, created_at`,
        [name],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new Error('INSERT tenants RETURNING produced no row');
      }
      return toTenant(row);
    },

    async findById(id: string): Promise<Tenant | null> {
      const { rows } = await db.query<TenantRow>(
        `SELECT id, name, status, created_at
         FROM tenants
         WHERE id = $1`,
        [id],
      );
      const row = rows[0];
      return row === undefined ? null : toTenant(row);
    },
  };
}
