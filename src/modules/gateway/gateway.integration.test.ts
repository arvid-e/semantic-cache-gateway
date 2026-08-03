import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '#src/platform/config/load-config.js';
import { runMigrations } from '#src/platform/db/migrate.js';
import { buildApp } from '#src/app.js';
import type { AuthConfig } from '#src/modules/auth/config.js';
import type { NormalizedResponse } from './types.js';

// End-to-end completion flow against the real foundation app, dockerized
// Postgres/Redis, and a local stub standing in for the three provider APIs.
// Run with `docker compose up -d postgres redis` then `npm run test:integration`.
//
// All three providers are stubbed rather than dialing the Compose Ollama: that
// service is a bare `ollama/ollama` image with an empty volume — the project
// never pulls a *chat* model (Ollama is provisioned for `nomic-embed-text`
// embeddings, which `dual-layer-caching` uses). Routing, BYOK pass-through, and
// normalization are what this task proves, and a stub proves them
// deterministically.

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

const ADMIN_TOKEN = 'admin-token-integration-5678';
const OPENAI_KEY = 'sk-openai-stored-key';
const ANTHROPIC_KEY = 'sk-ant-stored-key';
const OLLAMA_KEY = 'ollama-stored-key';
const BYOK_KEY = 'sk-per-request-byok-key';

/** One recorded upstream call, so tests can assert what the adapter sent. */
interface StubCall {
  readonly path: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: Record<string, unknown>;
}

const calls: StubCall[] = [];

/**
 * Stands in for all three provider APIs on one port, mounted at a distinct
 * prefix each so the recorded path proves which adapter ran. A `model` of
 * `boom` makes the provider fail, for the error-mapping cases.
 */
function providerStub(): Server {
  return createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      const path = req.url ?? '';
      calls.push({ path, headers: req.headers, body });

      if (body.model === 'boom') {
        res.writeHead(500, { 'content-type': 'application/json' });
        // The body echoes the key, as a badly-behaved proxy would; the gateway
        // must not surface it.
        res.end(
          JSON.stringify({
            error: `upstream exploded for key ${String(req.headers.authorization ?? req.headers['x-api-key'])}`,
          }),
        );
        return;
      }

      res.writeHead(200, { 'content-type': 'application/json' });
      if (path.startsWith('/openai')) {
        res.end(
          JSON.stringify({
            id: 'chatcmpl-stub',
            model: 'gpt-4o-mini-2024-07-18',
            choices: [
              {
                message: { role: 'assistant', content: 'openai says hi' },
                finish_reason: 'stop',
              },
            ],
            usage: {
              prompt_tokens: 11,
              completion_tokens: 3,
              total_tokens: 14,
            },
            // Provider-specific; must not reach the client.
            system_fingerprint: 'fp_stub',
          }),
        );
        return;
      }
      if (path.startsWith('/anthropic')) {
        res.end(
          JSON.stringify({
            id: 'msg_stub',
            model: 'claude-sonnet-4-5-20250929',
            content: [{ type: 'text', text: 'anthropic says hi' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 7, output_tokens: 2 },
            // Provider-specific; must not reach the client.
            stop_sequence: null,
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          model: 'llama3',
          message: { role: 'assistant', content: 'ollama says hi' },
          done_reason: 'stop',
          prompt_eval_count: 5,
          eval_count: 4,
          // Provider-specific; must not reach the client.
          total_duration: 123456,
        }),
      );
    });
  });
}

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

const admin = { authorization: `Bearer ${ADMIN_TOKEN}` };

describe('gateway completion flow against dockerized Postgres + Redis', () => {
  let app: FastifyInstance;
  let stub: Server;
  let envBackup: Record<string, string | undefined>;
  /** Gateway key for the tenant that has all three credentials stored. */
  let stockedKey: string;
  /** Gateway key for a tenant with no provider credentials at all. */
  let baldKey: string;

  beforeAll(async () => {
    stub = providerStub();
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const { port } = stub.address() as AddressInfo;
    const base = `http://127.0.0.1:${String(port)}`;

    // Point every provider at the stub. `OLLAMA_URL` is the foundation's, which
    // the gateway config reuses rather than re-reading.
    envBackup = {
      OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
      OLLAMA_URL: process.env.OLLAMA_URL,
      LOG_LEVEL: process.env.LOG_LEVEL,
    };
    process.env.OPENAI_BASE_URL = `${base}/openai/v1`;
    process.env.ANTHROPIC_BASE_URL = `${base}/anthropic`;
    process.env.OLLAMA_URL = `${base}/ollama`;
    // ~30 request-lifecycle lines per run otherwise, which buries a failure.
    process.env.LOG_LEVEL = 'fatal';

    const config = loadConfig();
    await runMigrations(config, silent);
    app = buildApp(config, authConfig());
    await app.ready();

    stockedKey = await provisionTenant('Stocked', {
      openai: OPENAI_KEY,
      anthropic: ANTHROPIC_KEY,
      ollama: OLLAMA_KEY,
    });
    baldKey = await provisionTenant('Bald', {});
  });

  afterAll(async () => {
    await app.close();
    await new Promise<void>((resolve, reject) => {
      stub.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    for (const [key, value] of Object.entries(envBackup)) {
      // `process.env[key] = undefined` would store the string "undefined", so
      // an originally-absent var has to actually be removed.
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  });

  beforeEach(() => {
    calls.length = 0;
  });

  /** Create a tenant, issue its gateway key, and store the given credentials. */
  async function provisionTenant(
    name: string,
    credentials: Record<string, string>,
  ): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: '/admin/tenants',
      headers: admin,
      payload: { name },
    });
    const { id } = created.json<{ id: string }>();

    const issued = await app.inject({
      method: 'POST',
      url: `/admin/tenants/${id}/keys`,
      headers: admin,
    });

    for (const [provider, apiKey] of Object.entries(credentials)) {
      await app.inject({
        method: 'PUT',
        url: `/admin/tenants/${id}/credentials/${provider}`,
        headers: admin,
        payload: { apiKey },
      });
    }
    return issued.json<{ key: string }>().key;
  }

  function complete(
    key: string,
    body: Record<string, unknown>,
    extraHeaders: Record<string, string> = {},
  ) {
    return app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${key}`, ...extraHeaders },
      payload: {
        model: 'some-model',
        messages: [{ role: 'user', content: 'hello' }],
        ...body,
      },
    });
  }

  it.each([
    ['openai', '/openai/v1/chat/completions', 'gpt-4o-mini-2024-07-18', 14],
    ['anthropic', '/anthropic/v1/messages', 'claude-sonnet-4-5-20250929', 9],
    ['ollama', '/ollama/api/chat', 'llama3', 9],
  ])(
    'routes a %s request to its adapter and normalizes the reply',
    async (provider, path, resolvedModel, totalTokens) => {
      const res = await complete(stockedKey, { provider });

      expect(res.statusCode).toBe(200);
      const body = res.json<NormalizedResponse>();
      expect(body.provider).toBe(provider);
      // The model the provider reported, not the one requested.
      expect(body.model).toBe(resolvedModel);
      expect(body.usage.totalTokens).toBe(totalTokens);
      expect(body.finishReason).toBe('stop');
      expect(body.message.content).toContain(`${provider} says hi`);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.path).toBe(path);
    },
  );

  it('never leaks a provider-specific field into the normalized response', async () => {
    for (const provider of ['openai', 'anthropic', 'ollama'] as const) {
      const res = await complete(stockedKey, { provider });
      const body = res.json<Record<string, unknown>>();

      expect(Object.keys(body).sort()).toEqual([
        'finishReason',
        'id',
        'message',
        'model',
        'provider',
        'usage',
      ]);
    }
  });

  describe('BYOK', () => {
    it("sends the tenant's stored credential when no header is supplied", async () => {
      await complete(stockedKey, { provider: 'openai' });

      expect(calls[0]?.headers.authorization).toBe(`Bearer ${OPENAI_KEY}`);
    });

    it('sends each provider its own credential in that provider’s scheme', async () => {
      await complete(stockedKey, { provider: 'anthropic' });
      expect(calls[0]?.headers['x-api-key']).toBe(ANTHROPIC_KEY);
      expect(calls[0]?.headers['anthropic-version']).toBe('2023-06-01');

      calls.length = 0;
      await complete(stockedKey, { provider: 'ollama' });
      expect(calls[0]?.headers.authorization).toBe(`Bearer ${OLLAMA_KEY}`);
    });

    it('prefers a per-request key over the stored one, without persisting it', async () => {
      await complete(
        stockedKey,
        { provider: 'openai' },
        { 'x-provider-key': BYOK_KEY },
      );
      expect(calls[0]?.headers.authorization).toBe(`Bearer ${BYOK_KEY}`);

      // The stored credential is untouched: a follow-up with no header still
      // uses it, so the per-request key was never written to storage.
      calls.length = 0;
      await complete(stockedKey, { provider: 'openai' });
      expect(calls[0]?.headers.authorization).toBe(`Bearer ${OPENAI_KEY}`);
    });

    it('serves a tenant that has only a per-request key and nothing stored', async () => {
      const res = await complete(
        baldKey,
        { provider: 'openai' },
        { 'x-provider-key': BYOK_KEY },
      );

      expect(res.statusCode).toBe(200);
      expect(calls[0]?.headers.authorization).toBe(`Bearer ${BYOK_KEY}`);
    });
  });

  describe('rejections that never reach a provider', () => {
    it('rejects an unauthenticated request', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: { provider: 'openai', model: 'm', messages: [] },
      });

      expect(res.statusCode).toBe(401);
      expect(calls).toHaveLength(0);
    });

    it('rejects an unsupported provider at the boundary', async () => {
      const res = await complete(stockedKey, { provider: 'cohere' });

      expect(res.statusCode).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it('rejects an invalid payload', async () => {
      const res = await complete(stockedKey, {
        provider: 'openai',
        messages: [],
      });

      expect(res.statusCode).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it('rejects when the tenant has no credential for the provider', async () => {
      const res = await complete(baldKey, { provider: 'openai' });

      expect(res.statusCode).toBe(400);
      expect(res.json<{ error: string }>().error).toMatch(/credential/i);
      expect(calls).toHaveLength(0);
    });
  });

  it('maps an upstream failure to a 502 carrying no credential', async () => {
    const res = await complete(stockedKey, {
      provider: 'openai',
      model: 'boom',
    });

    expect(res.statusCode).toBe(502);
    expect(calls).toHaveLength(1);
    // The stub echoed the key in its error body; none of it may survive.
    expect(res.body).not.toContain(OPENAI_KEY);
    expect(res.body).not.toContain('upstream exploded');
  });

  it('keeps the health endpoints unauthenticated alongside the gateway route', async () => {
    const live = await app.inject({ method: 'GET', url: '/health/live' });
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(live.statusCode).toBe(200);
    expect(ready.statusCode).toBe(200);
  });
});
