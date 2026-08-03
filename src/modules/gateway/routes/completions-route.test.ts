import Fastify, {
  type FastifyInstance,
  type LightMyRequestResponse,
} from 'fastify';
import { contextPlugin } from '#src/platform/context/context-plugin.js';
import { MissingCredentialError } from '#src/modules/auth/types.js';
import type { AuthenticateHook } from '#src/modules/auth/middleware/authenticate.js';
import {
  CredentialResolutionError,
  type CompletionInput,
  type CompletionService,
} from '../completion-service.js';
import { UnsupportedProviderError } from '../providers/provider-registry.js';
import { ProviderError, type NormalizedResponse } from '../types.js';
import { createCompletionsRoutes } from './completions-route.js';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const PROVIDER_KEY = 'sk-tenant-byok-secret-value';

const validBody = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  messages: [{ role: 'user', content: 'hello' }],
};

const normalized: NormalizedResponse = {
  id: 'cmpl-1',
  provider: 'openai',
  model: 'gpt-4o-mini-2024-07-18',
  message: { role: 'assistant', content: 'hi' },
  usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 },
  finishReason: 'stop',
};

/**
 * The route under test only needs authentication to have *happened*, so the
 * hook is faked rather than the whole auth stack stood up: it binds the tenant
 * the way the real one does, or rejects.
 */
function fakeAuthenticate(authenticated = true): AuthenticateHook {
  return async (request, reply) => {
    if (!authenticated) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    request.ctx.tenantId = TENANT_ID;
    return undefined;
  };
}

function fakeDeps(
  complete = vi.fn((_input: CompletionInput) => Promise.resolve(normalized)),
  authenticated = true,
) {
  const completionService: CompletionService = { complete };
  return {
    completionService,
    authenticate: fakeAuthenticate(authenticated),
    complete,
  };
}

async function buildApp(
  deps = fakeDeps(),
): Promise<{ app: FastifyInstance } & ReturnType<typeof fakeDeps>> {
  const app = Fastify();
  await app.register(contextPlugin);
  await app.register(
    createCompletionsRoutes({
      completionService: deps.completionService,
      authenticate: deps.authenticate,
    }),
  );
  await app.ready();
  return { app, ...deps };
}

async function post(
  app: FastifyInstance,
  payload: Record<string, unknown>,
  headers: Record<string, string | string[]> = {},
): Promise<LightMyRequestResponse> {
  return await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers,
    payload,
  });
}

describe('completions route', () => {
  it('returns the normalized response for an authenticated valid request', async () => {
    const { app, complete } = await buildApp();
    const res = await post(app, validBody);

    expect(res.statusCode).toBe(200);
    expect(res.json<NormalizedResponse>()).toEqual(normalized);
    expect(complete).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('rejects an unauthenticated request without calling the service', async () => {
    const { app, complete } = await buildApp(fakeDeps(undefined, false));
    const res = await post(app, validBody);

    expect(res.statusCode).toBe(401);
    expect(complete).not.toHaveBeenCalled();
    await app.close();
  });

  it('hands the tenant and the full conversation to the service', async () => {
    const { app, complete } = await buildApp();
    await post(app, {
      ...validBody,
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hello' },
      ],
    });

    const input = complete.mock.calls[0]?.[0];
    expect(input?.tenantId).toBe(TENANT_ID);
    expect(input?.request.messages).toHaveLength(2);
    await app.close();
  });

  describe('BYOK header', () => {
    it('passes a per-request provider key through to the service', async () => {
      const { app, complete } = await buildApp();
      await post(app, validBody, { 'x-provider-key': PROVIDER_KEY });

      expect(complete.mock.calls[0]?.[0].perRequestKey).toBe(PROVIDER_KEY);
      await app.close();
    });

    it('omits the property entirely when the header is absent', async () => {
      const { app, complete } = await buildApp();
      await post(app, validBody);

      // Absent, not an explicit `undefined`: the resolver's "was a BYOK key
      // supplied?" test reads the property.
      expect(complete.mock.calls[0]?.[0]).not.toHaveProperty('perRequestKey');
      await app.close();
    });

    it('treats a blank header as absent rather than as an empty key', async () => {
      const { app, complete } = await buildApp();
      await post(app, validBody, { 'x-provider-key': '   ' });

      expect(complete.mock.calls[0]?.[0]).not.toHaveProperty('perRequestKey');
      await app.close();
    });

    it('rejects a duplicated header instead of guessing which key was meant', async () => {
      const { app, complete } = await buildApp();
      // Node joins repeated headers into one comma-separated value, so this is
      // what a client sending the header twice actually produces.
      const res = await post(app, validBody, {
        'x-provider-key': [PROVIDER_KEY, 'sk-other'],
      });

      expect(res.statusCode).toBe(400);
      expect(complete).not.toHaveBeenCalled();
      await app.close();
    });
  });

  describe('payload validation', () => {
    it.each([
      ['no messages', { provider: 'openai', model: 'gpt-4o-mini' }],
      ['an empty conversation', { ...validBody, messages: [] }],
      ['an unknown provider', { ...validBody, provider: 'cohere' }],
      ['a streaming request', { ...validBody, stream: true }],
      ['an out-of-range temperature', { ...validBody, temperature: 5 }],
    ])('rejects %s before any provider call', async (_label, payload) => {
      const { app, complete } = await buildApp();
      const res = await post(app, payload);

      expect(res.statusCode).toBe(400);
      expect(complete).not.toHaveBeenCalled();
      await app.close();
    });
  });

  describe('error mapping', () => {
    it.each([
      ['an unsupported provider', new UnsupportedProviderError('cohere'), 400],
      ['a missing credential', new MissingCredentialError('openai'), 400],
      [
        'an undecryptable stored credential',
        new CredentialResolutionError('openai'),
        500,
      ],
      [
        'an upstream provider failure',
        new ProviderError('boom', {
          provider: 'openai',
          kind: 'upstream_error',
        }),
        502,
      ],
      [
        'an invalid provider response',
        new ProviderError('boom', {
          provider: 'openai',
          kind: 'invalid_response',
        }),
        502,
      ],
      [
        'a provider timeout',
        new ProviderError('boom', { provider: 'openai', kind: 'timeout' }),
        504,
      ],
    ])('maps %s to %i', async (_label, error, status) => {
      const complete = vi.fn(() => Promise.reject(error));
      const { app } = await buildApp(fakeDeps(complete));
      const res = await post(app, validBody);

      expect(res.statusCode).toBe(status);
      await app.close();
    });

    it('lets an unrecognized error fall through to Fastify as a 500', async () => {
      const complete = vi.fn(() => Promise.reject(new Error('unexpected')));
      const { app } = await buildApp(fakeDeps(complete));
      const res = await post(app, validBody);

      expect(res.statusCode).toBe(500);
      await app.close();
    });

    it('keeps the credential out of a provider-failure body', async () => {
      // The cause deliberately carries the secret, as a leaky SDK error would.
      const leaky = new ProviderError('upstream rejected the request', {
        provider: 'openai',
        kind: 'upstream_error',
        status: 401,
        cause: new Error(`invalid api key: ${PROVIDER_KEY}`),
      });
      const complete = vi.fn(() => Promise.reject(leaky));
      const { app } = await buildApp(fakeDeps(complete));
      const res = await post(app, validBody, {
        'x-provider-key': PROVIDER_KEY,
      });

      expect(res.statusCode).toBe(502);
      expect(res.body).not.toContain(PROVIDER_KEY);
      expect(res.body).not.toContain('invalid api key');
      await app.close();
    });
  });

  it('strips a provider-specific field a leaky adapter returned', async () => {
    const leaky = {
      ...normalized,
      system_fingerprint: 'fp_44709d6fcb',
    } as NormalizedResponse;
    const complete = vi.fn(() => Promise.resolve(leaky));
    const { app } = await buildApp(fakeDeps(complete));
    const res = await post(app, validBody);

    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty('system_fingerprint');
    await app.close();
  });
});
