import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Config } from '#src/platform/config/schema.js';
import { buildLoggerOptions } from '#src/platform/logger/logger-options.js';
import { pgPlugin } from '#src/platform/db/pg-plugin.js';
import { redisPlugin } from '#src/platform/redis/redis-plugin.js';
import { contextPlugin } from '#src/platform/context/context-plugin.js';
import { healthPlugin } from '#src/platform/health/health-plugin.js';
import { authPlugin } from '#src/modules/auth/index.js';
import type { AuthConfig } from '#src/modules/auth/config.js';
import { gatewayPlugin } from '#src/modules/gateway/index.js';

/**
 * Where the plugins are composed, and the composition point for the completion
 * flow: the gateway exposes `app.useCompletionService`, through which later
 * specs install their wrappers here, innermost-last —
 *
 *     route -> CachedCompletionService -> ResilientCompletionService -> CompletionService
 *
 * Construction is synchronous: `register` only queues each plugin, and the
 * datastore plugins connect during `app.ready()`. Returning the not-yet-ready
 * instance keeps that ordering decision in the entrypoint, which awaits
 * `ready()` before `listen()` so the service never binds a port
 * half-initialized.
 *
 * `authConfig` opts the domain modules in — tests that exercise only the
 * foundation omit it.
 */
export function buildApp(
  config: Config,
  authConfig?: AuthConfig,
): FastifyInstance {
  const app = Fastify({ logger: buildLoggerOptions(config) });

  // Before any plugin registers, so a plugin that reads `app.config` sees it
  // regardless of order.
  app.decorate('config', config);

  // Datastore clients first: the health plugin reads `app.pg` / `app.redis`, and
  // both are hoisted to the root by `fastify-plugin` so they are visible to
  // every sibling plugin registered here or later.
  app.register(pgPlugin, { config });
  app.register(redisPlugin, { config });

  app.register(contextPlugin);
  app.register(healthPlugin);

  // Auth first — it needs `app.pg` and the request context — then the gateway,
  // which reads auth's `credentialResolver` and `authenticate`. Both scope their
  // guards to their own routes, so health stays unauthenticated.
  if (authConfig !== undefined) {
    app.register(authPlugin, { authConfig });
    app.register(gatewayPlugin, {});
  }

  return app;
}
