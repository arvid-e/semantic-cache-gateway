import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { contextPlugin } from './context-plugin.js';
import { createDefaultContext, type RequestContext } from './types.js';

/**
 * The defaults every fresh context must carry. Kept as one literal so a new
 * field added to {@link RequestContext} forces a decision here rather than
 * silently defaulting to `undefined`.
 */
const DEFAULTS: RequestContext = {
  tenantId: null,
  provider: null,
  model: null,
  params: {},
  cacheStatus: 'unknown',
  tokenUsage: { prompt: 0, completion: 0, total: 0 },
  latencyMs: null,
  failover: { attempted: false, from: null, to: null },
  breakerState: 'closed',
};

/**
 * Build an app with the context plugin and a route that echoes the `ctx` the
 * plugin attached, so a test can inspect what a real request would see.
 */
async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(contextPlugin);
  app.get('/ctx', (request) => request.ctx);
  await app.ready();
  return app;
}

describe('createDefaultContext', () => {
  it('fills every field with its defined default', () => {
    expect(createDefaultContext()).toEqual(DEFAULTS);
  });

  it('returns an independent object on each call', () => {
    const first = createDefaultContext();
    const second = createDefaultContext();

    // Nested objects must be fresh too, or one request's writes would leak.
    first.params.temperature = 0.7;
    first.tokenUsage.total = 42;
    first.failover.attempted = true;

    expect(second.params).toEqual({});
    expect(second.tokenUsage.total).toBe(0);
    expect(second.failover.attempted).toBe(false);
  });
});

describe('contextPlugin', () => {
  it('exposes a fully-defaulted ctx on every handled request', async () => {
    const app = await buildApp();

    const response = await app.inject({ method: 'GET', url: '/ctx' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(DEFAULTS);

    await app.close();
  });

  it('gives each request its own context, not a shared one', async () => {
    // A handler that mutates ctx must not affect the next request — the classic
    // failure mode of decorating with an object instead of assigning per hook.
    const app = Fastify({ logger: false });
    await app.register(contextPlugin);
    app.get('/mutate', (request) => {
      request.ctx.tenantId = 'tenant-a';
      request.ctx.tokenUsage.total = 99;
      return request.ctx;
    });
    app.get('/read', (request) => request.ctx);
    await app.ready();

    const mutated = await app.inject({ method: 'GET', url: '/mutate' });
    const fresh = await app.inject({ method: 'GET', url: '/read' });

    // The mutating request saw its writes...
    expect(mutated.json<RequestContext>().tenantId).toBe('tenant-a');
    // ...but the later request starts from clean defaults regardless.
    expect(fresh.json()).toEqual(DEFAULTS);

    await app.close();
  });
});
