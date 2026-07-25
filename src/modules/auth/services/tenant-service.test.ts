import { randomUUID } from 'node:crypto';
import type { TenantRepository } from '../repositories/tenant-repository.js';
import type { Tenant } from '../types.js';
import { createTenantService } from './tenant-service.js';

/** In-memory tenant repository that assigns a fresh unique id per insert. */
function fakeTenantRepository(): TenantRepository {
  const rows = new Map<string, Tenant>();
  return {
    insert(name: string): Promise<Tenant> {
      const tenant: Tenant = {
        id: randomUUID(),
        name,
        status: 'active',
        createdAt: new Date(),
      };
      rows.set(tenant.id, tenant);
      return Promise.resolve(tenant);
    },
    findById(id: string): Promise<Tenant | null> {
      return Promise.resolve(rows.get(id) ?? null);
    },
  };
}

describe('createTenantService', () => {
  it('creates a tenant and returns it with a unique id', async () => {
    const service = createTenantService(fakeTenantRepository());

    const tenant = await service.createTenant('Acme');
    expect(tenant.name).toBe('Acme');
    expect(tenant.id).toBeTruthy();
  });

  it('gives each created tenant a distinct id', async () => {
    const service = createTenantService(fakeTenantRepository());

    const a = await service.createTenant('Acme');
    const b = await service.createTenant('Acme');
    expect(a.id).not.toBe(b.id);
  });
});
