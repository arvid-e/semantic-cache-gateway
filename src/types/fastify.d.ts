import type { Pool } from 'pg';
import type { Redis } from 'ioredis';

/**
 * Central module augmentation for the shared app instance. Every platform
 * plugin that decorates Fastify declares its decoration here rather than in its
 * own file, so the full shape of `app` is readable in one place (design.md
 * `src/types/fastify.d.ts`).
 *
 * `app.config` and `request.ctx` land here when their plugins are implemented.
 */
declare module 'fastify' {
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
