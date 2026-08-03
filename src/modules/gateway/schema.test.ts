import Fastify, { type FastifyInstance } from 'fastify';
import { PROVIDER_NAMES } from '#src/modules/auth/types.js';
import type { NormalizedResponse } from './types.js';
import { completionsRouteSchema } from './schema.js';

/**
 * A valid normalized response for the stub handler to return, so the response
 * schema is exercised on the way out.
 */
const NORMALIZED: NormalizedResponse = {
  id: 'resp_1',
  provider: 'openai',
  model: 'gpt-4o-mini-2024-07-18',
  message: { role: 'assistant', content: 'Use an HNSW index.' },
  usage: { promptTokens: 12, completionTokens: 5, totalTokens: 17 },
  finishReason: 'stop',
};

/** A payload with every field populated and in range. */
function validBody(): Record<string, unknown> {
  return {
    provider: 'openai',
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'What is pgvector?' },
      { role: 'assistant', content: 'A Postgres extension for vectors.' },
      { role: 'user', content: 'And how do I index it?' },
    ],
    temperature: 0.2,
    maxTokens: 256,
    topP: 0.9,
    stop: ['\n\n'],
  };
}

/**
 * Mount the schema on a real route, because Fastify's Ajv — not a hand-rolled
 * check — is what enforces it in production. The spy stands in for the provider
 * call, so "rejected before any provider is called" is directly observable.
 */
function buildHarness(respondWith: unknown = NORMALIZED): {
  app: FastifyInstance;
  handler: ReturnType<typeof vi.fn>;
} {
  const handler = vi.fn((_body: unknown) => respondWith);
  const app = Fastify();

  app.post('/v1/chat/completions', { schema: completionsRouteSchema }, (req) =>
    handler(req.body),
  );

  return { app, handler };
}

describe('completions request schema', () => {
  it('accepts a fully populated payload and reaches the handler', async () => {
    const { app, handler } = buildHarness();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: validBody(),
    });

    expect(response.statusCode).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('accepts a minimal payload of provider, model, and one message', async () => {
    const { app, handler } = buildHarness();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        provider: 'ollama',
        model: 'llama3.1',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('accepts each of the three supported providers', async () => {
    for (const provider of PROVIDER_NAMES) {
      const { app, handler } = buildHarness();

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: {
          provider,
          model: 'some-model',
          messages: [{ role: 'user', content: 'hi' }],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(handler).toHaveBeenCalledTimes(1);
    }
  });

  describe('rejects before the handler runs', () => {
    /** Every case must produce a 4xx and leave the provider call unmade. */
    const cases: Record<string, Record<string, unknown>> = {
      'a missing messages array': (() => {
        const body = validBody();
        delete body.messages;
        return body;
      })(),
      'an empty messages array': { ...validBody(), messages: [] },
      'an unknown provider': { ...validBody(), provider: 'cohere' },
      'a missing provider': (() => {
        const body = validBody();
        delete body.provider;
        return body;
      })(),
      'a missing model': (() => {
        const body = validBody();
        delete body.model;
        return body;
      })(),
      'a blank model': { ...validBody(), model: '' },
      'an unknown message role': {
        ...validBody(),
        messages: [{ role: 'tool', content: 'hi' }],
      },
      'a message missing content': {
        ...validBody(),
        messages: [{ role: 'user' }],
      },
      'a temperature above the supported range': {
        ...validBody(),
        temperature: 2.5,
      },
      'a negative temperature': { ...validBody(), temperature: -0.1 },
      'a topP above 1': { ...validBody(), topP: 1.5 },
      'a zero maxTokens': { ...validBody(), maxTokens: 0 },
      'a fractional maxTokens': { ...validBody(), maxTokens: 10.5 },
      'too many stop sequences': {
        ...validBody(),
        stop: ['a', 'b', 'c', 'd', 'e'],
      },
      // v1 returns a single complete response. Asking for a stream
      // must fail loudly rather than quietly returning a non-streamed reply.
      'a request for streaming': { ...validBody(), stream: true },
    };

    for (const [name, payload] of Object.entries(cases)) {
      it(`rejects ${name}`, async () => {
        const { app, handler } = buildHarness();

        const response = await app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          payload,
        });

        expect(response.statusCode).toBe(400);
        expect(handler).not.toHaveBeenCalled();
      });
    }
  });

  describe('sanitizes fields outside the agnostic contract', () => {
    // Fastify compiles schemas with Ajv's `removeAdditional: true`, so an
    // undeclared field is stripped rather than rejected. The guarantee that
    // matters is the same either way: nothing outside the agnostic contract
    // reaches the handler, and so nothing can reach an adapter.
    it('strips unknown top-level fields before the handler', async () => {
      const { app, handler } = buildHarness();

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: { ...validBody(), seed: 42, logit_bias: { '50256': -100 } },
      });

      expect(response.statusCode).toBe(200);
      expect(handler).toHaveBeenCalledTimes(1);
      const received = handler.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(received).not.toHaveProperty('seed');
      expect(received).not.toHaveProperty('logit_bias');
      expect(received.provider).toBe('openai');
    });

    it('strips provider-specific fields from a message', async () => {
      const { app, handler } = buildHarness();

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: {
          ...validBody(),
          messages: [
            { role: 'user', content: 'hi', name: 'bob', function_call: {} },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      const received = handler.mock.calls[0]?.[0] as {
        messages: Record<string, unknown>[];
      };
      expect(received.messages[0]).toEqual({ role: 'user', content: 'hi' });
    });

    it('accepts an explicit non-streaming flag as a no-op', async () => {
      const { app, handler } = buildHarness();

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: { ...validBody(), stream: false },
      });

      expect(response.statusCode).toBe(200);
      expect(handler).toHaveBeenCalledTimes(1);
    });
  });

  it('identifies the invalid input in the client error', async () => {
    const { app } = buildHarness();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { ...validBody(), provider: 'cohere' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ message: string }>().message).toMatch(/provider/);
  });
});

describe('normalized response schema', () => {
  it('serializes the normalized contract', async () => {
    const { app } = buildHarness();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: validBody(),
    });

    expect(response.json()).toEqual(NORMALIZED);
  });

  it('strips provider-specific fields an adapter might leak', async () => {
    // Serialization against the response schema is the last line of defence for
    // Even a leaky adapter cannot widen the client contract.
    const { app } = buildHarness({
      ...NORMALIZED,
      system_fingerprint: 'fp_44709d6fcb',
      choices: [{ index: 0 }],
      message: {
        role: 'assistant',
        content: 'Use an HNSW index.',
        refusal: null,
      },
      usage: {
        promptTokens: 12,
        completionTokens: 5,
        totalTokens: 17,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: validBody(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(NORMALIZED);
    expect(response.body).not.toContain('system_fingerprint');
    expect(response.body).not.toContain('cached_tokens');
    expect(response.body).not.toContain('refusal');
  });
});
