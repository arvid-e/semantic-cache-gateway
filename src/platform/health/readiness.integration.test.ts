import Fastify from 'fastify';
import { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '#src/platform/config/load-config.js';
import type { Config } from '#src/platform/config/schema.js';
import { runMigrations } from '#src/platform/db/migrate.js';
import { buildApp } from '#src/app.js';
import { healthPlugin } from '#src/platform/health/health-plugin.js';

// Foundation integration proof (task 6.1): boots the real application against
// dockerized Postgres + Redis and exercises the health endpoints end-to-end.
// Connection settings come from the environment (task 1.2), so an operator runs
// `docker compose up` and then `npm run test:integration`. Unlike the stubbed
// branch coverage in health-plugin.test.ts, everything here is real wiring: a
// live migration run, the pg/redis client plugins, and a genuinely unreachable
// dependency for the failure path.

// Migrations log verbosely; this keeps the suite output to the test results.
const silentLogger = {
  info: () => {
    /* suppress migration progress in tests */
  },
  warn: () => {
    /* suppress migration progress in tests */
  },
  error: () => {
    /* suppress migration progress in tests */
  },
};

describe('foundation health against dockerized Postgres + Redis', () => {
  let config: Config;
  let app: FastifyInstance;

  beforeAll(async () => {
    config = loadConfig();

    // Bring the schema current against the real database first. This proves the
    // migration runner works end-to-end and enables `pgvector`, and it
    // satisfies the pg plugin's boot-time `vector`-extension assertion below.
    // Idempotent: a no-op if the Compose gateway already migrated.
    await runMigrations(config, silentLogger);

    app = buildApp(config);
    // Datastore plugins connect here; an unreachable dependency would reject,
    // so reaching `ready()` already proves both datastores are wired.
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 200 from readiness when both datastores are reachable', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ok',
      checks: { postgres: 'ok', redis: 'ok' },
    });
  });

  it('returns 200 from liveness independent of datastore state', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/live' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('has the vector extension present after migrations', async () => {
    const { rowCount } = await app.pg.query(
      "SELECT 1 FROM pg_extension WHERE extname = 'vector'",
    );

    expect(rowCount).toBe(1);
  });

  describe('when a datastore is unreachable', () => {
    let brokenApp: FastifyInstance;
    let deadRedis: Redis;

    beforeAll(async () => {
      // A real ioredis pointed at a closed port. `lazyConnect` defers the
      // connection to the first command; with the offline queue disabled and no
      // retries, `ping()` rejects immediately instead of buffering — so
      // readiness observes a genuinely unreachable dependency. Booting the full
      // app this way is impossible by design: the redis plugin's startup ping
      // would reject and abort the boot, so the health plugin is wired
      // directly to the real (up) Postgres pool and this dead client.
      deadRedis = new Redis({
        host: '127.0.0.1',
        port: 1,
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 0,
        retryStrategy: () => null,
      });
      // ioredis surfaces connection failures as `error` events; without a
      // listener Node treats them as unhandled and crashes the process.
      deadRedis.on('error', () => {
        /* expected: the port is closed */
      });

      brokenApp = Fastify({ logger: false });
      brokenApp.decorate('pg', app.pg);
      brokenApp.decorate('redis', deadRedis);
      await brokenApp.register(healthPlugin);
      await brokenApp.ready();
    });

    afterAll(async () => {
      // brokenApp registers only the health plugin, so closing it does not touch
      // the shared `app.pg` pool (owned and closed by the healthy app above).
      await brokenApp.close();
      deadRedis.disconnect();
    });

    it('returns 503 from readiness naming the down dependency, without secrets', async () => {
      const res = await brokenApp.inject({
        method: 'GET',
        url: '/health/ready',
      });

      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({
        status: 'unavailable',
        checks: { postgres: 'ok', redis: 'unavailable' },
      });
      // The body carries only dependency names and coarse statuses — never a
      // connection string or the credentials inside it.
      expect(res.body).not.toContain(config.redis.url);
      expect(res.body).not.toContain(config.postgres.url);
    });

    it('keeps liveness at 200 while a datastore is down', async () => {
      const res = await brokenApp.inject({
        method: 'GET',
        url: '/health/live',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok' });
    });
  });
});
