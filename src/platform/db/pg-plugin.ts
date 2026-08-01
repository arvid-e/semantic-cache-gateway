import fp from 'fastify-plugin';
import { Client, Pool } from 'pg';
import { registerTypes } from 'pgvector/pg';
import type { ClientBase, PoolConfig } from 'pg';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config/schema.js';

export interface PgPluginOptions {
  readonly config: Config;
}

/**
 * Postgres is unreachable, or the `vector` extension is absent. Both abort
 * startup; the message names which of the two failed and never echoes the
 * connection URL.
 */
export class PostgresPluginError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PostgresPluginError';
  }
}

const VECTOR_EXTENSION_QUERY =
  "SELECT 1 FROM pg_extension WHERE extname = 'vector'";

/**
 * Runs on its own throwaway `Client` rather than a pooled one, because the pool
 * registers vector types on every connection and that registration fails with
 * its own low-level message when the extension is missing — masking the
 * actionable error below.
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
 * Registration is the startup gate: an unreachable database or a missing
 * `vector` extension rejects here, and Fastify aborts the boot rather than
 * serving traffic against a database that cannot answer.
 *
 * The extension check assumes migrations have already run — the baseline
 * migration is what issues `CREATE EXTENSION`. The entrypoint runs migrate
 * before serve, so this holds in every deployed path.
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

/** `fastify-plugin` so `app.pg` is visible to sibling plugins. */
export const pgPlugin = fp(postgresPlugin, { name: 'platform-postgres' });
