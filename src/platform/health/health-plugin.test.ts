import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { healthPlugin } from './health-plugin.js';

// The datastore clients are stubbed so the endpoints' branching can be
// exercised without a live Postgres or Redis; real wiring is covered by
// readiness.integration.test.ts (task 6.1).
interface Stubs {
  pgQuery: ReturnType<typeof vi.fn>;
  redisPing: ReturnType<typeof vi.fn>;
}

async function buildApp(stubs: Stubs): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorate('pg', { query: stubs.pgQuery } as never);
  app.decorate('redis', { ping: stubs.redisPing } as never);
  await app.register(healthPlugin);
  await app.ready();
  return app;
}

function healthyStubs(): Stubs {
  return {
    pgQuery: vi.fn().mockResolvedValue({ rowCount: 1 }),
    redisPing: vi.fn().mockResolvedValue('PONG'),
  };
}

describe('healthPlugin', () => {
  describe('GET /health/live', () => {
    it('returns success without touching the datastores', async () => {
      const stubs = healthyStubs();
      const app = await buildApp(stubs);

      const res = await app.inject({ method: 'GET', url: '/health/live' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok' });
      expect(stubs.pgQuery).not.toHaveBeenCalled();
      expect(stubs.redisPing).not.toHaveBeenCalled();

      await app.close();
    });

    it('stays green while a datastore is down', async () => {
      const stubs = healthyStubs();
      stubs.pgQuery.mockRejectedValue(new Error('connect ECONNREFUSED'));
      stubs.redisPing.mockRejectedValue(new Error('connect ECONNREFUSED'));
      const app = await buildApp(stubs);

      const res = await app.inject({ method: 'GET', url: '/health/live' });

      expect(res.statusCode).toBe(200);

      await app.close();
    });
  });

  describe('GET /health/ready', () => {
    it('returns success when both datastores are reachable', async () => {
      const stubs = healthyStubs();
      const app = await buildApp(stubs);

      const res = await app.inject({ method: 'GET', url: '/health/ready' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        status: 'ok',
        checks: { postgres: 'ok', redis: 'ok' },
      });

      await app.close();
    });

    it('fails and names Postgres when it is unreachable', async () => {
      const stubs = healthyStubs();
      stubs.pgQuery.mockRejectedValue(new Error('connect ECONNREFUSED'));
      const app = await buildApp(stubs);

      const res = await app.inject({ method: 'GET', url: '/health/ready' });

      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({
        status: 'unavailable',
        checks: { postgres: 'unavailable', redis: 'ok' },
      });

      await app.close();
    });

    it('fails and names Redis when it is unreachable', async () => {
      const stubs = healthyStubs();
      stubs.redisPing.mockRejectedValue(new Error('connect ECONNREFUSED'));
      const app = await buildApp(stubs);

      const res = await app.inject({ method: 'GET', url: '/health/ready' });

      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({
        status: 'unavailable',
        checks: { postgres: 'ok', redis: 'unavailable' },
      });

      await app.close();
    });

    it('reports both dependencies down without one masking the other', async () => {
      const stubs = healthyStubs();
      stubs.pgQuery.mockRejectedValue(new Error('pg down'));
      stubs.redisPing.mockRejectedValue(new Error('redis down'));
      const app = await buildApp(stubs);

      const res = await app.inject({ method: 'GET', url: '/health/ready' });

      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({
        status: 'unavailable',
        checks: { postgres: 'unavailable', redis: 'unavailable' },
      });

      await app.close();
    });

    it('keeps connection secrets out of the failure response', async () => {
      const stubs = healthyStubs();
      // A worst case: the driver error echoes a URL carrying a password.
      stubs.redisPing.mockRejectedValue(
        new Error('connect to redis://default:hunter2@localhost:6379 failed'),
      );
      const app = await buildApp(stubs);

      const res = await app.inject({ method: 'GET', url: '/health/ready' });

      expect(res.body).not.toContain('hunter2');
      expect(res.body).toContain('redis'); // still names the dependency

      await app.close();
    });

    it('requires no authentication', async () => {
      const stubs = healthyStubs();
      const app = await buildApp(stubs);

      const res = await app.inject({ method: 'GET', url: '/health/ready' });

      expect(res.statusCode).not.toBe(401);
      expect(res.statusCode).not.toBe(403);

      await app.close();
    });
  });
});
