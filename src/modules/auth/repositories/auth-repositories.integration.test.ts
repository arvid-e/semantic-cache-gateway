import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { loadConfig } from '#src/platform/config/load-config.js';
import { runMigrations } from '#src/platform/db/migrate.js';
import {
  DefaultTenantRepository,
  type TenantRepository,
} from './tenant-repository.js';
import {
  DefaultApiKeyRepository,
  type ApiKeyRepository,
} from './api-key-repository.js';
import {
  DefaultCredentialRepository,
  type CredentialRepository,
} from './credential-repository.js';

// Repository behaviour against dockerized Postgres (task 3.1): proves tenant
// scoping, hash lookup, and `(tenant, provider)` uniqueness on the real schema.
// Run with `docker compose up -d postgres` then `npm run test:integration`.

// Migrations log verbosely; keep the suite output to the test results.
const silent = {
  info: () => {
    /* suppress migration progress */
  },
  warn: () => {
    /* suppress migration progress */
  },
  error: () => {
    /* suppress migration progress */
  },
};

let pool: Pool;
let tenants: TenantRepository;
let apiKeys: ApiKeyRepository;
let credentials: CredentialRepository;

beforeAll(async () => {
  const config = loadConfig();
  await runMigrations(config, silent);
  pool = new Pool({ connectionString: config.postgres.url });
  tenants = new DefaultTenantRepository(pool);
  apiKeys = new DefaultApiKeyRepository(pool);
  credentials = new DefaultCredentialRepository(pool);
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  // Cascades into gateway_api_keys and provider_credentials.
  await pool.query('TRUNCATE tenants CASCADE');
});

describe('TenantRepository', () => {
  it('persists a tenant with a unique id and finds it by id', async () => {
    const a = await tenants.insert('Acme');
    const b = await tenants.insert('Acme'); // same name, distinct row

    expect(a.id).not.toBe(b.id);
    expect(a.name).toBe('Acme');
    expect(a.status).toBe('active');
    expect(await tenants.findById(a.id)).toEqual(a);
    expect(await tenants.findById(randomBytes(16).toString('hex'))).toBeNull();
  });
});

describe('ApiKeyRepository', () => {
  it('looks a key up by hash and returns its owning tenant', async () => {
    const tenant = await tenants.insert('KeyOwner');
    const keyHash = randomBytes(32);
    await apiKeys.insert({
      tenantId: tenant.id,
      keyHash,
      keyPrefix: 'scg_abcd',
    });

    const found = await apiKeys.findByHash(keyHash);
    expect(found?.tenantId).toBe(tenant.id);
    expect(found?.keyPrefix).toBe('scg_abcd');
    expect(found?.revokedAt).toBeNull();
  });

  it('returns null for an unknown hash', async () => {
    expect(await apiKeys.findByHash(randomBytes(32))).toBeNull();
  });

  it('revokes only within the owning tenant and only once', async () => {
    const owner = await tenants.insert('Owner');
    const other = await tenants.insert('Other');
    const keyHash = randomBytes(32);
    const key = await apiKeys.insert({
      tenantId: owner.id,
      keyHash,
      keyPrefix: 'scg_xxxx',
    });

    // Another tenant cannot revoke this key.
    expect(await apiKeys.revoke({ tenantId: other.id, id: key.id })).toBe(
      false,
    );
    expect((await apiKeys.findByHash(keyHash))?.revokedAt).toBeNull();

    // The owner can, but only while it is still active.
    expect(await apiKeys.revoke({ tenantId: owner.id, id: key.id })).toBe(true);
    expect((await apiKeys.findByHash(keyHash))?.revokedAt).not.toBeNull();
    expect(await apiKeys.revoke({ tenantId: owner.id, id: key.id })).toBe(
      false,
    );
  });
});

describe('CredentialRepository', () => {
  it('upsert replaces in place, respecting (tenant, provider) uniqueness', async () => {
    const tenant = await tenants.insert('CredTenant');

    await credentials.upsert({
      tenantId: tenant.id,
      provider: 'openai',
      ciphertext: randomBytes(40),
      keyVersion: 1,
    });
    const rotated = randomBytes(48);
    await credentials.upsert({
      tenantId: tenant.id,
      provider: 'openai',
      ciphertext: rotated,
      keyVersion: 2,
    });

    const found = await credentials.find({
      tenantId: tenant.id,
      provider: 'openai',
    });
    expect(found?.ciphertext).toEqual(rotated); // latest wins
    expect(found?.keyVersion).toBe(2);

    // Exactly one row exists for the pair — the upsert did not duplicate.
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM provider_credentials
       WHERE tenant_id = $1 AND provider = $2`,
      [tenant.id, 'openai'],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('lets one tenant hold credentials for multiple providers', async () => {
    const tenant = await tenants.insert('MultiProvider');
    await credentials.upsert({
      tenantId: tenant.id,
      provider: 'openai',
      ciphertext: randomBytes(32),
      keyVersion: 1,
    });
    await credentials.upsert({
      tenantId: tenant.id,
      provider: 'anthropic',
      ciphertext: randomBytes(32),
      keyVersion: 1,
    });

    expect(
      await credentials.find({ tenantId: tenant.id, provider: 'openai' }),
    ).not.toBeNull();
    expect(
      await credentials.find({ tenantId: tenant.id, provider: 'anthropic' }),
    ).not.toBeNull();
  });

  it('never returns another tenant’s credential (tenant scoping)', async () => {
    const a = await tenants.insert('TenantA');
    const b = await tenants.insert('TenantB');
    const secretA = randomBytes(40);
    const secretB = randomBytes(40);
    await credentials.upsert({
      tenantId: a.id,
      provider: 'openai',
      ciphertext: secretA,
      keyVersion: 1,
    });
    await credentials.upsert({
      tenantId: b.id,
      provider: 'openai',
      ciphertext: secretB,
      keyVersion: 1,
    });

    const forA = await credentials.find({ tenantId: a.id, provider: 'openai' });
    const forB = await credentials.find({ tenantId: b.id, provider: 'openai' });
    expect(forA?.ciphertext).toEqual(secretA);
    expect(forB?.ciphertext).toEqual(secretB);

    // A tenant with no anthropic credential resolves to null, not another's.
    expect(
      await credentials.find({ tenantId: a.id, provider: 'anthropic' }),
    ).toBeNull();
  });

  it('deletes only within the owning tenant', async () => {
    const a = await tenants.insert('DelA');
    const b = await tenants.insert('DelB');
    await credentials.upsert({
      tenantId: a.id,
      provider: 'openai',
      ciphertext: randomBytes(32),
      keyVersion: 1,
    });

    // No row for B → nothing deleted.
    expect(
      await credentials.delete({ tenantId: b.id, provider: 'openai' }),
    ).toBe(false);
    // A's row survives B's delete attempt.
    expect(
      await credentials.find({ tenantId: a.id, provider: 'openai' }),
    ).not.toBeNull();

    expect(
      await credentials.delete({ tenantId: a.id, provider: 'openai' }),
    ).toBe(true);
    expect(
      await credentials.find({ tenantId: a.id, provider: 'openai' }),
    ).toBeNull();
  });
});
