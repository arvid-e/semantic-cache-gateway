import type { TenantRepository } from '../repositories/tenant-repository.js';
import type { Tenant } from '../types.js';

/**
 * Deliberately thin: it exists as the boundary the admin routes call, keeping
 * route handlers free of direct repository access. The only creation invariant
 * that matters is a stable unique id, which Postgres supplies via
 * `gen_random_uuid()` on insert.
 */
export interface TenantService {
  createTenant(name: string): Promise<Tenant>;
  /** `null` if none exists — the admin routes answer 404 before provisioning
   * a key or credential against a missing tenant. */
  getTenant(id: string): Promise<Tenant | null>;
}

export class DefaultTenantService implements TenantService {
  constructor(private readonly tenants: TenantRepository) {}

  createTenant(name: string): Promise<Tenant> {
    return this.tenants.insert(name);
  }

  getTenant(id: string): Promise<Tenant | null> {
    return this.tenants.findById(id);
  }
}
