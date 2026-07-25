import fp from 'fastify-plugin';
import { Redis } from 'ioredis';
import type { RedisOptions } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config/schema.js';

/** Options accepted by {@link redisPlugin}. */
export interface RedisPluginOptions {
  readonly config: Config;
}

/**
 * Thrown when Redis cannot back the gateway at startup. The message names Redis
 * and never echoes the connection URL, whose credentials are sensitive
 * (Req 2.3, 4.2).
 */
export class RedisPluginError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RedisPluginError';
  }
}

/**
 * Reconnect attempts allowed before startup gives up. Bounded so an unreachable
 * Redis rejects registration instead of retrying forever.
 */
const STARTUP_CONNECT_ATTEMPTS = 3;

/** Backoff between reconnect attempts, capped so a long outage stays quiet. */
const RECONNECT_DELAY_MS = 200;
const RECONNECT_DELAY_CAP_MS = 2000;

/**
 * Establish the shared Redis client and expose it as `app.redis`.
 *
 * Registration is the startup gate: an unreachable Redis rejects here and
 * Fastify aborts the boot (Req 1.3, 4.1, 4.2, 4.4).
 *
 * Unlike Postgres, a single `ioredis` connection multiplexes every command, so
 * there is no pool to size and no per-connection setup — the whole plugin is
 * connect, verify, decorate, quit.
 */
async function redisClientPlugin(
  app: FastifyInstance,
  { config }: RedisPluginOptions,
): Promise<void> {
  // `ioredis` retries forever by default, which would turn an unreachable Redis
  // into a hung boot rather than a failed one. Bound the attempts until the
  // client is up, then hand back the indefinite policy so a transient blip
  // reconnects instead of taking a running gateway down.
  let connected = false;

  const options: RedisOptions = {
    retryStrategy: (attempt: number): number | null => {
      if (!connected && attempt > STARTUP_CONNECT_ATTEMPTS) return null;
      return Math.min(attempt * RECONNECT_DELAY_MS, RECONNECT_DELAY_CAP_MS);
    },
  };

  const client = new Redis(config.redis.url, options);

  client.once('ready', () => {
    connected = true;
  });

  // `ioredis` emits connection failures as `error` events. Without a listener
  // Node treats them as unhandled and crashes the process, so this must be
  // attached before the first command — including the ping below, whose own
  // rejection is what actually reports the failure.
  client.on('error', (err: Error) => {
    app.log.error({ err }, 'redis client error');
  });

  try {
    // Round-trips a real command, so this covers auth and readiness rather than
    // just the socket opening.
    await client.ping();
  } catch (cause) {
    client.disconnect();
    // ioredis reports the host/port but never the password, so the message is
    // safe to surface; the original error rides along as `cause` for debugging.
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new RedisPluginError(`Redis unreachable: ${detail}`, { cause });
  }

  app.decorate('redis', client);
  app.addHook('onClose', async () => {
    try {
      await client.quit();
    } catch {
      // `quit()` rejects if the client is already closed or mid-reconnect;
      // force the socket down so shutdown still completes.
      client.disconnect();
    }
  });
}

/**
 * Wrapped with `fastify-plugin` so `app.redis` escapes this plugin's
 * encapsulation context and is visible to sibling plugins (health, and later
 * domain modules).
 */
export const redisPlugin = fp(redisClientPlugin, { name: 'platform-redis' });
