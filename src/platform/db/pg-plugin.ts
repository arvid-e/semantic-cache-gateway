import fp from 'fastify-plugin';
import { Client, Pool } from 'pg';
import { registerTypes } from 'pgvector/pg';
import type { ClientBase, PoolConfig } from 'pg';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config/schema.js';

/** Options accepted by {@link pgPlugin}. */
export interface PgPluginOptions {
  readonly config: Config;
}

/**
 * Thrown when the database cannot back the gateway: either Postgres is
 * unreachable or the `vector` extension is absent. Both abort startup — the
 * message names which of the two failed and never echoes the connection URL,
 * whose credentials are sensitive (Req 2.3, 4.2, 4.3).
 */
export class PostgresPluginError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PostgresPluginError';
  }
}

/** Presence check for the extension the semantic cache depends on. */
const VECTOR_EXTENSION_QUERY =
  "SELECT 1 FROM pg_extension WHERE extname = 'vector'";

/**
 * Preflight the database on a single throwaway connection before the pool is
 * built, so the two startup failures stay distinguishable.
 *
 * The check runs on its own `Client` rather than a pooled one because the pool
 * registers vector types on every connection, and that registration fails with
 * its own low-level message when the extension is missing — which would mask
 * the actionable error below.
 */
async function assertDatabaseReady(connectionString: string): Promise<void> {
  const client = new Client({ connectionString });

  try {
    await client.connect();
  } catch (cause) {
    // pg reports the host/user but never the password, so the message is safe
    // to surface; the original error rides along as `cause` for debugging.
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new PostgresPluginError(`PostgreSQL unreachable: ${detail}`, {
      cause,
    });
  }

  try {
    const { rowCount } = await client.query(VECTOR_EXTENSION_QUERY);

    if (rowCount === 0) {
      throw new PostgresPluginError(
        "PostgreSQL is missing the required 'vector' extension (pgvector). " +
          'Run migrations before starting the service.',
      );
    }
  } finally {
    await client.end();
  }
}

/**
 * Establish the shared Postgres client and expose it as `app.pg`.
 *
 * Registration is the startup gate: an unreachable database or a missing
 * `vector` extension rejects here, and Fastify aborts the boot rather than
 * serving traffic against a database that cannot answer (Req 4.1–4.3).
 *
 * Ordering note: the extension check assumes migrations have already run — the
 * baseline migration is what issues `CREATE EXTENSION`. The entrypoint runs
 * migrate before serve, so this holds in every deployed path.
 */
async function postgresPlugin(
  app: FastifyInstance,
  { config }: PgPluginOptions,
): Promise<void> {
  await assertDatabaseReady(config.postgres.url);

  const poolConfig: PoolConfig = {
    connectionString: config.postgres.url,
    max: config.postgres.poolMax,
    // `pg` keeps type parsers per client, so registering once on a startup
    // connection would leave every other pooled connection returning vectors
    // as raw strings. This hook runs for each new physical connection.
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- pg-pool awaits this hook and discards the connection if it rejects; the synchronous signature in @types/pg is inaccurate.
    onConnect: (client: ClientBase) => registerTypes(client),
  };

  const pool = new Pool(poolConfig);

  app.decorate('pg', pool);
  app.addHook('onClose', async () => {
    await pool.end();
  });
}

/**
 * Wrapped with `fastify-plugin` so `app.pg` escapes this plugin's encapsulation
 * context and is visible to sibling plugins (health, and later domain modules).
 */
export const pgPlugin = fp(postgresPlugin, { name: 'platform-postgres' });
