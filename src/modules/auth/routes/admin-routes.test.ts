import Fastify, { type FastifyInstance } from 'fastify';
import type { ApiKeyService } from '../services/api-key-service.js';
import type { CredentialService } from '../services/credential-service.js';
import type { TenantService } from '../services/tenant-service.js';
import type { Tenant } from '../types.js';
import { createAdminRoutes } from './admin-routes.js';

const ADMIN_TOKEN = 'admin-secret-token-1234';
const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const KEY_ID = '22222222-2222-2222-2222-222222222222';
const KEY_PLAINTEXT = 'scg_issued-plaintext-key';

function tenant(id: string, name = 'Acme'): Tenant {
  return { id, name, status: 'active', createdAt: new Date() };
}

/**
 * Fake services with the spies exposed as standalone references, so tests can
 * assert on them (and prove "no change" on rejection) without tripping the
 * unbound-method lint rule.
 */
function fakeDeps() {
  const createTenant = vi.fn((name: string) =>
    Promise.resolve(tenant(TENANT_ID, name)),
  );
  const getTenant = vi.fn((id: string) =>
    Promise.resolve(id === TENANT_ID ? tenant(id) : null),
  );
  const issueKey = vi.fn((tenantId: string) =>
    Promise.resolve({
      id: KEY_ID,
      plaintext: KEY_PLAINTEXT,
      prefix: 'scg_issu',
      tenantId,
    }),
  );
  const revoke = vi.fn((_tenantId: string, keyId: string) =>
    Promise.resolve(keyId === KEY_ID),
  );
  const attachOrRotate = vi.fn(() => Promise.resolve());
  const remove = vi.fn(() => Promise.resolve());

  const tenantService: TenantService = { createTenant, getTenant };
  const apiKeyService: ApiKeyService = {
    issueKey,
    authenticate: vi.fn(),
    revoke,
  };
  const credentialService: CredentialService = {
    attachOrRotate,
    remove,
    getDecrypted: vi.fn(),
  };
  return {
    tenantService,
    apiKeyService,
    credentialService,
    createTenant,
    getTenant,
    issueKey,
    revoke,
    attachOrRotate,
    remove,
  };
}

async function buildApp(
  deps = fakeDeps(),
): Promise<{ app: FastifyInstance } & ReturnType<typeof fakeDeps>> {
  const app = Fastify();
  await app.register(
    createAdminRoutes({
      tenantService: deps.tenantService,
      apiKeyService: deps.apiKeyService,
      credentialService: deps.credentialService,
      adminToken: ADMIN_TOKEN,
    }),
  );
  await app.ready();
  return { app, ...deps };
}

const auth = { authorization: `Bearer ${ADMIN_TOKEN}` };

describe('admin routes', () => {
  it('rejects an unauthorized tenant creation and makes no change', async () => {
    const { app, createTenant } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/admin/tenants',
      payload: { name: 'Acme' },
    });
    expect(res.statusCode).toBe(401);
    expect(createTenant).not.toHaveBeenCalled();
    await app.close();
  });

  it('creates a tenant for an authorized admin', async () => {
    const { app, createTenant } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/admin/tenants',
      headers: auth,
      payload: { name: 'Acme' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ id: string; name: string }>()).toEqual({
      id: TENANT_ID,
      name: 'Acme',
    });
    expect(createTenant).toHaveBeenCalledWith('Acme');
    await app.close();
  });

  it('rejects tenant creation with a missing name (400)', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/admin/tenants',
      headers: auth,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('issues a key exposing the plaintext exactly once', async () => {
    const { app, issueKey } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/admin/tenants/${TENANT_ID}/keys`,
      headers: auth,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; key: string; prefix: string }>();
    expect(body).toEqual({
      id: KEY_ID,
      key: KEY_PLAINTEXT,
      prefix: 'scg_issu',
    });
    // The plaintext appears in the issue response — and nowhere is a hash or
    // other stored secret leaked.
    expect(res.body).not.toContain('keyHash');
    expect(issueKey).toHaveBeenCalledWith(TENANT_ID);
    await app.close();
  });

  it('returns 404 when issuing a key for an unknown tenant', async () => {
    const { app, issueKey } = await buildApp();
    const unknown = '99999999-9999-9999-9999-999999999999';
    const res = await app.inject({
      method: 'POST',
      url: `/admin/tenants/${unknown}/keys`,
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    expect(issueKey).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects a malformed tenant id with 400', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/admin/tenants/not-a-uuid/keys',
      headers: auth,
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('revokes a key (204) and 404s an unknown key', async () => {
    const { app, revoke } = await buildApp();

    const ok = await app.inject({
      method: 'DELETE',
      url: `/admin/tenants/${TENANT_ID}/keys/${KEY_ID}`,
      headers: auth,
    });
    expect(ok.statusCode).toBe(204);
    expect(revoke).toHaveBeenCalledWith(TENANT_ID, KEY_ID);

    const missing = await app.inject({
      method: 'DELETE',
      url: `/admin/tenants/${TENANT_ID}/keys/33333333-3333-3333-3333-333333333333`,
      headers: auth,
    });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it('rejects an unauthorized revoke without touching the service', async () => {
    const { app, revoke } = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: `/admin/tenants/${TENANT_ID}/keys/${KEY_ID}`,
    });
    expect(res.statusCode).toBe(401);
    expect(revoke).not.toHaveBeenCalled();
    await app.close();
  });

  const PROVIDER_KEY = 'sk-provider-plaintext-secret';

  it('attaches a provider credential and returns no secret material', async () => {
    const { app, attachOrRotate } = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/admin/tenants/${TENANT_ID}/credentials/openai`,
      headers: auth,
      payload: { apiKey: PROVIDER_KEY },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ provider: string; updatedAt: string }>();
    expect(body.provider).toBe('openai');
    expect(typeof body.updatedAt).toBe('string');
    // The stored secret is never echoed back (Req 5.5).
    expect(res.body).not.toContain(PROVIDER_KEY);
    expect(attachOrRotate).toHaveBeenCalledWith(
      TENANT_ID,
      'openai',
      PROVIDER_KEY,
    );
    await app.close();
  });

  it('rejects an unauthorized credential attach without a change', async () => {
    const { app, attachOrRotate } = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/admin/tenants/${TENANT_ID}/credentials/openai`,
      payload: { apiKey: PROVIDER_KEY },
    });
    expect(res.statusCode).toBe(401);
    expect(attachOrRotate).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 404 attaching a credential for an unknown tenant', async () => {
    const { app, attachOrRotate } = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/admin/tenants/99999999-9999-9999-9999-999999999999/credentials/openai`,
      headers: auth,
      payload: { apiKey: PROVIDER_KEY },
    });
    expect(res.statusCode).toBe(404);
    expect(attachOrRotate).not.toHaveBeenCalled();
    await app.close();
  });

  it('returns 422 for an unknown provider', async () => {
    const { app, attachOrRotate } = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/admin/tenants/${TENANT_ID}/credentials/cohere`,
      headers: auth,
      payload: { apiKey: PROVIDER_KEY },
    });
    expect(res.statusCode).toBe(422);
    expect(attachOrRotate).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects a credential attach with a missing apiKey (400)', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: `/admin/tenants/${TENANT_ID}/credentials/openai`,
      headers: auth,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('removes a provider credential (204)', async () => {
    const { app, remove } = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: `/admin/tenants/${TENANT_ID}/credentials/anthropic`,
      headers: auth,
    });
    expect(res.statusCode).toBe(204);
    expect(remove).toHaveBeenCalledWith(TENANT_ID, 'anthropic');
    await app.close();
  });

  it('returns 404 removing a credential for an unknown tenant', async () => {
    const { app, remove } = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: `/admin/tenants/99999999-9999-9999-9999-999999999999/credentials/openai`,
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
    expect(remove).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects an unauthorized credential removal without a change', async () => {
    const { app, remove } = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: `/admin/tenants/${TENANT_ID}/credentials/openai`,
    });
    expect(res.statusCode).toBe(401);
    expect(remove).not.toHaveBeenCalled();
    await app.close();
  });
});
