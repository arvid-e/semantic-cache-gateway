import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { Mock } from 'vitest';
import { contextPlugin } from '#src/platform/context/context-plugin.js';
import type {
  ApiKeyService,
  AuthenticationResult,
} from '../services/api-key-service.js';
import { createAuthenticateHook } from './authenticate.js';

/** Shape the protected route echoes back so tests can inspect the context. */
interface ProtectedBody {
  ctx: { tenantId: string | null };
}

/**
 * An ApiKeyService whose `authenticate` is a spy with the given behaviour. The
 * spy is returned alongside so tests assert on a bound reference.
 */
function fakeApiKeys(behaviour: (key: string) => AuthenticationResult): {
  service: ApiKeyService;
  authenticate: Mock<(key: string) => Promise<AuthenticationResult>>;
} {
  const authenticate = vi.fn((key: string) => Promise.resolve(behaviour(key)));
  return { service: { issueKey: vi.fn(), authenticate }, authenticate };
}

/**
 * Build a Fastify app with the context plugin and a single protected route
 * guarded by the auth hook. The handler is a spy so a test can assert whether
 * downstream processing ran; it echoes the request context.
 */
async function buildApp(apiKeys: ApiKeyService): Promise<{
  app: FastifyInstance;
  handler: Mock<(request: FastifyRequest) => ProtectedBody>;
}> {
  const app = Fastify();
  await app.register(contextPlugin);

  const handler = vi.fn((request: FastifyRequest) => ({
    ctx: { tenantId: request.ctx.tenantId },
  }));
  app.get(
    '/protected',
    { preHandler: createAuthenticateHook(apiKeys) },
    handler,
  );
  await app.ready();
  return { app, handler };
}

const GOOD_KEY = 'scg_valid-key';

/** Maps only GOOD_KEY to a tenant. */
const resolveTenant = (key: string): AuthenticationResult =>
  key === GOOD_KEY ? { tenantId: 't-1' } : { tenantId: null };

describe('createAuthenticateHook', () => {
  it('authenticates a valid key, sets the tenant, and proceeds downstream', async () => {
    const { service } = fakeApiKeys(resolveTenant);
    const { app, handler } = await buildApp(service);

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${GOOD_KEY}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<ProtectedBody>().ctx.tenantId).toBe('t-1');
    expect(handler).toHaveBeenCalledOnce();
    await app.close();
  });

  it('rejects a missing Authorization header without a lookup or downstream call', async () => {
    const { service, authenticate } = fakeApiKeys(resolveTenant);
    const { app, handler } = await buildApp(service);

    const res = await app.inject({ method: 'GET', url: '/protected' });

    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(authenticate).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects an unknown key before downstream processing', async () => {
    const { service, authenticate } = fakeApiKeys(resolveTenant);
    const { app, handler } = await buildApp(service);

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: 'Bearer scg_wrong-key' },
    });

    expect(res.statusCode).toBe(401);
    expect(authenticate).toHaveBeenCalledWith('scg_wrong-key');
    expect(handler).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects a malformed header (wrong scheme) without a lookup', async () => {
    const { service, authenticate } = fakeApiKeys(resolveTenant);
    const { app, handler } = await buildApp(service);

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Token ${GOOD_KEY}` },
    });

    expect(res.statusCode).toBe(401);
    expect(authenticate).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    await app.close();
  });

  it('never writes the key itself into the request context', async () => {
    const { service } = fakeApiKeys(resolveTenant);
    const { app } = await buildApp(service);

    const res = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${GOOD_KEY}` },
    });

    // Only the tenant id is bound; the raw key appears nowhere in the context.
    expect(res.body).not.toContain(GOOD_KEY);
    expect(res.json<ProtectedBody>().ctx.tenantId).toBe('t-1');
    await app.close();
  });
});
