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

/**
 * The one place the foundation's cross-cutting plugins are composed. Later specs
 * call `app.register(...)` with their own plugins on the returned instance and
 * never edit this file — the plugin host is the seam.
 *
 * Construction is synchronous: `register` only queues each plugin, and the
 * datastore plugins connect during `app.ready()`. Returning the not-yet-ready
 * instance keeps the ordering decision in the entrypoint, which awaits `ready()`
 * before `listen()` so the service never binds a port half-initialized.
 *
 * `authConfig` opts the auth module in. The production bootstrap always supplies
 * it; tests that exercise only the foundation omit it. Its own (separate)
 * validated config is loaded by the bootstrap, not from `app.config`.
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

  // Auth registers last, after `app.pg` and the request context it depends on;
  // its guard is scoped to the admin routes, so the health endpoints above stay
  // unauthenticated.
  if (authConfig !== undefined) {
    app.register(authPlugin, { authConfig });
  }

  return app;
}
