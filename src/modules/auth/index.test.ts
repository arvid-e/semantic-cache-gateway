import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { pino, type Logger } from 'pino';
import { buildLoggerOptions } from '#src/platform/logger/logger-options.js';
import type { Config } from '#src/platform/config/schema.js';
import type { AuthConfig } from './config.js';
import { authPlugin } from './index.js';

/** A valid auth config built directly (no env), for wiring the plugin. */
function testAuthConfig(): AuthConfig {
  return {
    encryption: {
      activeKeyVersion: 1,
      keyring: new Map([[1, randomBytes(32)]]),
    },
    gatewayKeyPepper: randomBytes(32),
    adminToken: 'admin-token-abcdefghij',
  };
}

/** A pg stub whose `query` returns no rows — enough to wire, never real I/O. */
function fakePg() {
  return { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
}

/** App with only a fake `pg` decoration and the auth plugin registered. */
async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.decorate('pg', fakePg() as never);
  await app.register(authPlugin, { authConfig: testAuthConfig() });
  await app.ready();
  return app;
}

describe('authPlugin wiring', () => {
  it('exposes the credential resolver seam, wired through to the repository', async () => {
    const app = await buildApp();

    expect(app.hasDecorator('credentialResolver')).toBe(true);
    // A full resolve reaches the (stubbed) repository and returns a typed miss,
    // proving the resolver → service → repo → pg chain is connected.
    const resolution = await app.credentialResolver.resolveCredential({
      tenantId: '11111111-1111-1111-1111-111111111111',
      provider: 'openai',
    });
    expect(resolution.kind).toBe('missing');
    await app.close();
  });

  it('exposes the authenticate hook seam', async () => {
    const app = await buildApp();
    expect(app.hasDecorator('authenticate')).toBe(true);
    expect(typeof app.authenticate).toBe('function');
    await app.close();
  });

  it('mounts the admin API behind the admin-token guard', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/admin/tenants',
      payload: { name: 'Acme' },
    });
    // No admin token → rejected by the guard before the handler.
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

// Confirms the shared logger redacts the auth secret field shapes (Req 6.1).
function captureLogger(): { logger: Logger; lines: string[] } {
  const config: Config = {
    httpPort: 3000,
    logLevel: 'trace',
    postgres: { url: 'postgres://x', poolMax: 10 },
    redis: { url: 'redis://x' },
    ollama: { url: 'http://x' },
    nodeEnv: 'test',
  };
  const lines: string[] = [];
  const logger = pino(buildLoggerOptions(config), {
    write: (chunk: string) => lines.push(chunk),
  });
  return { logger, lines };
}

describe('shared logger redaction of auth secret fields', () => {
  it('masks gateway keys, provider credentials, and encryption material', () => {
    const { logger, lines } = captureLogger();
    const secret = 'sk-should-never-appear';

    logger.info(
      {
        req: { headers: { authorization: `Bearer ${secret}` } },
        apiKey: secret,
        credential: secret,
        credentials: secret,
        encryptionKey: secret,
      },
      'auth event',
    );

    expect(lines).toHaveLength(1);
    const line = lines[0] ?? '';
    expect(line).not.toContain(secret);
    expect(line).toContain('[Redacted]');
  });
});
