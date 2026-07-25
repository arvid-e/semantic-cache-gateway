import type { FastifyInstance } from 'fastify';

/** Health of a single backing dependency as reported by readiness. */
type CheckStatus = 'ok' | 'unavailable';

/** Body returned by `GET /health/ready`. */
interface ReadinessBody {
  readonly status: CheckStatus;
  readonly checks: {
    readonly postgres: CheckStatus;
    readonly redis: CheckStatus;
  };
}

/**
 * HTTP status for a readiness failure. `503 Service Unavailable` is what an
 * orchestrator's probe expects while a dependency is down — it marks the
 * instance not-ready without treating it as a client (4xx) or crashed (500)
 * error (Req 6.3).
 */
const READINESS_FAILURE_STATUS = 503;

/**
 * Register the unauthenticated liveness and readiness endpoints.
 *
 * - `GET /health/live` reports only that the HTTP server is accepting requests;
 *   it never touches a datastore, so it stays green during a dependency outage
 *   and an orchestrator won't kill a pod that is merely waiting on Postgres or
 *   Redis (Req 6.1).
 * - `GET /health/ready` probes both datastores and succeeds only when both
 *   answer; on failure it returns 503 and names the unhealthy dependency in the
 *   body. The probe round-trips a real command (`SELECT 1` / `PING`) rather than
 *   inspecting client state, so it reflects live reachability (Req 6.2, 6.3).
 *
 * The two probes run concurrently and independently: one dependency being down
 * never masks the status of the other, so the body always reports both.
 *
 * The response carries only dependency names and coarse statuses — never the
 * underlying error, whose message can include host/port connection details. The
 * full cause is logged server-side instead (Req 6.3).
 *
 * Neither route installs an auth hook. They must stay reachable without
 * credentials even after a later spec adds authentication; that spec is
 * responsible for exempting the `/health/*` prefix rather than this plugin
 * opting into auth it then has to escape (Req 6.4).
 *
 * Not wrapped with `fastify-plugin`: unlike the datastore and context plugins,
 * this one only registers routes and decorates nothing, so it has no need to
 * escape its own encapsulation. The `app.pg` / `app.redis` decorations it reads
 * are hoisted to the root by their own plugins and are visible here regardless.
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

/**
 * Run one dependency probe, translating success/failure into a {@link
 * CheckStatus}. A rejection is logged with its cause for debugging but never
 * surfaced to the caller, keeping connection details out of the HTTP response.
 */
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
