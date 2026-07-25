import Fastify, { type FastifyInstance } from 'fastify';
import { createAdminGuard } from './admin-guard.js';

const ADMIN_TOKEN = 'admin-secret-token-1234';

/** App with one route guarded by the admin token. */
async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.get('/admin/ping', { onRequest: createAdminGuard(ADMIN_TOKEN) }, () => ({
    ok: true,
  }));
  await app.ready();
  return app;
}

describe('createAdminGuard', () => {
  it('allows a request bearing the correct admin token', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/admin/ping',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('rejects a missing token with 401', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/admin/ping' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    await app.close();
  });

  it('rejects a wrong token of the same length with 401', async () => {
    const app = await buildApp();
    const wrong = 'x'.repeat(ADMIN_TOKEN.length);
    const res = await app.inject({
      method: 'GET',
      url: '/admin/ping',
      headers: { authorization: `Bearer ${wrong}` },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejects a malformed authorization scheme with 401', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/admin/ping',
      headers: { authorization: `Token ${ADMIN_TOKEN}` },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
