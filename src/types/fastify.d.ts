import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import type { RequestContext } from '#src/platform/context/types.js';
import type { Config } from '#src/platform/config/schema.js';

/**
 * Every platform plugin that decorates Fastify declares its decoration here
 * rather than in its own file, so the full shape of `app` is readable in one
 * place.
 */
declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Attached fresh per request by the context plugin. Downstream specs add
     * fields by declaration-merging `RequestContext`, not by editing this file.
     */
    ctx: RequestContext;
  }

  interface FastifyInstance {
    /** Decorated by `buildApp` before any plugin registers. */
    readonly config: Config;

    /** Pooled Postgres client with `pgvector` types registered. */
    readonly pg: Pool;

    /** One `ioredis` connection multiplexes every command. */
    readonly redis: Redis;
  }
}
