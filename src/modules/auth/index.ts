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
 * Auth module: composes the layered auth stack onto the foundation app and
 * exposes the seams downstream specs consume (Req 6.1, 6.3).
 *
 * Wiring order mirrors the module's layers: auth config → crypto → repositories
 * (over `app.pg`) → services → resolver, then the middleware and admin routes.
 * Two seams are decorated onto the app (and hoisted to the root by
 * `fastify-plugin`) for later specs:
 *
 * - `app.credentialResolver` — the BYOK resolver `gateway-provider-routing`
 *   calls to obtain a provider key for a request.
 * - `app.authenticate` — the gateway API-key hook a protected route applies.
 *
 * The admin routes are registered through their own (encapsulated) plugin, so
 * the admin-token guard is scoped to `/admin/*` and never touches the
 * foundation's health endpoints, which stay unauthenticated.
 *
 * Secret-safety: no secret is decorated onto the request context or logged. The
 * pepper and keyring live only inside the crypto instances; resolved provider
 * secrets are wrapped in `ProviderSecret`; and the shared logger's redaction
 * policy covers the auth secret field shapes (authorization, apiKey,
 * credentials, encryption material).
 */

// This module owns these decorations; declare them here rather than in the
// foundation's fastify.d.ts, so the augmentation ships with the code that adds
// the decoration.
declare module 'fastify' {
  interface FastifyInstance {
    /** BYOK credential-resolution seam consumed by gateway-provider-routing. */
    readonly credentialResolver: CredentialResolver;
    /** Gateway API-key authentication hook for protected downstream routes. */
    readonly authenticate: AuthenticateHook;
  }
}

/** Options for {@link authPlugin}: the validated auth config to wire over. */
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

  // Expose the downstream seams.
  app.decorate('credentialResolver', credentialResolver);
  app.decorate('authenticate', createAuthenticateHook(apiKeyService));

  // Admin provisioning API — encapsulated so its guard covers only /admin/*.
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
 * The auth module as a `fastify-plugin`, so its decorations escape the plugin's
 * encapsulation and are visible to sibling and downstream plugins. Register it
 * after the Postgres plugin so `app.pg` is available when the repositories are
 * built.
 */
export const authPlugin = fp(authModule, { name: 'auth' });
