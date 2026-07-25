import type { TenantRepository } from '../repositories/tenant-repository.js';
import type { Tenant } from '../types.js';

/**
 * Tenant provisioning (Req 1.1).
 *
 * A tenant is the isolation root every gateway key and provider credential
 * hangs off, so the only creation invariant that matters here is a stable,
 * unique identifier — which Postgres supplies via `gen_random_uuid()` on
 * insert. The service is deliberately thin: it exists as the boundary the admin
 * routes call, keeping route handlers free of direct repository access.
 */
export interface TenantService {
  /** Create a tenant and return it, including its freshly minted unique id. */
  createTenant(name: string): Promise<Tenant>;
  /**
   * Fetch a tenant by id, or `null` if none exists. Used by the admin routes to
   * answer 404 before provisioning a key or credential against a missing tenant.
   */
  getTenant(id: string): Promise<Tenant | null>;
}

/** {@link TenantService} over the tenant repository. */
export class DefaultTenantService implements TenantService {
  constructor(private readonly tenants: TenantRepository) {}

  createTenant(name: string): Promise<Tenant> {
    return this.tenants.insert(name);
  }

  getTenant(id: string): Promise<Tenant | null> {
    return this.tenants.findById(id);
  }
}
