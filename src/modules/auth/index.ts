import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import type { AuthConfig } from './config.js';
import { DefaultEnvelopeEncryption } from './crypto/envelope-encryption.js';
import { DefaultKeyHashUtil } from './crypto/key-hash.js';
import {
  createAuthenticateHook,
  type AuthenticateHook,
} from './middleware/authenticate.js';
import { DefaultApiKeyRepository } from './repositories/api-key-repository.js';
import { DefaultCredentialRepository } from './repositories/credential-repository.js';
import { DefaultTenantRepository } from './repositories/tenant-repository.js';
import { DefaultApiKeyService } from './services/api-key-service.js';
import { DefaultCredentialService } from './services/credential-service.js';
import {
  DefaultCredentialResolver,
  type CredentialResolver,
} from './services/credential-resolver.js';
import { DefaultTenantService } from './services/tenant-service.js';
import { createAdminRoutes } from './routes/admin-routes.js';

/**
 * Composes the layered auth stack onto the foundation app and exposes two seams
 * downstream specs consume: `app.credentialResolver` (the BYOK resolver
 * `gateway-provider-routing` calls) and `app.authenticate` (the gateway API-key
 * hook a protected route applies).
 *
 * The admin routes are registered through their own encapsulated plugin, so the
 * admin-token guard is scoped to `/admin/*` and never touches the foundation's
 * health endpoints.
 */

// This module owns these decorations; declared here rather than in the
// foundation's fastify.d.ts, so the augmentation ships with the code that adds
// the decoration.
declare module 'fastify' {
  interface FastifyInstance {
    readonly credentialResolver: CredentialResolver;
    readonly authenticate: AuthenticateHook;
  }
}

export interface AuthPluginOptions {
  readonly authConfig: AuthConfig;
}

async function authModule(
  app: FastifyInstance,
  { authConfig }: AuthPluginOptions,
): Promise<void> {
  // crypto — bound to the configured pepper and keyring.
  const keyHash = new DefaultKeyHashUtil(authConfig.gatewayKeyPepper);
  const envelope = new DefaultEnvelopeEncryption(authConfig.encryption);

  // repositories — over the shared Postgres pool decorated by the pg plugin.
  const tenants = new DefaultTenantRepository(app.pg);
  const apiKeys = new DefaultApiKeyRepository(app.pg);
  const credentials = new DefaultCredentialRepository(app.pg);

  // services and the BYOK resolver.
  const tenantService = new DefaultTenantService(tenants);
  const apiKeyService = new DefaultApiKeyService(keyHash, apiKeys);
  const credentialService = new DefaultCredentialService(envelope, credentials);
  const credentialResolver = new DefaultCredentialResolver(credentialService);

  app.decorate('credentialResolver', credentialResolver);
  app.decorate('authenticate', createAuthenticateHook(apiKeyService));

  // Encapsulated so its guard covers only /admin/*.
  await app.register(
    createAdminRoutes({
      tenantService,
      apiKeyService,
      credentialService,
      adminToken: authConfig.adminToken,
    }),
  );
}

/**
 * `fastify-plugin` so the decorations are visible to sibling and downstream
 * plugins. Register after the Postgres plugin, so `app.pg` is available when the
 * repositories are built.
 */
export const authPlugin = fp(authModule, { name: 'auth' });
