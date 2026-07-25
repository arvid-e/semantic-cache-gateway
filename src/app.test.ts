import type { FastifyInstance } from 'fastify';
import type { Config } from '#src/platform/config/schema.js';

// The datastore plugins really connect during `app.ready()`, so they are
// replaced with in-scope stubs that decorate fake `pg` / `redis` clients. This
// keeps the test about *assembly* — that buildApp composes the foundation
// plugins and leaves the seam open — while real connection wiring is proven by
// readiness.integration.test.ts (task 6.1). Both stubs are `fastify-plugin`
// wrapped so their decorations hoist to the root, exactly as the real plugins
// do, and are therefore visible to the health plugin registered alongside them.
vi.mock('#src/platform/db/pg-plugin.js', async () => {
  const fp = (await import('fastify-plugin')).default;
  return {
    pgPlugin: fp(
      (app: FastifyInstance, _opts: unknown, done: () => void) => {
        app.decorate('pg', {
          query: vi.fn().mockResolvedValue({ rowCount: 1 }),
        } as never);
        done();
      },
      { name: 'platform-postgres' },
    ),
  };
});

vi.mock('#src/platform/redis/redis-plugin.js', async () => {
  const fp = (await import('fastify-plugin')).default;
  return {
    redisPlugin: fp(
      (app: FastifyInstance, _opts: unknown, done: () => void) => {
        app.decorate('redis', {
          ping: vi.fn().mockResolvedValue('PONG'),
        } as never);
        done();
      },
      { name: 'platform-redis' },
    ),
  };
});

const { buildApp } = await import('#src/app.js');

/** A complete, valid config; the URLs are never dialed thanks to the stubs. */
function testConfig(): Config {
  return {
    httpPort: 3000,
    logLevel: 'warn',
    postgres: { url: 'postgres://user:secret@localhost:5432/db', poolMax: 10 },
    redis: { url: 'redis://localhost:6379' },
    ollama: { url: 'http://localhost:11434' },
    nodeEnv: 'test',
  };
}

describe('buildApp', () => {
  it('exposes the passed config on the shared instance', async () => {
    const config = testConfig();
    const app = buildApp(config);
    await app.ready();

    expect(app.config).toBe(config);

    await app.close();
  });

  it('configures the logger from config rather than a hardcoded level', async () => {
    const app = buildApp(testConfig());
    await app.ready();

    expect(app.log.level).toBe('warn');

    await app.close();
  });

  it('logs each request lifecycle with method, url, status, and latency', async () => {
    // Req 3.4: the assembled app emits a structured start/completion line per
    // request. Capture the child-logger calls Fastify makes and assert the
    // correlating metadata is present, rather than trusting the framework
    // default silently.
    const app = buildApp(testConfig());

    const lines: { msg: string; payload: Record<string, unknown> }[] = [];
    app.addHook('onRequest', (request, _reply, done) => {
      // `reply.log` and `request.log` are the same child logger, so spying on
      // `.info` here also captures the `onResponse` "request completed" line.
      const original = request.log.info.bind(request.log);
      vi.spyOn(request.log, 'info').mockImplementation(
        (payload: unknown, msg?: unknown): void => {
          lines.push({
            msg: typeof msg === 'string' ? msg : '',
            payload: (payload ?? {}) as Record<string, unknown>,
          });
          original(payload as never, msg as never);
        },
      );
      done();
    });
    await app.ready();

    await app.inject({ method: 'GET', url: '/health/live' });

    const completion = lines.find((l) => l.msg === 'request completed');
    expect(completion).toBeDefined();
    expect(completion?.payload).toHaveProperty('res');
    expect(completion?.payload).toHaveProperty('responseTime');

    await app.close();
  });

  it('registers the health plugin so both probes are served', async () => {
    const app = buildApp(testConfig());
    await app.ready();

    const live = await app.inject({ method: 'GET', url: '/health/live' });
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(live.statusCode).toBe(200);
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({
      status: 'ok',
      checks: { postgres: 'ok', redis: 'ok' },
    });

    await app.close();
  });

  it('registers the datastore and context plugins', async () => {
    const app = buildApp(testConfig());

    // A fresh request carries the defaulted context, proving the context plugin
    // is wired into the shared host and not just the health routes. The probe
    // route must be added before `ready()` — routes cannot be registered once
    // the instance is listening.
    app.get('/ctx', (request) => ({ tenantId: request.ctx.tenantId }));
    await app.ready();

    expect(app.hasDecorator('pg')).toBe(true);
    expect(app.hasDecorator('redis')).toBe(true);

    const res = await app.inject({ method: 'GET', url: '/ctx' });
    expect(res.json()).toEqual({ tenantId: null });

    await app.close();
  });

  it('accepts an additional plugin without any bootstrap change', async () => {
    // The extensibility contract (Req 1.5): a later spec registers its own
    // plugin on the returned instance; buildApp itself never changes.
    const app = buildApp(testConfig());

    await app.register((instance, _opts, done) => {
      instance.get('/domain', () => ({ ok: true }));
      done();
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/domain' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    await app.close();
  });
});
