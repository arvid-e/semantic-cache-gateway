import Fastify, { type FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { contextPlugin } from '#src/platform/context/context-plugin.js';
import type { Config } from '#src/platform/config/schema.js';
import { ProviderSecret } from '#src/modules/auth/types.js';
import type { CredentialResolver } from '#src/modules/auth/services/credential-resolver.js';
import type { AuthenticateHook } from '#src/modules/auth/middleware/authenticate.js';
import type {
  CompletionInput,
  CompletionService,
} from './completion-service.js';
import type { NormalizedResponse } from './types.js';
import { gatewayPlugin } from './index.js';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';

const foundationConfig: Config = {
  httpPort: 3000,
  logLevel: 'warn',
  postgres: { url: 'postgres://user:secret@localhost:5432/db', poolMax: 10 },
  redis: { url: 'redis://localhost:6379' },
  ollama: { url: 'http://localhost:11434' },
  nodeEnv: 'test',
};

const validBody = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'hello' }],
};

function response(content: string): NormalizedResponse {
  return {
    id: 'cmpl-1',
    provider: 'openai',
    model: 'gpt-4o-mini',
    message: { role: 'assistant', content },
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    finishReason: 'stop',
  };
}

/**
 * Stands in for the auth plugin: the gateway only needs its two decorations, so
 * faking them keeps this about *assembly* rather than re-proving auth.
 */
const fakeAuthPlugin = fp(
  (app: FastifyInstance, _opts: unknown, done: () => void) => {
    const resolver: CredentialResolver = {
      resolveCredential: vi.fn(() =>
        Promise.resolve({
          kind: 'resolved' as const,
          secret: new ProviderSecret('sk-test'),
          source: 'stored' as const,
        }),
      ),
    };
    const authenticate: AuthenticateHook = async (request, reply) => {
      if (request.headers.authorization === undefined) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
      request.ctx.tenantId = TENANT_ID;
      return undefined;
    };
    app.decorate('credentialResolver', resolver);
    app.decorate('authenticate', authenticate);
    done();
  },
  { name: 'auth' },
);

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorate('config', foundationConfig);
  await app.register(contextPlugin);
  await app.register(fakeAuthPlugin);
  await app.register(gatewayPlugin, {});
  await app.ready();
  return app;
}

function post(app: FastifyInstance, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers,
    payload: validBody,
  });
}

describe('gatewayPlugin', () => {
  it('exposes the raw completion service for downstream wrapping', async () => {
    const app = await buildApp();

    expect(app.hasDecorator('completionService')).toBe(true);
    expect(typeof app.completionService.complete).toBe('function');

    await app.close();
  });

  it('mounts the completions endpoint behind authentication', async () => {
    const app = await buildApp();

    const unauthenticated = await post(app);
    expect(unauthenticated.statusCode).toBe(401);

    await app.close();
  });

  it('refuses to register before auth', async () => {
    const app = Fastify();
    app.decorate('config', foundationConfig);
    await app.register(contextPlugin);
    // No auth plugin: `dependencies: ['auth']` should make this a boot failure
    // rather than a missing-decoration crash on the first request.
    app.register(gatewayPlugin, {});

    await expect(app.ready()).rejects.toThrow(/auth/);
    await app.close();
  });

  describe('composition seam', () => {
    it('routes through a wrapper installed with useCompletionService', async () => {
      const app = await buildApp();

      // What dual-layer-caching does from src/app.ts: wrap the raw service and
      // install the result as the outermost, without touching gateway code.
      const inner = app.completionService;
      // The spy is held separately rather than read back off the object, which
      // would trip the unbound-method rule.
      const complete = vi.fn((_input: CompletionInput) =>
        Promise.resolve(response('from the wrapper')),
      );
      const wrapper: CompletionService = { complete };
      app.useCompletionService(wrapper);

      const res = await post(app, { authorization: 'Bearer scg_test' });

      expect(res.statusCode).toBe(200);
      expect(res.json<NormalizedResponse>().message.content).toBe(
        'from the wrapper',
      );
      expect(complete).toHaveBeenCalledTimes(1);
      // The raw service stays the innermost implementation, so a wrapper can
      // still delegate to it.
      expect(app.completionService).toBe(inner);

      await app.close();
    });

    it('resolves the service per request, not at registration', async () => {
      const app = await buildApp();

      const first: CompletionService = {
        complete: vi.fn(() => Promise.resolve(response('first'))),
      };
      const second: CompletionService = {
        complete: vi.fn(() => Promise.resolve(response('second'))),
      };

      app.useCompletionService(first);
      const a = await post(app, { authorization: 'Bearer scg_test' });
      app.useCompletionService(second);
      const b = await post(app, { authorization: 'Bearer scg_test' });

      expect(a.json<NormalizedResponse>().message.content).toBe('first');
      expect(b.json<NormalizedResponse>().message.content).toBe('second');

      await app.close();
    });
  });

  it('accepts an injected config instead of reading the environment', async () => {
    const app = Fastify();
    app.decorate('config', foundationConfig);
    await app.register(contextPlugin);
    await app.register(fakeAuthPlugin);
    await app.register(gatewayPlugin, {
      gatewayConfig: {
        requestTimeoutMs: 1234,
        defaultMaxTokens: 99,
        providers: {
          openai: { baseUrl: 'http://stub/openai' },
          anthropic: {
            baseUrl: 'http://stub/anthropic',
            version: '2023-06-01',
          },
          ollama: { baseUrl: 'http://stub/ollama' },
        },
      },
    });
    await app.ready();

    expect(app.hasDecorator('completionService')).toBe(true);

    await app.close();
  });
});
