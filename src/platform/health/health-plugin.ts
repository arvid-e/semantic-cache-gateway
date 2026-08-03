import type { FastifyInstance } from 'fastify';

type CheckStatus = 'ok' | 'unavailable';

interface ReadinessBody {
  readonly status: CheckStatus;
  readonly checks: {
    readonly postgres: CheckStatus;
    readonly redis: CheckStatus;
  };
}

/**
 * `503 Service Unavailable` is what an orchestrator's probe expects while a
 * dependency is down — it marks the instance not-ready without treating it as a
 * client (4xx) or crashed (500) error.
 */
const READINESS_FAILURE_STATUS = 503;

/**
 * The unauthenticated liveness and readiness endpoints.
 *
 * `/health/live` never touches a datastore, so it stays green during a
 * dependency outage and an orchestrator won't kill a pod that is merely waiting
 * on Postgres or Redis. `/health/ready` round-trips a real command
 * (`SELECT 1` / `PING`) rather than inspecting client state, so it reflects live
 * reachability. The two probes run concurrently and independently, so one
 * dependency being down never masks the other's status.
 *
 * The response carries only dependency names and coarse statuses — never the
 * underlying error, whose message can include host/port connection details.
 *
 * Neither route installs an auth hook: they must stay reachable without
 * credentials, and exempting `/health/*` is the auth spec's job rather than this
 * plugin opting into auth it then has to escape.
 *
 * Not wrapped with `fastify-plugin` — this plugin only registers routes and
 * decorates nothing, so it has no encapsulation to escape. The `app.pg` /
 * `app.redis` decorations it reads are hoisted to the root by their own plugins.
 */
export function healthPlugin(
  app: FastifyInstance,
  _opts: unknown,
  done: (err?: Error) => void,
): void {
  // Synchronous, returns a literal: liveness must not depend on a datastore.
  app.get('/health/live', () => ({ status: 'ok' as const }));

  app.get('/health/ready', async (_request, reply): Promise<ReadinessBody> => {
    const [postgres, redis] = await Promise.all([
      probe(app, 'postgres', () => app.pg.query('SELECT 1')),
      probe(app, 'redis', () => app.redis.ping()),
    ]);

    const healthy = postgres === 'ok' && redis === 'ok';
    if (!healthy) reply.code(READINESS_FAILURE_STATUS);

    return {
      status: healthy ? 'ok' : 'unavailable',
      checks: { postgres, redis },
    };
  });

  done();
}

/** A rejection is logged with its cause but never surfaced to the caller. */
async function probe(
  app: FastifyInstance,
  dependency: 'postgres' | 'redis',
  check: () => Promise<unknown>,
): Promise<CheckStatus> {
  try {
    await check();
    return 'ok';
  } catch (err) {
    app.log.error({ err, dependency }, 'readiness check failed');
    return 'unavailable';
  }
}
