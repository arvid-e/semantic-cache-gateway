import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { Config } from '#src/platform/config/schema.js';
import { buildLoggerOptions } from '#src/platform/logger/logger-options.js';
import { pgPlugin } from '#src/platform/db/pg-plugin.js';
import { redisPlugin } from '#src/platform/redis/redis-plugin.js';
import { contextPlugin } from '#src/platform/context/context-plugin.js';
import { healthPlugin } from '#src/platform/health/health-plugin.js';

/**
 * Assemble the shared Fastify host from validated config.
 *
 * This is the one place the foundation's cross-cutting plugins are composed. It
 * wires exactly the two datastores' clients (Postgres, Redis), the shared
 * request context, and the health endpoints onto a single app instance; it
 * registers no domain routes of its own. Later specs call `app.register(...)`
 * with their own plugins on the returned instance and never edit this file — the
 * plugin host is the seam, so the bootstrap stays closed for modification while
 * open for extension (Req 1.5).
 *
 * Construction is synchronous: `register` only queues each plugin, and the
 * datastore plugins connect during `app.ready()`. The entrypoint awaits
 * `ready()` before `listen()`, so an unreachable Postgres or Redis rejects there
 * and the service never binds a port half-initialized (Req 1.2, 1.3). Returning
 * the not-yet-ready instance keeps that ordering decision in the entrypoint
 * rather than duplicating it here.
 *
 * `app.config` is decorated straight from the passed object so downstream
 * modules read settings through the shared instance instead of `process.env`
 * (Req 8.4). The logger is built from the same config, so its level and
 * redaction policy are consistent everywhere (Req 3.1, 3.3); Fastify's built-in
 * request/response logging then emits a structured line per request lifecycle
 * with method, route, status code, and latency (Req 3.4).
 */
export function buildApp(config: Config): FastifyInstance {
  const app = Fastify({ logger: buildLoggerOptions(config) });

  // Expose the validated config on the shared instance before any plugin
  // registers, so a plugin that reads `app.config` sees it regardless of order.
  app.decorate('config', config);

  // Datastore clients first: the health plugin reads `app.pg` / `app.redis`, and
  // both are hoisted to the root by `fastify-plugin` so they are visible to
  // every sibling plugin registered here or later.
  app.register(pgPlugin, { config });
  app.register(redisPlugin, { config });

  // Request context and health round out the foundation. Neither carries
  // domain logic — context defines the per-request shape, health serves the
  // liveness/readiness probes.
  app.register(contextPlugin);
  app.register(healthPlugin);

  return app;
}
