import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { createAdminGuard } from '../middleware/admin-guard.js';
import type { ApiKeyService } from '../services/api-key-service.js';
import type { CredentialService } from '../services/credential-service.js';
import type { TenantService } from '../services/tenant-service.js';
import { isProviderName } from '../types.js';

/**
 * Admin / provisioning API (Req 5.1, 5.2, 5.3, 5.4, 5.5, 6.4).
 *
 * A minimal, admin-authorized surface for operators to create tenants, issue or
 * revoke gateway keys, and attach/rotate/remove provider credentials. Every
 * route in this plugin is guarded by the admin token, and the plugin is
 * *encapsulated* (not `fastify-plugin`), so the guard hook applies only to these
 * routes — the foundation's health endpoints and the gateway's own routes are
 * unaffected.
 *
 * The issue-key response is the single place a plaintext gateway key ever
 * appears, exactly once at issuance (Req 5.2, 6.4); no route returns a stored
 * provider credential or previously issued key (Req 5.5).
 */
export interface AdminRoutesDeps {
  readonly tenantService: TenantService;
  readonly apiKeyService: ApiKeyService;
  readonly credentialService: CredentialService;
  /** `AuthConfig.adminToken` for the authorization guard. */
  readonly adminToken: string;
}

/** JSON-schema pattern matching a canonical UUID, so a malformed path param is
 * rejected with 400 before it reaches a `uuid`-typed query. */
const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

const tenantParams = {
  type: 'object',
  required: ['tenantId'],
  additionalProperties: false,
  properties: { tenantId: { type: 'string', pattern: UUID_PATTERN } },
} as const;

const keyParams = {
  type: 'object',
  required: ['tenantId', 'keyId'],
  additionalProperties: false,
  properties: {
    tenantId: { type: 'string', pattern: UUID_PATTERN },
    keyId: { type: 'string', pattern: UUID_PATTERN },
  },
} as const;

// `provider` is validated in the handler (via `isProviderName`) rather than by a
// schema enum, so an unknown provider becomes a 422/404 (per contract) instead
// of a generic 400.
const credentialParams = {
  type: 'object',
  required: ['tenantId', 'provider'],
  additionalProperties: false,
  properties: {
    tenantId: { type: 'string', pattern: UUID_PATTERN },
    provider: { type: 'string', minLength: 1 },
  },
} as const;

/**
 * Build the admin-routes plugin bound to its service dependencies.
 *
 * @param deps - Services and the admin token this surface operates over.
 */
export function createAdminRoutes(deps: AdminRoutesDeps): FastifyPluginAsync {
  return function adminRoutes(app: FastifyInstance): Promise<void> {
    // Authorize every route registered in this encapsulated plugin.
    app.addHook('onRequest', createAdminGuard(deps.adminToken));

    // Create a tenant (Req 5.1).
    app.post<{ Body: { name: string } }>(
      '/admin/tenants',
      {
        schema: {
          body: {
            type: 'object',
            required: ['name'],
            additionalProperties: false,
            properties: { name: { type: 'string', minLength: 1 } },
          },
        },
      },
      async (request, reply) => {
        const tenant = await deps.tenantService.createTenant(request.body.name);
        return reply.code(201).send({ id: tenant.id, name: tenant.name });
      },
    );

    // Issue a gateway key; the plaintext is returned once, here only (Req 5.2).
    app.post<{ Params: { tenantId: string } }>(
      '/admin/tenants/:tenantId/keys',
      { schema: { params: tenantParams } },
      async (request, reply) => {
        const { tenantId } = request.params;
        if ((await deps.tenantService.getTenant(tenantId)) === null) {
          return reply.code(404).send({ error: 'Tenant not found' });
        }
        const issued = await deps.apiKeyService.issueKey(tenantId);
        return reply.code(201).send({
          id: issued.id,
          key: issued.plaintext,
          prefix: issued.prefix,
        });
      },
    );

    // Revoke a gateway key (Req 5.2).
    app.delete<{ Params: { tenantId: string; keyId: string } }>(
      '/admin/tenants/:tenantId/keys/:keyId',
      { schema: { params: keyParams } },
      async (request, reply) => {
        const { tenantId, keyId } = request.params;
        const revoked = await deps.apiKeyService.revoke(tenantId, keyId);
        if (!revoked) return reply.code(404).send({ error: 'Key not found' });
        return reply.code(204).send();
      },
    );

    // Attach or rotate a provider credential (Req 5.3). The response carries no
    // secret material — only the provider and when it took effect (Req 5.5).
    app.put<{
      Params: { tenantId: string; provider: string };
      Body: { apiKey: string };
    }>(
      '/admin/tenants/:tenantId/credentials/:provider',
      {
        schema: {
          params: credentialParams,
          body: {
            type: 'object',
            required: ['apiKey'],
            additionalProperties: false,
            properties: { apiKey: { type: 'string', minLength: 1 } },
          },
        },
      },
      async (request, reply) => {
        const { tenantId, provider } = request.params;
        if (!isProviderName(provider)) {
          return reply.code(422).send({ error: 'Unknown provider' });
        }
        if ((await deps.tenantService.getTenant(tenantId)) === null) {
          return reply.code(404).send({ error: 'Tenant not found' });
        }
        await deps.credentialService.attachOrRotate(
          tenantId,
          provider,
          request.body.apiKey,
        );
        return reply
          .code(200)
          .send({ provider, updatedAt: new Date().toISOString() });
      },
    );

    // Remove a provider credential (Req 5.3). Idempotent: a missing credential
    // under an existing tenant still succeeds with 204.
    app.delete<{ Params: { tenantId: string; provider: string } }>(
      '/admin/tenants/:tenantId/credentials/:provider',
      { schema: { params: credentialParams } },
      async (request, reply) => {
        const { tenantId, provider } = request.params;
        if (!isProviderName(provider)) {
          return reply.code(404).send({ error: 'Credential not found' });
        }
        if ((await deps.tenantService.getTenant(tenantId)) === null) {
          return reply.code(404).send({ error: 'Tenant not found' });
        }
        await deps.credentialService.remove(tenantId, provider);
        return reply.code(204).send();
      },
    );

    return Promise.resolve();
  };
}
