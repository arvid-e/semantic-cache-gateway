import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '#src/platform/config/load-config.js';
import { runMigrations } from '#src/platform/db/migrate.js';
import { buildApp } from '#src/app.js';
import type { AuthConfig } from './config.js';

// Auth plugin wiring against the real foundation app + dockerized Postgres/Redis
// (task 5.4): proves the app boots with auth registered, the resolver seam is
// exposed and reaches the database, the health endpoints stay unauthenticated,
// and the admin API is guarded. Run with `docker compose up -d postgres redis`
// then `npm run test:integration`.

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

const ADMIN_TOKEN = 'admin-token-integration-1234';

function authConfig(): AuthConfig {
  return {
    encryption: {
      activeKeyVersion: 1,
      keyring: new Map([[1, randomBytes(32)]]),
    },
    gatewayKeyPepper: randomBytes(32),
    adminToken: ADMIN_TOKEN,
  };
}

describe('auth plugin against dockerized Postgres + Redis', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    const config = loadConfig();
    await runMigrations(config, silent);
    app = buildApp(config, authConfig());
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('boots with the auth seams exposed and the resolver reaching the database', async () => {
    expect(app.hasDecorator('credentialResolver')).toBe(true);
    expect(typeof app.authenticate).toBe('function');

    // A live resolve query against the real (empty) store returns a typed miss.
    const resolution = await app.credentialResolver.resolveCredential({
      tenantId: '11111111-1111-1111-1111-111111111111',
      provider: 'openai',
    });
    expect(resolution.kind).toBe('missing');
  });

  it('keeps the foundation health endpoints unauthenticated', async () => {
    const live = await app.inject({ method: 'GET', url: '/health/live' });
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(live.statusCode).toBe(200);
    expect(ready.statusCode).toBe(200);
  });

  it('guards the admin API and provisions a tenant with a valid token', async () => {
    const unauthorized = await app.inject({
      method: 'POST',
      url: '/admin/tenants',
      payload: { name: 'NoAuth' },
    });
    expect(unauthorized.statusCode).toBe(401);

    const created = await app.inject({
      method: 'POST',
      url: '/admin/tenants',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      payload: { name: 'Acme' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<{ id: string; name: string }>().name).toBe('Acme');
  });
});
