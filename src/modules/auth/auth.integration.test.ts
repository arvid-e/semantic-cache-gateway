import { randomBytes } from 'node:crypto';
import Fastify, {
  type FastifyInstance,
  type LightMyRequestResponse,
} from 'fastify';
import { loadConfig } from '#src/platform/config/load-config.js';
import { runMigrations } from '#src/platform/db/migrate.js';
import { contextPlugin } from '#src/platform/context/context-plugin.js';
import { buildApp } from '#src/app.js';
import type { AuthConfig } from './config.js';

// End-to-end auth suite against dockerized Postgres (task 6.1). Drives the real
// admin HTTP API and the exposed `authenticate` / `credentialResolver` seams,
// and reads rows directly to prove encryption-at-rest and secret non-exposure.
// Run with `docker compose up -d postgres redis` then `npm run test:integration`.

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

const ADMIN_TOKEN = 'admin-token-e2e-1234567890';
const ACTIVE_KEY_VERSION = 1;

function authConfig(): AuthConfig {
  return {
    encryption: {
      activeKeyVersion: ACTIVE_KEY_VERSION,
      keyring: new Map([[ACTIVE_KEY_VERSION, randomBytes(32)]]),
    },
    gatewayKeyPepper: randomBytes(32),
    adminToken: ADMIN_TOKEN,
  };
}

let app: FastifyInstance;

const admin = { authorization: `Bearer ${ADMIN_TOKEN}` };

async function createTenant(name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/admin/tenants',
    headers: admin,
    payload: { name },
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string }>().id;
}

async function issueKey(
  tenantId: string,
): Promise<{ id: string; key: string }> {
  const res = await app.inject({
    method: 'POST',
    url: `/admin/tenants/${tenantId}/keys`,
    headers: admin,
  });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: string; key: string }>();
}

function attachCredential(
  tenantId: string,
  provider: string,
  apiKey: string,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'PUT',
    url: `/admin/tenants/${tenantId}/credentials/${provider}`,
    headers: admin,
    payload: { apiKey },
  });
}

/** Authenticate a presented key through the real `app.authenticate` hook,
 * mounted on a throwaway app so the gateway route seam is exercised. */
async function authenticateKey(
  key: string | undefined,
): Promise<LightMyRequestResponse> {
  const probe = Fastify();
  await probe.register(contextPlugin);
  probe.get('/protected', { preHandler: app.authenticate }, (request) => ({
    tenantId: request.ctx.tenantId,
  }));
  await probe.ready();
  const res = await probe.inject({
    method: 'GET',
    url: '/protected',
    headers: key === undefined ? {} : { authorization: `Bearer ${key}` },
  });
  await probe.close();
  return res;
}

beforeAll(async () => {
  const config = loadConfig();
  await runMigrations(config, silent);
  app = buildApp(config, authConfig());
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await app.pg.query('TRUNCATE tenants CASCADE');
});

describe('auth end-to-end', () => {
  it('provisions a tenant, authenticates its key, and rejects unknown keys', async () => {
    const tenantId = await createTenant('Acme');
    const { key } = await issueKey(tenantId);

    // A valid key resolves to its owning tenant in the request context.
    const ok = await authenticateKey(key);
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ tenantId: string }>().tenantId).toBe(tenantId);

    // Unknown and missing keys are rejected before downstream processing.
    expect((await authenticateKey('scg_not-real')).statusCode).toBe(401);
    expect((await authenticateKey(undefined)).statusCode).toBe(401);

    // Storage holds only the keyed hash — never the plaintext key.
    const { rows } = await app.pg.query<{ key_hash: Buffer }>(
      'SELECT key_hash FROM gateway_api_keys WHERE tenant_id = $1',
      [tenantId],
    );
    expect(rows[0]?.key_hash.toString('latin1')).not.toContain(key);
  });

  it('encrypts credentials at rest and resolves, rotates, and removes them', async () => {
    const tenantId = await createTenant('CredCo');
    const secret = 'sk-openai-live-value';

    const attach = await attachCredential(tenantId, 'openai', secret);
    expect(attach.statusCode).toBe(200);
    expect(attach.body).not.toContain(secret); // response leaks no secret

    // Resolves from decrypted storage back to the original secret.
    const resolved = await app.credentialResolver.resolveCredential({
      tenantId,
      provider: 'openai',
    });
    if (resolved.kind !== 'resolved') expect.fail('expected resolved');
    expect(resolved.source).toBe('stored');
    expect(resolved.secret.reveal()).toBe(secret);

    // At rest: ciphertext only, tagged with the active key version, no plaintext.
    const stored = await app.pg.query<{
      ciphertext: Buffer;
      key_version: number;
    }>(
      `SELECT ciphertext, key_version FROM provider_credentials
       WHERE tenant_id = $1 AND provider = $2`,
      [tenantId, 'openai'],
    );
    expect(stored.rows[0]?.key_version).toBe(ACTIVE_KEY_VERSION);
    expect(stored.rows[0]?.ciphertext.toString('latin1')).not.toContain(secret);

    // Rotate in place.
    await attachCredential(tenantId, 'openai', 'sk-openai-rotated');
    const rotated = await app.credentialResolver.resolveCredential({
      tenantId,
      provider: 'openai',
    });
    if (rotated.kind !== 'resolved') expect.fail('expected resolved');
    expect(rotated.secret.reveal()).toBe('sk-openai-rotated');

    // Remove.
    const del = await app.inject({
      method: 'DELETE',
      url: `/admin/tenants/${tenantId}/credentials/openai`,
      headers: admin,
    });
    expect(del.statusCode).toBe(204);
    const gone = await app.credentialResolver.resolveCredential({
      tenantId,
      provider: 'openai',
    });
    expect(gone.kind).toBe('missing');
  });

  it('supports multiple providers per tenant and isolates tenants', async () => {
    const a = await createTenant('TenantA');
    const b = await createTenant('TenantB');

    await attachCredential(a, 'openai', 'A-openai');
    await attachCredential(a, 'anthropic', 'A-anthropic');
    await attachCredential(b, 'openai', 'B-openai');

    // One tenant, two providers.
    const aOpenai = await app.credentialResolver.resolveCredential({
      tenantId: a,
      provider: 'openai',
    });
    const aAnthropic = await app.credentialResolver.resolveCredential({
      tenantId: a,
      provider: 'anthropic',
    });
    if (aOpenai.kind !== 'resolved' || aAnthropic.kind !== 'resolved') {
      expect.fail('expected both providers resolved for tenant A');
    }
    expect(aOpenai.secret.reveal()).toBe('A-openai');
    expect(aAnthropic.secret.reveal()).toBe('A-anthropic');

    // Isolation: B sees its own credential, never A's; a provider B lacks misses.
    const bOpenai = await app.credentialResolver.resolveCredential({
      tenantId: b,
      provider: 'openai',
    });
    if (bOpenai.kind !== 'resolved') expect.fail('expected resolved for B');
    expect(bOpenai.secret.reveal()).toBe('B-openai');
    expect(
      (
        await app.credentialResolver.resolveCredential({
          tenantId: b,
          provider: 'anthropic',
        })
      ).kind,
    ).toBe('missing');

    // Each tenant's key authenticates only to its own tenant.
    const keyA = (await issueKey(a)).key;
    const keyB = (await issueKey(b)).key;
    expect(
      (await authenticateKey(keyA)).json<{ tenantId: string }>().tenantId,
    ).toBe(a);
    expect(
      (await authenticateKey(keyB)).json<{ tenantId: string }>().tenantId,
    ).toBe(b);
  });

  it('never exposes stored secret material in responses or persisted rows', async () => {
    const tenantId = await createTenant('SecretCo');
    const providerSecret = 'sk-provider-must-not-leak';

    // The issued key plaintext appears exactly once, in the issue response.
    const issued = await issueKey(tenantId);
    await attachCredential(tenantId, 'openai', providerSecret);

    // Revoking returns no body/secret.
    const revoke = await app.inject({
      method: 'DELETE',
      url: `/admin/tenants/${tenantId}/keys/${issued.id}`,
      headers: admin,
    });
    expect(revoke.statusCode).toBe(204);
    expect(revoke.body).toBe('');

    // No persisted row contains either plaintext secret. `key_hash` is a hash,
    // `ciphertext` is encrypted; `key_prefix` is a non-secret fragment only.
    const keys = await app.pg.query<{ key_hash: Buffer; key_prefix: string }>(
      'SELECT key_hash, key_prefix FROM gateway_api_keys',
    );
    const creds = await app.pg.query<{ ciphertext: Buffer }>(
      'SELECT ciphertext FROM provider_credentials',
    );
    const persisted = [
      ...keys.rows.map((r) => r.key_hash.toString('latin1') + r.key_prefix),
      ...creds.rows.map((r) => r.ciphertext.toString('latin1')),
    ].join(' ');

    expect(persisted).not.toContain(issued.key);
    expect(persisted).not.toContain(providerSecret);
  });
});
