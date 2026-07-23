import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import type { RequestContext } from '#src/platform/context/types.js';

/**
 * Central module augmentation for the shared app instance. Every platform
 * plugin that decorates Fastify declares its decoration here rather than in its
 * own file, so the full shape of `app` is readable in one place (design.md
 * `src/types/fastify.d.ts`).
 *
 * `app.config` lands here when its plugin is implemented.
 */
declare module 'fastify' {
  interface FastifyRequest {
    /**
     * Shared request-scoped context, attached fresh per request by the context
     * plugin and mutated in place by pipeline stages. Never `undefined` once the
     * plugin's `onRequest` hook has run (Req 7.4, 7.5). Downstream specs add
     * fields by declaration-merging `RequestContext`, not by editing this file.
     */
    ctx: RequestContext;
  }

  interface FastifyInstance {
    /**
     * Shared pooled Postgres client with `pgvector` types registered. Created
     * once at startup; domain modules query through this rather than opening
     * their own connections (Req 4.4).
     */
    readonly pg: Pool;

    /**
     * Shared `ioredis` client. One connection multiplexes every command, so
     * domain modules reuse this rather than constructing their own (Req 4.4).
     */
    readonly redis: Redis;
  }
}
